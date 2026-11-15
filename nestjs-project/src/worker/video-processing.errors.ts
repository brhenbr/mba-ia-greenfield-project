// Failure codes persisted in videos.failure_reason (see the plan's Error Catalog).
export type VideoFailureReason =
  | 'NOT_A_VIDEO'
  | 'SOURCE_MISSING'
  | 'PROBE_FAILED'
  | 'THUMBNAIL_FAILED'
  | 'STORAGE_ERROR';

/** A retryable processing failure that carries the reason to persist. */
export class VideoProcessingError extends Error {
  constructor(public readonly reason: VideoFailureReason) {
    super(reason);
    this.name = 'VideoProcessingError';
  }
}
