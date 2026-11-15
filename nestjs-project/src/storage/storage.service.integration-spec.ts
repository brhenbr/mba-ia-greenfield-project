import { randomUUID } from 'crypto';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { StorageUnavailableException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { cleanStorage } from '../test/clean-storage';
import { S3_INTERNAL_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIB = 1024 * 1024;

describe('StorageService (integration, real MinIO)', () => {
  let moduleRef: TestingModule;
  let service: StorageService;
  let client: S3Client;
  let config: ConfigType<typeof storageConfig>;
  const prefix = `test-storage-${randomUUID()}/`;

  const uploadPart = async (url: string, size: number): Promise<string> => {
    const response = await fetch(url, {
      method: 'PUT',
      body: Buffer.alloc(size, 7),
    });
    expect(response.status).toBe(200);
    return response.headers.get('etag') as string;
  };

  const uploadObject = async (
    key: string,
    sizes: number[],
  ): Promise<number> => {
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const completed: { partNumber: number; etag: string }[] = [];
    for (const [index, size] of sizes.entries()) {
      const partNumber = index + 1;
      const url = await service.presignUploadPart(
        key,
        uploadId,
        partNumber,
        size,
      );
      completed.push({ partNumber, etag: await uploadPart(url, size) });
    }
    await service.completeMultipartUpload(key, uploadId, completed);
    return sizes.reduce((sum, size) => sum + size, 0);
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await moduleRef.init(); // runs ensureBucket()
    service = moduleRef.get(StorageService);
    client = moduleRef.get<S3Client>(S3_INTERNAL_CLIENT);
    config = moduleRef.get<ConfigType<typeof storageConfig>>(storageConfig.KEY);
  });

  afterAll(async () => {
    await cleanStorage(client, config.bucket, prefix);
    await moduleRef.close();
  });

  it('should create the bucket on init and be idempotent afterwards', async () => {
    await expect(service.ensureBucket()).resolves.toBeUndefined();
    await expect(
      client.send(new HeadBucketCommand({ Bucket: config.bucket })),
    ).resolves.toBeDefined();
  });

  it('should assemble a 3-part upload whose size is the sum of the parts', async () => {
    const key = `${prefix}${randomUUID()}/source.mp4`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const sizes = [5 * MIB, 5 * MIB, 1024];
    const completed: { partNumber: number; etag: string }[] = [];
    for (const [index, size] of sizes.entries()) {
      const url = await service.presignUploadPart(
        key,
        uploadId,
        index + 1,
        size,
      );
      completed.push({
        partNumber: index + 1,
        etag: await uploadPart(url, size),
      });
    }

    const stored = await service.listParts(key, uploadId);
    await service.completeMultipartUpload(key, uploadId, completed);
    const head = await service.headObject(key);

    const total = sizes.reduce((sum, size) => sum + size, 0);
    expect(stored.map((p) => p.size)).toEqual(sizes);
    expect(head).toEqual({ contentLength: total, contentType: 'video/mp4' });
  });

  it('should sign part URLs with the host of S3_PUBLIC_ENDPOINT', async () => {
    const key = `${prefix}${randomUUID()}/host.mp4`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    const url = new URL(
      await service.presignUploadPart(key, uploadId, 1, 5 * MIB),
    );

    expect(url.host).toBe(new URL(config.publicEndpoint).host);
    await service.abortMultipartUpload(key, uploadId);
  });

  it.each([
    ['one byte larger', 5 * MIB + 1],
    ['much larger', 64 * MIB],
    ['smaller', 1024],
  ])(
    'should reject a part %s than the size the URL was signed for',
    async (_label, actualSize) => {
      const key = `${prefix}${randomUUID()}/size-guard.mp4`;
      const uploadId = await service.createMultipartUpload(key, 'video/mp4');
      const url = await service.presignUploadPart(key, uploadId, 1, 5 * MIB);

      const response = await fetch(url, {
        method: 'PUT',
        body: Buffer.alloc(actualSize, 1),
      });

      expect(response.status).toBe(403);
      await service.abortMultipartUpload(key, uploadId);
    },
  );

  it('should serve partial content when the signed GET carries a Range header', async () => {
    const key = `${prefix}${randomUUID()}/range.mp4`;
    const total = await uploadObject(key, [5 * MIB, 1024]);

    const response = await fetch(await service.presignGetObject(key), {
      headers: { Range: 'bytes=0-9' },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-9/${total}`);
    await response.arrayBuffer();
  });

  it('should answer download URLs with an attachment Content-Disposition', async () => {
    const key = `${prefix}${randomUUID()}/download.mp4`;
    await uploadObject(key, [5 * MIB, 1024]);

    const response = await fetch(
      await service.presignGetObject(key, { downloadFilename: 'video.mp4' }),
      { headers: { Range: 'bytes=0-9' } },
    );

    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="video.mp4"',
    );
    await response.arrayBuffer();
  });

  it('should store a small object with putObject', async () => {
    const key = `${prefix}${randomUUID()}/thumb.jpg`;

    await service.putObject(key, Buffer.from('jpeg'), 'image/jpeg');

    await expect(service.headObject(key)).resolves.toEqual({
      contentLength: 4,
      contentType: 'image/jpeg',
    });
  });

  it('should return null from headObject for a missing key', async () => {
    await expect(
      service.headObject(`${prefix}missing/source.mp4`),
    ).resolves.toBeNull();
  });

  it('should not fail when aborting an upload that does not exist', async () => {
    await expect(
      service.abortMultipartUpload(`${prefix}ghost.mp4`, 'no-such-upload-id'),
    ).resolves.toBeUndefined();
  });

  it('should throw StorageUnavailableException when storage is unreachable', async () => {
    const unreachable = new S3Client({
      region: config.region,
      endpoint: 'http://127.0.0.1:1',
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: { accessKeyId: 'k', secretAccessKey: 's' },
    });
    const offline = new StorageService(unreachable, unreachable, config);

    await expect(
      offline.createMultipartUpload('k', 'video/mp4'),
    ).rejects.toBeInstanceOf(StorageUnavailableException);
  });
});
