import { randomBytes } from 'crypto';
import { PUBLIC_ID_LENGTH } from './videos.constants';

// Exactly 64 symbols, so masking a random byte with 63 is unbiased.
const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** URL-safe random id of 11 characters (66 bits), used in every public video URL. */
export function generatePublicId(): string {
  let id = '';
  for (const byte of randomBytes(PUBLIC_ID_LENGTH)) {
    id += ALPHABET[byte & 63];
  }
  return id;
}
