import { readFileSync } from 'fs';
import { join } from 'path';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import queueConfig from '../src/config/queue.config';
import storageConfig from '../src/config/storage.config';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from '../src/queue/queue.constants';
import { S3_INTERNAL_CLIENT } from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { bodyOf } from '../src/test/body-of';
import { cleanQueues } from '../src/test/clean-queue';
import { cleanStorage } from '../src/test/clean-storage';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import type {
  CreateVideoResponseDto,
  PartUrlsResponseDto,
} from '../src/videos/dto/upload-responses.dto';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/video-status.enum';
import { WorkerModule } from '../src/worker/worker.module';

const FIXTURES = join(__dirname, 'fixtures');

// The API and the real worker (same code the video-worker container runs, with
// real ffprobe/ffmpeg) share one process here, against the isolated test
// resources: database streamtube_test, bucket and queue prefix streamtube-test.
describe('Video processing pipeline (e2e)', () => {
  let app: INestApplication<App>;
  let workerModule: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let queue: Queue;
  let s3: S3Client;
  let queueCfg: ConfigType<typeof queueConfig>;
  let storageCfg: ConfigType<typeof storageConfig>;
  let throttlerStorage: ThrottlerStorageService;
  let token: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  /** Uploads bytes through the real API + storage flow and completes the upload. */
  const upload = async (bytes: Buffer, contentType: string) => {
    const created = await bodyOf<CreateVideoResponseDto>(
      request(app.getHttpServer())
        .post('/videos')
        .set(auth())
        .send({ filename: 'sample', contentType, sizeBytes: bytes.length })
        .expect(201),
    );
    const urls = await bodyOf<PartUrlsResponseDto>(
      request(app.getHttpServer())
        .post(`/videos/${created.publicId}/upload/part-urls`)
        .set(auth())
        .send({ partNumbers: [1] })
        .expect(200),
    );
    const put = await fetch(urls.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(bytes),
    });
    expect(put.status).toBe(200);
    await request(app.getHttpServer())
      .post(`/videos/${created.publicId}/upload/complete`)
      .set(auth())
      .send({ parts: [{ partNumber: 1, etag: put.headers.get('etag') }] })
      .expect(202);
    return created.publicId;
  };

  const waitForFinalStatus = async (publicId: string): Promise<Video> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: publicId });
      if (
        row.status === VideoStatus.READY ||
        row.status === VideoStatus.ERROR
      ) {
        return row;
      }
      if (Date.now() > deadline) {
        throw new Error(`Video ${publicId} still ${row.status} after 60 s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  const clean = async () => {
    await cleanAllTables(dataSource);
    await cleanQueues(
      [VIDEO_PROCESSING_QUEUE, VIDEO_MAINTENANCE_QUEUE],
      { host: queueCfg.host, port: queueCfg.port },
      queueCfg.prefix,
    );
    await cleanStorage(s3, storageCfg.bucket, 'videos/');
    await cleanStorage(s3, storageCfg.bucket, 'thumbnails/');
  };

  beforeAll(async () => {
    const apiModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = apiModule.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    workerModule = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await workerModule.init();

    dataSource = apiModule.get(DataSource);
    storage = apiModule.get(StorageService, { strict: false });
    queue = apiModule.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE), {
      strict: false,
    });
    s3 = apiModule.get<S3Client>(S3_INTERNAL_CLIENT, { strict: false });
    queueCfg = apiModule.get<ConfigType<typeof queueConfig>>(queueConfig.KEY, {
      strict: false,
    });
    storageCfg = apiModule.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
      { strict: false },
    );
    throttlerStorage = apiModule.get<ThrottlerStorageService>(ThrottlerStorage);
    const jwtService = apiModule.get(JwtService, { strict: false });

    await clean();
    const user = await dataSource.getRepository(User).save({
      email: 'pipeline@test.dev',
      password: 'hash',
      is_confirmed: true,
    });
    await dataSource
      .getRepository(Channel)
      .save({ name: 'Pipeline', nickname: 'pipeline', user_id: user.id });
    token = jwtService.sign({ sub: user.id, email: user.email });
  });

  beforeEach(() => {
    throttlerStorage.storage.clear();
  });

  afterAll(async () => {
    await clean();
    await workerModule.close();
    await app.close();
  });

  it.each([
    ['sample.mp4', 'video/mp4'],
    ['sample.webm', 'video/webm'],
    ['sample.mov', 'video/quicktime'],
  ])(
    'should take %s from upload to ready with duration, metadata and a JPEG thumbnail',
    async (file, contentType) => {
      const publicId = await upload(
        readFileSync(join(FIXTURES, file)),
        contentType,
      );

      const row = await waitForFinalStatus(publicId);

      expect(row.status).toBe(VideoStatus.READY);
      expect(row.duration_seconds).toBeCloseTo(2, 0);
      expect(row.metadata).toMatchObject({
        width: 320,
        height: 240,
      });
      expect(row.metadata?.container).toEqual(expect.any(String));
      expect(row.metadata?.videoCodec).toEqual(expect.any(String));
      expect(row.thumbnail_key).toBe(`thumbnails/${row.id}/default.jpg`);

      const thumbnail = await fetch(
        await storage.presignGetObject(row.thumbnail_key as string),
      );
      const bytes = Buffer.from(await thumbnail.arrayBuffer());
      expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    },
    90_000,
  );

  it('should end a text file declared as video/mp4 in error NOT_A_VIDEO without using all attempts', async () => {
    const publicId = await upload(
      Buffer.from('this is definitely not a video\n'.repeat(50)),
      'video/mp4',
    );

    const row = await waitForFinalStatus(publicId);

    expect(row.status).toBe(VideoStatus.ERROR);
    expect(row.failure_reason).toBe('NOT_A_VIDEO');
    const job = await queue.getJob(row.id);
    expect(job?.attemptsMade).toBeLessThan(3);
  }, 90_000);
});
