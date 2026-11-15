export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_MAINTENANCE_QUEUE = 'video-maintenance';

export const PROCESS_VIDEO_JOB = 'process-video';
export const SWEEP_JOB = 'sweep';

export const VIDEO_MAINTENANCE_SCHEDULER_ID = 'video-maintenance-sweep';

export const VIDEO_PROCESSING_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
} as const;

export interface ProcessVideoJobData {
  videoId: string;
}
