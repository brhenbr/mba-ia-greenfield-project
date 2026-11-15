export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3; // 10 GiB = 10737418240

// Plan-level allowlist: every entry needs a real fixture test (SI-03.7).
export const VIDEO_CONTENT_TYPES = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
} as const;

export type VideoContentType = keyof typeof VIDEO_CONTENT_TYPES;

export const PUBLIC_ID_LENGTH = 11;
export const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
export const PUBLIC_ID_MAX_ATTEMPTS = 5;

export const MAX_PART_NUMBERS_PER_REQUEST = 100;
