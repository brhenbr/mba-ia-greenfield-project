import 'dotenv/config';
import { join } from 'path';
import { DataSource } from 'typeorm';

export const TEST_DB_NAME = 'streamtube_test';

function connection(database: string) {
  return {
    type: 'postgres' as const,
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database,
  };
}

// Creates the isolated test database (once) and applies the migrations to it.
export default async function globalSetup(): Promise<void> {
  const admin = new DataSource(connection(process.env.DB_NAME ?? 'streamtube'));
  await admin.initialize();
  try {
    const rows: unknown[] = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [TEST_DB_NAME],
    );
    if (rows.length === 0) {
      await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
    }
  } finally {
    await admin.destroy();
  }

  const testDb = new DataSource({
    ...connection(TEST_DB_NAME),
    migrations: [join(__dirname, '../src/database/migrations/*.ts')],
    synchronize: false,
  });
  await testDb.initialize();
  try {
    // TypeORM only installs this when entities are loaded; the migrations need it.
    await testDb.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await testDb.runMigrations();
  } finally {
    await testDb.destroy();
  }
}
