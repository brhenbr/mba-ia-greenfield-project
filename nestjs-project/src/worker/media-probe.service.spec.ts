import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import {
  MediaProbeError,
  MediaProbeService,
  parseProbeOutput,
  thumbnailInstant,
} from './media-probe.service';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

const spawnMock = spawn as unknown as jest.Mock;

function fakeProcess(output: {
  stdout?: Buffer;
  stderr?: string;
  code: number;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  setImmediate(() => {
    if (output.stdout) child.stdout.emit('data', output.stdout);
    if (output.stderr) child.stderr.emit('data', Buffer.from(output.stderr));
    child.emit('close', output.code);
  });
  return child;
}

const mp4Probe = {
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1280,
      height: 720,
      duration: '240.000000',
    },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '240.040000',
    bit_rate: '1432000',
    size: '42966013',
  },
};

describe('parseProbeOutput', () => {
  it('should extract duration and metadata from an MP4', () => {
    const result = parseProbeOutput(JSON.stringify(mp4Probe));

    expect(result).toEqual({
      durationSeconds: 240.04,
      metadata: {
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        videoCodec: 'h264',
        audioCodec: 'aac',
        width: 1280,
        height: 720,
        bitrate: 1432000,
        sizeBytes: 42966013,
      },
    });
  });

  it('should accept WebM (matroska) and leave missing audio as null', () => {
    const result = parseProbeOutput(
      JSON.stringify({
        streams: [
          { codec_type: 'video', codec_name: 'vp9', width: 320, height: 240 },
        ],
        format: { format_name: 'matroska,webm', duration: '2.000000' },
      }),
    );

    expect(result.metadata.audioCodec).toBeNull();
    expect(result.metadata.videoCodec).toBe('vp9');
    expect(result.durationSeconds).toBe(2);
  });

  it('should fall back to the video stream duration', () => {
    const result = parseProbeOutput(
      JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'h264', duration: '7.5' }],
        format: { format_name: 'mov,mp4' },
      }),
    );

    expect(result.durationSeconds).toBe(7.5);
  });

  it.each([
    ['no streams', { streams: [], format: { format_name: 'mov,mp4' } }],
    [
      'audio only',
      {
        streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
        format: { format_name: 'mov,mp4' },
      },
    ],
    [
      'cover art only',
      {
        streams: [
          {
            codec_type: 'video',
            codec_name: 'mjpeg',
            disposition: { attached_pic: 1 },
          },
        ],
        format: { format_name: 'mov,mp4' },
      },
    ],
    [
      'a still image (image2 container)',
      {
        streams: [{ codec_type: 'video', codec_name: 'mjpeg' }],
        format: { format_name: 'image2' },
      },
    ],
  ])('should flag %s as NOT_A_VIDEO', (_label, probe) => {
    expect(() => parseProbeOutput(JSON.stringify(probe))).toThrow(
      expect.objectContaining({ reason: 'NOT_A_VIDEO' }) as Error,
    );
  });

  it('should flag invalid JSON as PROBE_FAILED', () => {
    expect(() => parseProbeOutput('not json')).toThrow(
      expect.objectContaining({ reason: 'PROBE_FAILED' }) as Error,
    );
  });
});

describe('thumbnailInstant', () => {
  it.each([
    [null, 0],
    [0, 0],
    [1, 0.5],
    [2, 1],
    [9.99, 1],
    [10, 1],
    [240, 24],
  ])('should pick %s s duration -> %s s', (duration, expected) => {
    expect(thumbnailInstant(duration)).toBeCloseTo(expected);
  });
});

