import { envValidationSchema } from './env.validation';

const requiredEnv = {
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_BUCKET: 'bucket',
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and videos', () => {
  const s3Env = {
    S3_ENDPOINT: 'http://minio:9000',
    S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
    S3_BUCKET: 'bucket',
  };

  it.each(Object.keys(s3Env))('should reject a missing %s', (key) => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env[key];
    const { error } = envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should apply defaults for optional storage, queue and videos keys', () => {
    const { value, error } = validate(s3Env);
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_REGION: 'us-east-1',
      S3_PRESIGN_EXPIRES_SECONDS: 3600,
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'streamtube',
      VIDEO_PART_SIZE_BYTES: 67108864,
      VIDEO_WORKER_CONCURRENCY: 1,
      VIDEO_SWEEP_INTERVAL_MS: 300000,
      VIDEO_PROCESSING_STUCK_MINUTES: 30,
      VIDEO_DRAFT_TTL_DAYS: 2,
    });
  });

  it('should reject a part size below the S3 minimum of 5 MiB', () => {
    const { error } = validate({ ...s3Env, VIDEO_PART_SIZE_BYTES: '5242879' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_PART_SIZE_BYTES');
  });
});
