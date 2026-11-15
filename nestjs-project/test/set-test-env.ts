// Runs after `dotenv/config` in every Jest worker: points the test process at
// isolated resources so suites never touch development data.
process.env.DB_NAME = 'streamtube_test';
process.env.DB_DATABASE = 'streamtube_test';
process.env.S3_BUCKET = 'streamtube-test';
process.env.QUEUE_PREFIX = 'streamtube-test';
process.env.VIDEO_PART_SIZE_BYTES = '5242880';
// Tests run inside the Docker network, where localhost:9000 cannot reach MinIO.
if (process.env.S3_ENDPOINT) {
  process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
}
