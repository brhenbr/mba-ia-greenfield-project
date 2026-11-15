import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from './create-test-data-source';

const DEV_DATABASE = 'streamtube';

describe('Test isolation (integration)', () => {
  let testDb: DataSource;
  let devDb: DataSource;

  beforeAll(async () => {
    testDb = createTestDataSource([
      User,
      Channel,
      Video,
      RefreshToken,
      VerificationToken,
    ]);
    devDb = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'db',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'streamtube',
      password: process.env.DB_PASSWORD ?? 'streamtube',
      database: DEV_DATABASE,
    });
    await Promise.all([testDb.initialize(), devDb.initialize()]);
  });

  afterAll(async () => {
    await cleanAllTables(testDb);
    await Promise.all([testDb.destroy(), devDb.destroy()]);
  });

  it('should run the test process against streamtube_test', async () => {
    const [{ current_database }] = await testDb.query<
      { current_database: string }[]
    >('SELECT current_database()');

    expect(current_database).toBe('streamtube_test');
  });

  it('should have created streamtube_test with the migrated tables', async () => {
    const [{ count }] = await devDb.query<{ count: string }[]>(
      `SELECT count(*) FROM pg_database WHERE datname = 'streamtube_test'`,
    );
    const tables = await testDb.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [['users', 'channels', 'refresh_tokens', 'verification_tokens']],
    );

    expect(Number(count)).toBe(1);
    expect(tables).toHaveLength(4);
  });

  it('should not alter the development database when writing in tests', async () => {
    // The development database may not be migrated (fresh clone, recreated
    // container): a missing table simply means there is nothing to alter.
    const countDevUsersByEmail = async (email: string) => {
      const [{ exists }] = await devDb.query<{ exists: boolean }[]>(
        `SELECT to_regclass('public.users') IS NOT NULL AS exists`,
      );
      if (!exists) return 0;
      const [{ count }] = await devDb.query<{ count: string }[]>(
        'SELECT count(*) FROM users WHERE email = $1',
        [email],
      );
      return Number(count);
    };
    const email = 'isolation-marker@test.dev';
    const before = await countDevUsersByEmail(email);

    await testDb.query(`INSERT INTO users (email, password) VALUES ($1, 'x')`, [
      email,
    ]);

    expect(await countDevUsersByEmail(email)).toBe(before);
    await cleanAllTables(testDb);
  });

  it('should override storage and queue resources for tests', () => {
    expect(process.env.S3_BUCKET).toBe('streamtube-test');
    expect(process.env.QUEUE_PREFIX).toBe('streamtube-test');
    expect(process.env.VIDEO_PART_SIZE_BYTES).toBe('5242880');
    expect(process.env.S3_PUBLIC_ENDPOINT).toBe(process.env.S3_ENDPOINT);
  });
});
