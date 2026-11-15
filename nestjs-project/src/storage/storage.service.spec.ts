import { S3Client } from '@aws-sdk/client-s3';
import { StorageUnavailableException } from '../common/exceptions/domain.exception';
import { StorageService } from './storage.service';

const config = {
  endpoint: 'http://minio-internal:9000',
  publicEndpoint: 'http://public.example.test:9000',
  region: 'us-east-1',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  bucket: 'bucket',
  presignExpiresSeconds: 600,
};

function buildClient(endpoint: string): S3Client {
  return new S3Client({
    region: config.region,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function namedError(name: string, status?: number): Error {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

describe('StorageService', () => {
  let service: StorageService;
  let send: jest.Mock;

  beforeEach(() => {
    send = jest.fn();
    const internalClient = buildClient(config.endpoint);
    internalClient.send = send;
    service = new StorageService(
      internalClient,
      buildClient(config.publicEndpoint),
      config,
    );
  });

  describe('presigned URLs', () => {
    it('should sign part URLs for the public endpoint host', async () => {
      const url = new URL(
        await service.presignUploadPart('k', 'upload-1', 2, 1234),
      );

      expect(url.host).toBe('public.example.test:9000');
      // The exact size is part of the signature: storage rejects any other.
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain(
        'content-length',
      );
      expect(url.searchParams.get('partNumber')).toBe('2');
      expect(url.searchParams.get('uploadId')).toBe('upload-1');
    });

    it('should sign worker reads for the internal endpoint host', async () => {
      const url = new URL(await service.presignInternalGetObject('k'));

      expect(url.host).toBe('minio-internal:9000');
    });

    it('should sign stream URLs for the public host without a content disposition', async () => {
      const url = new URL(await service.presignGetObject('k'));

      expect(url.host).toBe('public.example.test:9000');
      expect(url.searchParams.has('response-content-disposition')).toBe(false);
    });

    it('should force attachment with a sanitized filename on download URLs', async () => {
      const url = new URL(
        await service.presignGetObject('k', {
          downloadFilename: 'my "clip".mp4',
        }),
      );

      expect(url.searchParams.get('response-content-disposition')).toBe(
        'attachment; filename="my _clip_.mp4"',
      );
    });
  });

  describe('ensureBucket', () => {
    it('should not create the bucket when it already exists', async () => {
      send.mockResolvedValueOnce({});

      await service.ensureBucket();

      expect(send).toHaveBeenCalledTimes(1);
    });

    it('should create the bucket when it is missing', async () => {
      send
        .mockRejectedValueOnce(namedError('NotFound', 404))
        .mockResolvedValueOnce({});

      await service.ensureBucket();

      expect(send).toHaveBeenCalledTimes(2);
    });

    it('should translate other failures into StorageUnavailableException', async () => {
      send.mockRejectedValueOnce(namedError('InternalError', 500));

      await expect(service.ensureBucket()).rejects.toBeInstanceOf(
        StorageUnavailableException,
      );
    });
  });

  describe('multipart operations', () => {
    it('should return the upload id from storage', async () => {
      send.mockResolvedValueOnce({ UploadId: 'upload-1' });

      await expect(
        service.createMultipartUpload('k', 'video/mp4'),
      ).resolves.toBe('upload-1');
    });

    it('should page through listParts', async () => {
      send
        .mockResolvedValueOnce({
          Parts: [{ PartNumber: 1, Size: 5, ETag: '"a"' }],
          IsTruncated: true,
          NextPartNumberMarker: '1',
        })
        .mockResolvedValueOnce({
          Parts: [{ PartNumber: 2, Size: 3, ETag: '"b"' }],
          IsTruncated: false,
        });

      const parts = await service.listParts('k', 'upload-1');

      expect(parts).toEqual([
        { partNumber: 1, size: 5, etag: '"a"' },
        { partNumber: 2, size: 3, etag: '"b"' },
      ]);
    });

    it.each([
      ['createMultipartUpload', () => service.createMultipartUpload('k', 'x')],
      ['listParts', () => service.listParts('k', 'u')],
      [
        'completeMultipartUpload',
        () => service.completeMultipartUpload('k', 'u', []),
      ],
    ])(
      '%s should hide SDK failures behind StorageUnavailableException',
      async (_name, call) => {
        send.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.1'));

        const error = await call().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(StorageUnavailableException);
        expect((error as Error).message).not.toContain('ECONNREFUSED');
      },
    );

    it('should ignore NoSuchUpload when aborting', async () => {
      send.mockRejectedValueOnce(namedError('NoSuchUpload', 404));

      await expect(
        service.abortMultipartUpload('k', 'gone'),
      ).resolves.toBeUndefined();
    });

    it('should surface other abort failures as StorageUnavailableException', async () => {
      send.mockRejectedValueOnce(namedError('InternalError', 500));

      await expect(
        service.abortMultipartUpload('k', 'u'),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    });
  });

  describe('headObject', () => {
    it('should return null when the object does not exist', async () => {
      send.mockRejectedValueOnce(namedError('NotFound', 404));

      await expect(service.headObject('k')).resolves.toBeNull();
    });

    it('should return the stored size and content type', async () => {
      send.mockResolvedValueOnce({
        ContentLength: 42,
        ContentType: 'video/mp4',
      });

      await expect(service.headObject('k')).resolves.toEqual({
        contentLength: 42,
        contentType: 'video/mp4',
      });
    });
  });
});
