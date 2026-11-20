import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { S3Client, UploadPartCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
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
import { User } from '../src/users/entities/user.entity';
import type {
  CreateVideoResponseDto,
  PartUrlsResponseDto,
  UploadCompletedResponseDto,
} from '../src/videos/dto/upload-responses.dto';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/video-status.enum';
import { bodyOf, errorBodyOf } from '../src/test/body-of';
import { cleanQueues } from '../src/test/clean-queue';
import { cleanStorage } from '../src/test/clean-storage';
import { cleanAllTables } from '../src/test/create-test-data-source';

const MIB = 1024 * 1024;
const PART_SIZE = 5 * MIB; // VIDEO_PART_SIZE_BYTES forced by test/set-test-env.ts

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;
  let queueCfg: ConfigType<typeof queueConfig>;
  let storageCfg: ConfigType<typeof storageConfig>;
  let s3: S3Client;
  let token: string;
  let otherToken: string;

  const createUser = async (email: string, nickname: string) => {
    const user = await dataSource
      .getRepository(User)
      .save({ email, password: 'hash', is_confirmed: true });
    await dataSource
      .getRepository(Channel)
      .save({ name: nickname, nickname, user_id: user.id });
    return jwtService.sign({ sub: user.id, email });
  };

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const createVideo = (sizeBytes: number, t = token) =>
    request(app.getHttpServer())
      .post('/videos')
      .set(auth(t))
      .send({ filename: 'clip.mp4', contentType: 'video/mp4', sizeBytes });

  const requestPartUrls = (
    publicId: string,
    partNumbers: number[],
    t = token,
  ) =>
    request(app.getHttpServer())
      .post(`/videos/${publicId}/upload/part-urls`)
      .set(auth(t))
      .send({ partNumbers });

  const completeUpload = (
    publicId: string,
    parts: { partNumber: number; etag: string }[],
    t = token,
  ) =>
    request(app.getHttpServer())
      .post(`/videos/${publicId}/upload/complete`)
      .set(auth(t))
      .send({ parts });

  const createDraft = (sizeBytes: number, t = token) =>
    bodyOf<CreateVideoResponseDto>(createVideo(sizeBytes, t));

  /** Uploads the given part sizes straight to storage and returns their ETags. */
  const uploadParts = async (publicId: string, sizes: number[]) => {
    const numbers = sizes.map((_, i) => i + 1);
    const body = await bodyOf<PartUrlsResponseDto>(
      requestPartUrls(publicId, numbers).expect(200),
    );
    const parts: { partNumber: number; etag: string }[] = [];
    for (const [i, size] of sizes.entries()) {
      const response = await fetch(body.parts[i].url, {
        method: 'PUT',
        body: Buffer.alloc(size, 3),
      });
      expect(response.status).toBe(200);
      parts.push({
        partNumber: i + 1,
        etag: response.headers.get('etag') as string,
      });
    }
    return parts;
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
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

    dataSource = moduleFixture.get(DataSource);
    jwtService = moduleFixture.get(JwtService, { strict: false });
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE), {
      strict: false,
    });
    queueCfg = moduleFixture.get<ConfigType<typeof queueConfig>>(
      queueConfig.KEY,
      { strict: false },
    );
    storageCfg = moduleFixture.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
      { strict: false },
    );
    s3 = moduleFixture.get<S3Client>(S3_INTERNAL_CLIENT, { strict: false });
  });

  const clean = async () => {
    await cleanAllTables(dataSource);
    await cleanQueues(
      [VIDEO_PROCESSING_QUEUE, VIDEO_MAINTENANCE_QUEUE],
      { host: queueCfg.host, port: queueCfg.port },
      queueCfg.prefix,
    );
    await cleanStorage(s3, storageCfg.bucket, 'videos/');
  };

  beforeEach(async () => {
    await clean();
    throttlerStorage.storage.clear();
    token = await createUser('owner@test.dev', 'owner');
    otherToken = await createUser('other@test.dev', 'other');
  });

  afterAll(async () => {
    await clean();
    await app.close();
  });

  describe('POST /videos', () => {
    it('should create a draft in the caller channel and return the upload plan', async () => {
      const body = await bodyOf<CreateVideoResponseDto>(
        createVideo(PART_SIZE + 1024).expect(201),
      );

      expect(body.publicId).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(body).toMatchObject({
        status: 'draft',
        partSizeBytes: PART_SIZE,
        partCount: 2,
      });
      const row = await dataSource.getRepository(Video).findOneOrFail({
        where: { public_id: body.publicId },
        relations: ['channel', 'channel.user'],
      });
      expect(row.title).toBeNull();
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(row.channel.user.email).toBe('owner@test.dev');
    });

    it('should answer 429 TOO_MANY_OPEN_UPLOADS when the channel reached the unfinished uploads limit', async () => {
      const channel = await dataSource
        .getRepository(Channel)
        .findOneByOrFail({ nickname: 'owner' });
      for (let i = 0; i < 20; i++) {
        const id = randomUUID();
        await dataSource.getRepository(Video).insert({
          id,
          public_id: `cap${String(i).padStart(8, '0')}`,
          channel_id: channel.id,
          source_key: `videos/${id}/source.mp4`,
        });
      }

      const body = await errorBodyOf(createVideo(1024).expect(429));

      expect(body.error).toBe('TOO_MANY_OPEN_UPLOADS');
      expect(await dataSource.getRepository(Video).count()).toBe(20);
    });

    it('should answer 401 without a token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 1 })
        .expect(401);
    });

    it('should answer 400 for an unsupported content type', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .set(auth(token))
        .send({
          filename: 'a.avi',
          contentType: 'video/x-msvideo',
          sizeBytes: 1,
        })
        .expect(400);
    });

    it('should answer 413 VIDEO_TOO_LARGE above 10 GiB and create no row', async () => {
      const body = await errorBodyOf(createVideo(10737418241).expect(413));

      expect(body.error).toBe('VIDEO_TOO_LARGE');
      expect(await dataSource.getRepository(Video).count()).toBe(0);
    });
  });

  describe('POST /videos/:publicId/upload/part-urls', () => {
    it('should return URLs that accept a direct PUT of each part', async () => {
      const created = await createDraft(PART_SIZE + 1024);

      const parts = await uploadParts(created.publicId, [PART_SIZE, 1024]);

      expect(parts.every((p) => p.etag.length > 0)).toBe(true);
    });

    it('should return the exact size of each part and let storage reject any other size', async () => {
      const created = await createDraft(PART_SIZE + 1024);
      const body = await bodyOf<PartUrlsResponseDto>(
        requestPartUrls(created.publicId, [1, 2]).expect(200),
      );

      expect(body.parts.map((p) => p.sizeBytes)).toEqual([PART_SIZE, 1024]);
      const oversized = await fetch(body.parts[1].url, {
        method: 'PUT',
        body: Buffer.alloc(1025, 3),
      });
      expect(oversized.status).toBe(403);
    });

    it('should answer 404 VIDEO_NOT_FOUND to another user', async () => {
      const created = await createDraft(1024);

      const body = await errorBodyOf(
        requestPartUrls(created.publicId, [1], otherToken).expect(404),
      );

      expect(body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('should answer 400 INVALID_PART_NUMBER above partCount', async () => {
      const created = await createDraft(PART_SIZE + 1024);

      const body = await errorBodyOf(
        requestPartUrls(created.publicId, [3]).expect(400),
      );

      expect(body.error).toBe('INVALID_PART_NUMBER');
    });

    it('should answer 400 for an empty or duplicated partNumbers list', async () => {
      const created = await createDraft(PART_SIZE + 1024);

      await requestPartUrls(created.publicId, []).expect(400);
      await requestPartUrls(created.publicId, [1, 1]).expect(400);
    });

    it('should not be rate limited at the global 10 requests per minute', async () => {
      const created = await createDraft(PART_SIZE + 1024);

      for (let i = 0; i < 15; i++) {
        await requestPartUrls(created.publicId, [1]).expect(200);
      }
    });
  });

  describe('POST /videos/:publicId/upload/complete', () => {
    it('should move the video to processing and enqueue the job', async () => {
      const created = await createDraft(PART_SIZE + 1024);
      const parts = await uploadParts(created.publicId, [PART_SIZE, 1024]);

      const body = await bodyOf<UploadCompletedResponseDto>(
        completeUpload(created.publicId, parts).expect(202),
      );

      expect(body).toEqual({
        publicId: created.publicId,
        status: 'processing',
      });
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: created.publicId });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      expect(row.processing_started_at).toBeInstanceOf(Date);
      expect((await queue.getJob(row.id))?.name).toBe('process-video');
    });

    it('should answer 409 VIDEO_INVALID_STATE on a second complete', async () => {
      const created = await createDraft(PART_SIZE + 1024);
      const parts = await uploadParts(created.publicId, [PART_SIZE, 1024]);
      await completeUpload(created.publicId, parts).expect(202);

      const body = await errorBodyOf(
        completeUpload(created.publicId, parts).expect(409),
      );

      expect(body.error).toBe('VIDEO_INVALID_STATE');
    });

    it('should answer 422 UPLOAD_PARTS_MISMATCH for a wrong etag', async () => {
      const created = await createDraft(PART_SIZE + 1024);
      const parts = await uploadParts(created.publicId, [PART_SIZE, 1024]);
      parts[1].etag = '"00000000000000000000000000000000"';

      const body = await errorBodyOf(
        completeUpload(created.publicId, parts).expect(422),
      );

      expect(body.error).toBe('UPLOAD_PARTS_MISMATCH');
    });

    it('should answer 422 UPLOAD_SIZE_MISMATCH when the stored total differs from the declared size', async () => {
      // Signed URLs make this impossible through the API, so the second part is
      // written straight to storage with the SDK (a bypass of the size guard).
      const created = await createDraft(PART_SIZE + 1024);
      const [first] = await uploadParts(created.publicId, [PART_SIZE]);
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: created.publicId });
      const second = await s3.send(
        new UploadPartCommand({
          Bucket: storageCfg.bucket,
          Key: row.source_key,
          UploadId: row.upload_id as string,
          PartNumber: 2,
          Body: Buffer.alloc(2048, 3),
        }),
      );
      const parts = [first, { partNumber: 2, etag: second.ETag as string }];

      const body = await errorBodyOf(
        completeUpload(created.publicId, parts).expect(422),
      );

      expect(body.error).toBe('UPLOAD_SIZE_MISMATCH');
    });

    it('should answer 404 to a user who does not own the video', async () => {
      const created = await createDraft(PART_SIZE + 1024);
      const parts = await uploadParts(created.publicId, [PART_SIZE, 1024]);

      await completeUpload(created.publicId, parts, otherToken).expect(404);
    });
  });
});
