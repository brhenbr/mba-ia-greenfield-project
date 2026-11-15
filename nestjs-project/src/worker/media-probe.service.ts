import { spawn } from 'child_process';
import { Injectable } from '@nestjs/common';
import type { VideoMetadata } from '../videos/entities/video.entity';

export type MediaFailure = 'NOT_A_VIDEO' | 'PROBE_FAILED' | 'THUMBNAIL_FAILED';

export class MediaProbeError extends Error {
  constructor(
    public readonly reason: MediaFailure,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'MediaProbeError';
  }
}

export interface ProbeResult {
  durationSeconds: number | null;
  metadata: VideoMetadata;
}

const PROBE_TIMEOUT_MS = 60_000;
const THUMBNAIL_TIMEOUT_MS = 120_000;
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_CHARS = 4_000;

// Containers the plan allows (mp4/mov share a demuxer; webm is matroska).
const ALLOWED_CONTAINERS = ['mov', 'mp4', 'matroska', 'webm'];

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  disposition?: { attached_pic?: number };
}

interface RawProbe {
  streams?: RawStream[];
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
    size?: string;
  };
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Turns `ffprobe -print_format json` output into the stored metadata. */
export function parseProbeOutput(stdout: string): ProbeResult {
  let raw: RawProbe;
  try {
    raw = JSON.parse(stdout) as RawProbe;
  } catch {
    throw new MediaProbeError('PROBE_FAILED', 'ffprobe returned invalid JSON');
  }

  const container = raw.format?.format_name ?? '';
  const streams = raw.streams ?? [];
  // Cover art (attached pictures) is not a video stream for our purposes.
  const video = streams.find(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1,
  );
  if (!video) {
    throw new MediaProbeError('NOT_A_VIDEO', 'no video stream');
  }
  if (!ALLOWED_CONTAINERS.some((name) => container.split(',').includes(name))) {
    throw new MediaProbeError(
      'NOT_A_VIDEO',
      `unsupported container "${container}"`,
    );
  }
  const audio = streams.find((s) => s.codec_type === 'audio');

  const duration = toNumber(raw.format?.duration) ?? toNumber(video.duration);
  return {
    durationSeconds:
      duration === null ? null : Math.round(duration * 1000) / 1000,
    metadata: {
      container,
      videoCodec: video.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      width: video.width ?? null,
      height: video.height ?? null,
      bitrate: toNumber(raw.format?.bit_rate),
      sizeBytes: toNumber(raw.format?.size),
    },
  };
}

/** Thumbnail instant: 10% of the duration; for clips under 10 s, min(1, duration / 2). */
export function thumbnailInstant(durationSeconds: number | null): number {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  if (durationSeconds < 10) return Math.min(1, durationSeconds / 2);
  return durationSeconds * 0.1;
}

interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
}

// The signed source URL carries credentials in its query string: never keep it.
const redact = (text: string): string => text.replace(/\?\S*/g, '?…');

/** Runs a binary with an argument array (never through a shell). */
function run(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxStdoutBytes: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let overflow = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxStdoutBytes) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(chunks),
        stderr: redact(stderr),
        timedOut,
        overflow,
      });
    });
  });
}

@Injectable()
export class MediaProbeService {
  /** Reads duration and stream metadata over HTTP; only the file index is fetched. */
  async probe(url: string): Promise<ProbeResult> {
    const result = await this.execute('PROBE_FAILED', () =>
      run(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          url,
        ],
        { timeoutMs: PROBE_TIMEOUT_MS, maxStdoutBytes: 5 * 1024 * 1024 },
      ),
    );

    if (result.code !== 0) {
      // ffprobe says this when it does not recognise the bytes as media.
      if (result.stderr.includes('Invalid data found when processing input')) {
        throw new MediaProbeError('NOT_A_VIDEO', 'unrecognised media data');
      }
      throw new MediaProbeError(
        'PROBE_FAILED',
        this.describe(result, 'ffprobe'),
      );
    }
    return parseProbeOutput(result.stdout.toString());
  }

  /** Renders one JPEG frame (at most 1280 px wide) at the given instant. */
  async extractThumbnail(url: string, seconds: number): Promise<Buffer> {
    const result = await this.execute('THUMBNAIL_FAILED', () =>
      run(
        'ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          String(seconds),
          '-i',
          url,
          '-frames:v',
          '1',
          '-vf',
          "scale='min(1280,iw)':-2",
          '-q:v',
          '3',
          '-f',
          'image2pipe',
          '-c:v',
          'mjpeg',
          'pipe:1',
        ],
        {
          timeoutMs: THUMBNAIL_TIMEOUT_MS,
          maxStdoutBytes: MAX_THUMBNAIL_BYTES,
        },
      ),
    );

    if (result.code !== 0 || result.stdout.length === 0) {
      throw new MediaProbeError(
        'THUMBNAIL_FAILED',
        this.describe(result, 'ffmpeg'),
      );
    }
    return result.stdout;
  }

  private async execute(
    failure: MediaFailure,
    call: () => Promise<RunResult>,
  ): Promise<RunResult> {
    try {
      return await call();
    } catch (error) {
      // The binary could not even be started (e.g. not installed).
      throw new MediaProbeError(
        failure,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private describe(result: RunResult, binary: string): string {
    if (result.timedOut) return `${binary} timed out`;
    if (result.overflow) return `${binary} output too large`;
    return `${binary} exited with ${result.code}: ${result.stderr.trim()}`;
  }
}