describe('MediaProbeService', () => {
  const service = new MediaProbeService();
  const url = 'http://minio:9000/bucket/key.mp4?X-Amz-Signature=secret';

  beforeEach(() => spawnMock.mockReset());

  describe('probe', () => {
    it('should run ffprobe with an argument array and no shell', async () => {
      spawnMock.mockReturnValue(
        fakeProcess({ stdout: Buffer.from(JSON.stringify(mp4Probe)), code: 0 }),
      );

      const result = await service.probe(url);

      const [command, args, options] = spawnMock.mock.calls[0] as [
        string,
        string[],
        Record<string, unknown>,
      ];
      expect(command).toBe('ffprobe');
      expect(args).toEqual([
        '-v',
        'error',
        '-format_whitelist',
        'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm',
        '-protocol_whitelist',
        'http,https,tcp,tls',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        url,
      ]);
      expect(options.shell).toBeUndefined();
      expect(result.metadata.videoCodec).toBe('h264');
    });

    it('should report unrecognised data as NOT_A_VIDEO', async () => {
      spawnMock.mockReturnValue(
        fakeProcess({
          stderr: 'x.txt: Invalid data found when processing input',
          code: 1,
        }),
      );

      await expect(service.probe(url)).rejects.toMatchObject({
        reason: 'NOT_A_VIDEO',
      });
    });

    it('should report a format outside the demuxer allowlist as NOT_A_VIDEO', async () => {
      spawnMock.mockReturnValue(
        fakeProcess({
          stderr: "[hls @ 0x1] Format not on whitelist 'mov,mp4'",
          code: 1,
        }),
      );

      await expect(service.probe(url)).rejects.toMatchObject({
        reason: 'NOT_A_VIDEO',
      });
    });

    it('should report other ffprobe failures as PROBE_FAILED without leaking the signed URL', async () => {
      spawnMock.mockReturnValue(
        fakeProcess({
          stderr: `${url}: Server returned 403 Forbidden`,
          code: 1,
        }),
      );

      const error = (await service
        .probe(url)
        .catch((e: unknown) => e)) as MediaProbeError;

      expect(error.reason).toBe('PROBE_FAILED');
      expect(error.message).not.toContain('secret');
      expect(error.message).toContain('403');
    });

    it('should report a binary that cannot start as PROBE_FAILED', async () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() =>
        child.emit('error', new Error('spawn ffprobe ENOENT')),
      );
      spawnMock.mockReturnValue(child);

      await expect(service.probe(url)).rejects.toMatchObject({
        reason: 'PROBE_FAILED',
      });
    });
  });

  describe('extractThumbnail', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]);

    it('should run ffmpeg with the seek, scale and quality arguments and return the JPEG', async () => {
      spawnMock.mockReturnValue(fakeProcess({ stdout: jpeg, code: 0 }));

      const result = await service.extractThumbnail(url, 12.5);

      const [command, args, options] = spawnMock.mock.calls[0] as [
        string,
        string[],
        Record<string, unknown>,
      ];
      expect(command).toBe('ffmpeg');
      expect(args).toEqual(
        expect.arrayContaining([
          '-ss',
          '12.5',
          '-i',
          url,
          '-frames:v',
          '1',
          '-q:v',
          '3',
        ]),
      );
      expect(args).toContain("scale='min(1280,iw)':-2");
      // Input guards must precede -i: they are input options.
      expect(args.indexOf('-format_whitelist')).toBeLessThan(
        args.indexOf('-i'),
      );
      expect(args.indexOf('-protocol_whitelist')).toBeLessThan(
        args.indexOf('-i'),
      );
      expect(options.shell).toBeUndefined();
      expect(result.equals(jpeg)).toBe(true);
    });

    it('should report a non-zero exit as THUMBNAIL_FAILED', async () => {
      spawnMock.mockReturnValue(fakeProcess({ stderr: 'boom', code: 1 }));

      await expect(service.extractThumbnail(url, 1)).rejects.toMatchObject({
        reason: 'THUMBNAIL_FAILED',
      });
    });

    it('should report an empty frame as THUMBNAIL_FAILED', async () => {
      spawnMock.mockReturnValue(fakeProcess({ code: 0 }));

      await expect(service.extractThumbnail(url, 1)).rejects.toMatchObject({
        reason: 'THUMBNAIL_FAILED',
      });
    });
  });
});
