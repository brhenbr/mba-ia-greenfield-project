import { registerAs } from '@nestjs/config';

export default registerAs('videos', () => ({
  partSizeBytes: parseInt(process.env.VIDEO_PART_SIZE_BYTES || '67108864', 10),
  workerConcurrency: parseInt(process.env.VIDEO_WORKER_CONCURRENCY || '4', 10),
  maxOpenDrafts: parseInt(process.env.VIDEO_MAX_OPEN_DRAFTS || '20', 10),
  sweepIntervalMs: parseInt(
    process.env.VIDEO_SWEEP_INTERVAL_MS || '300000',
    10,
  ),
  processingStuckMinutes: parseInt(
    process.env.VIDEO_PROCESSING_STUCK_MINUTES || '30',
    10,
  ),
  draftTtlDays: parseInt(process.env.VIDEO_DRAFT_TTL_DAYS || '2', 10),
}));
