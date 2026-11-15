import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  // Internal endpoint: Compose service name, used by the API and the worker.
  endpoint: process.env.S3_ENDPOINT as string,
  // Client-reachable endpoint: the host baked into presigned URLs.
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT as string,
  region: process.env.S3_REGION || 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
  bucket: process.env.S3_BUCKET as string,
  presignExpiresSeconds: parseInt(
    process.env.S3_PRESIGN_EXPIRES_SECONDS || '3600',
    10,
  ),
}));
