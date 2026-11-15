import {
  InvalidPartNumberException,
  TooManyOpenUploadsException,
  UploadPartsMismatchException,
  UploadSizeMismatchException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import type { Video } from './entities/video.entity';
import { VideoUploadsService } from './video-uploads.service';
import { VideoStatus } from './video-status.enum';

const MIB = 1024 * 1024;
const PART_SIZE = 5 * MIB;

describe('VideoUploadsService', () => {
  let service: VideoUploadsService;
  const videosService = {
    countOpenDrafts: jest.fn(),
    createDraft: jest.fn(),
    findOwnedByPublicId: jest.fn(),
    markProcessing: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    listParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
  };
  const videoQueueService = { enqueueProcessing: jest.fn() };

  const draft = (overrides: Partial<Video> = {}): Video =>
    ({
      id: 'video-id',
      public_id: 'abcdefghijk',
      status: VideoStatus.DRAFT,
      size_bytes: PART_SIZE + MIB, // 2 parts
      source_key: 'videos/video-id/source.mp4',
      upload_id: 'upload-1',
      ...overrides,
    }) as Video;

  const storedParts = [
    { partNumber: 1, size: PART_SIZE, etag: '"etag-1"' },
    { partNumber: 2, size: MIB, etag: '"etag-2"' },
  ];
  const sentParts = [
    { partNumber: 1, etag: 'etag-1' },
    { partNumber: 2, etag: '"etag-2"' },
  ];

  beforeEach(() => {
    jest.resetAllMocks();
    service = new VideoUploadsService(
      videosService as never,
      channelsService as never,
      storageService as never,
      videoQueueService as never,
      { partSizeBytes: PART_SIZE, maxOpenDrafts: 20 } as never,
      { presignExpiresSeconds: 3600 } as never,
    );
    videosService.findOwnedByPublicId.mockResolvedValue(draft());
    videosService.countOpenDrafts.mockResolvedValue(0);
    storageService.listParts.mockResolvedValue(storedParts);
    storageService.abortMultipartUpload.mockResolvedValue(undefined);
    videoQueueService.enqueueProcessing.mockResolvedValue(undefined);
  });

  describe('startUpload', () => {
    const dto = {
      filename: 'clip.mov',
      contentType: 'video/quicktime',
      sizeBytes: PART_SIZE * 2 + 1,
    };

    it('should reject sizes above 10 GiB before touching storage', async () => {
      await expect(
        service.startUpload('user-1', { ...dto, sizeBytes: 10737418241 }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should accept exactly 10 GiB', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      storageService.createMultipartUpload.mockResolvedValue('upload-1');
      videosService.createDraft.mockImplementation((input: object) => ({
        ...input,
        public_id: 'abcdefghijk',
        status: VideoStatus.DRAFT,
        size_bytes: 10737418240,
      }));

      const result = await service.startUpload('user-1', {
        ...dto,
        sizeBytes: 10737418240,
      });

      expect(result.partCount).toBe(2048); // 10 GiB / 5 MiB in this config
    });

    it('should refuse a new upload when the channel already has the maximum of open drafts', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      videosService.countOpenDrafts.mockResolvedValue(20);

      await expect(service.startUpload('user-1', dto)).rejects.toBeInstanceOf(
        TooManyOpenUploadsException,
      );

      expect(videosService.countOpenDrafts).toHaveBeenCalledWith('channel-1');
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should allow an upload while below the open drafts limit', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      videosService.countOpenDrafts.mockResolvedValue(19);
      storageService.createMultipartUpload.mockResolvedValue('upload-1');
      videosService.createDraft.mockImplementation((input: object) => ({
        ...input,
        public_id: 'abcdefghijk',
        status: VideoStatus.DRAFT,
        size_bytes: dto.sizeBytes,
      }));

      await expect(service.startUpload('user-1', dto)).resolves.toMatchObject({
        publicId: 'abcdefghijk',
      });
    });

    it('should fail when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.startUpload('user-1', dto)).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('should derive the storage key and extension from the content type', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      storageService.createMultipartUpload.mockResolvedValue('upload-1');
      videosService.createDraft.mockImplementation((input: object) => ({
        ...input,
        public_id: 'abcdefghijk',
        status: VideoStatus.DRAFT,
        size_bytes: dto.sizeBytes,
      }));

      const result = await service.startUpload('user-1', dto);

      const [key, contentType] = storageService.createMultipartUpload.mock
        .calls[0] as [string, string];
      expect(key).toMatch(/^videos\/[0-9a-f-]{36}\/source\.mov$/);
      expect(contentType).toBe('video/quicktime');
      expect(result).toEqual({
        publicId: 'abcdefghijk',
        status: VideoStatus.DRAFT,
        partSizeBytes: PART_SIZE,
        partCount: 3,
      });
    });

    it('should abort the multipart upload and rethrow when the draft insert fails', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      storageService.createMultipartUpload.mockResolvedValue('upload-1');
      const failure = new Error('insert failed');
      videosService.createDraft.mockRejectedValue(failure);

      await expect(service.startUpload('user-1', dto)).rejects.toBe(failure);

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/source\.mov$/),
        'upload-1',
      );
    });
  });

  describe('getPartUrls', () => {
    it('should reject a video that is not a draft', async () => {
      videosService.findOwnedByPublicId.mockResolvedValue(
        draft({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.getPartUrls('user-1', 'abcdefghijk', [1]),
      ).rejects.toBeInstanceOf(VideoInvalidStateException);
    });

    it('should reject a part number above partCount', async () => {
      await expect(
        service.getPartUrls('user-1', 'abcdefghijk', [1, 3]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should return one signed URL per requested part', async () => {
      storageService.presignUploadPart.mockImplementation(
        (_key: string, _uploadId: string, n: number, length: number) =>
          Promise.resolve(`https://storage/part/${n}?len=${length}`),
      );

      const result = await service.getPartUrls('user-1', 'abcdefghijk', [2, 1]);

      expect(result).toEqual({
        parts: [
          {
            partNumber: 2,
            sizeBytes: MIB,
            url: `https://storage/part/2?len=${MIB}`,
          },
          {
            partNumber: 1,
            sizeBytes: PART_SIZE,
            url: `https://storage/part/1?len=${PART_SIZE}`,
          },
        ],
        expiresInSeconds: 3600,
      });
      // Every part but the last has the full part size; the last carries the remainder.
      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-id/source.mp4',
        'upload-1',
        1,
        PART_SIZE,
      );
      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-id/source.mp4',
        'upload-1',
        2,
        MIB,
      );
    });
  });

  describe('completeUpload', () => {
    it('should reject a video that is not a draft', async () => {
      videosService.findOwnedByPublicId.mockResolvedValue(
        draft({ status: VideoStatus.READY }),
      );

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', { parts: sentParts }),
      ).rejects.toBeInstanceOf(VideoInvalidStateException);
    });

    it('should reject when the number of parts differs from partCount', async () => {
      await expect(
        service.completeUpload('user-1', 'abcdefghijk', {
          parts: [sentParts[0]],
        }),
      ).rejects.toBeInstanceOf(UploadPartsMismatchException);
    });

    it('should reject when part numbers are not 1..partCount', async () => {
      await expect(
        service.completeUpload('user-1', 'abcdefghijk', {
          parts: [sentParts[0], { partNumber: 3, etag: 'etag-2' }],
        }),
      ).rejects.toBeInstanceOf(UploadPartsMismatchException);
    });

    it('should reject an etag that differs from the stored one', async () => {
      await expect(
        service.completeUpload('user-1', 'abcdefghijk', {
          parts: [sentParts[0], { partNumber: 2, etag: 'wrong' }],
        }),
      ).rejects.toBeInstanceOf(UploadPartsMismatchException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject when storage holds fewer parts than were sent', async () => {
      storageService.listParts.mockResolvedValue([storedParts[0]]);

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', { parts: sentParts }),
      ).rejects.toBeInstanceOf(UploadPartsMismatchException);
    });

    it('should reject stored parts that add up to more than 10 GiB', async () => {
      storageService.listParts.mockResolvedValue([
        { partNumber: 1, size: 10737418240, etag: '"etag-1"' },
        { partNumber: 2, size: 1, etag: '"etag-2"' },
      ]);

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', { parts: sentParts }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
    });

    it('should reject a stored total that differs from the declared size', async () => {
      videosService.findOwnedByPublicId.mockResolvedValue(
        draft({ size_bytes: PART_SIZE + MIB + 10 }),
      );

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', { parts: sentParts }),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should complete in storage, mark processing and only then enqueue', async () => {
      const order: string[] = [];
      storageService.completeMultipartUpload.mockImplementation(() => {
        order.push('storage');
        return Promise.resolve();
      });
      videosService.markProcessing.mockImplementation(() => {
        order.push('db');
        return Promise.resolve();
      });
      videoQueueService.enqueueProcessing.mockImplementation(() => {
        order.push('queue');
        return Promise.resolve();
      });

      const result = await service.completeUpload('user-1', 'abcdefghijk', {
        parts: sentParts,
      });

      expect(order).toEqual(['storage', 'db', 'queue']);
      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-id/source.mp4',
        'upload-1',
        [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      );
      expect(videoQueueService.enqueueProcessing).toHaveBeenCalledWith(
        'video-id',
      );
      expect(result).toEqual({
        publicId: 'abcdefghijk',
        status: VideoStatus.PROCESSING,
      });
    });

    it('should not fail the request when enqueueing fails', async () => {
      videoQueueService.enqueueProcessing.mockRejectedValue(
        new Error('redis down'),
      );

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', { parts: sentParts }),
      ).resolves.toEqual({
        publicId: 'abcdefghijk',
        status: VideoStatus.PROCESSING,
      });
      expect(videosService.markProcessing).toHaveBeenCalledWith('video-id');
    });
  });
});
