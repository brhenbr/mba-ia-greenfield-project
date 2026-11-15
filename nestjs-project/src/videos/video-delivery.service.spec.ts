import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import type { Video } from './entities/video.entity';
import {
  sanitizeDownloadFilename,
  VideoDeliveryService,
} from './video-delivery.service';

describe('sanitizeDownloadFilename', () => {
  it.each([
    ['clip.mp4', 'clip.mp4'],
    ['my "clip".mp4', 'my clip.mp4'],
    ['line\r\nbreak.mp4', 'linebreak.mp4'],
    ['back\\slash.mp4', 'backslash.mp4'],
    ['vídeo.mp4', 'v_deo.mp4'],
    ['  padded.mp4  ', 'padded.mp4'],
    ['"""', ''],
    ['', ''],
    [null, ''],
  ])('should turn %j into %j', (input, expected) => {
    expect(sanitizeDownloadFilename(input)).toBe(expected);
  });

  it('should cap the name at 255 characters', () => {
    expect(sanitizeDownloadFilename('a'.repeat(400))).toHaveLength(255);
  });
});

describe('VideoDeliveryService', () => {
  let service: VideoDeliveryService;
  const videosService = { findReadyByPublicId: jest.fn() };
  const storageService = { presignGetObject: jest.fn() };

  const video = (overrides: Partial<Video> = {}): Video =>
    ({
      public_id: 'abcdefghijk',
      source_key: 'videos/id/source.webm',
      thumbnail_key: 'thumbnails/id/default.jpg',
      original_filename: 'clip.webm',
      ...overrides,
    }) as Video;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new VideoDeliveryService(
      videosService as never,
      storageService as never,
    );
    videosService.findReadyByPublicId.mockResolvedValue(video());
    storageService.presignGetObject.mockResolvedValue('https://signed');
  });

  it('should sign the source for streaming without a content disposition', async () => {
    await expect(service.getStreamUrl('abcdefghijk')).resolves.toBe(
      'https://signed',
    );

    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      'videos/id/source.webm',
    );
  });

  it('should sign the source as an attachment named after the sanitized original filename', async () => {
    videosService.findReadyByPublicId.mockResolvedValue(
      video({ original_filename: 'my "clip"\r\n.mp4' }),
    );

    await service.getDownloadUrl('abcdefghijk');

    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      'videos/id/source.webm',
      { downloadFilename: 'my clip.mp4' },
    );
  });

  it('should fall back to {publicId}.{ext} when no usable filename remains', async () => {
    videosService.findReadyByPublicId.mockResolvedValue(
      video({ original_filename: '""' }),
    );

    await service.getDownloadUrl('abcdefghijk');

    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      'videos/id/source.webm',
      { downloadFilename: 'abcdefghijk.webm' },
    );
  });

  it('should sign the thumbnail key', async () => {
    await service.getThumbnailUrl('abcdefghijk');

    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      'thumbnails/id/default.jpg',
    );
  });

  it('should answer not found when a ready video has no thumbnail', async () => {
    videosService.findReadyByPublicId.mockResolvedValue(
      video({ thumbnail_key: null }),
    );

    await expect(service.getThumbnailUrl('abcdefghijk')).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
  });

  it.each(['getStreamUrl', 'getDownloadUrl', 'getThumbnailUrl'] as const)(
    '%s should propagate not found for videos that are not ready',
    async (method) => {
      videosService.findReadyByPublicId.mockRejectedValue(
        new VideoNotFoundException(),
      );

      await expect(service[method]('abcdefghijk')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
      expect(storageService.presignGetObject).not.toHaveBeenCalled();
    },
  );
});
