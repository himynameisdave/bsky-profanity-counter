import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { parseDatabaseUrl } from '../../src/config.js';
import type { DatabaseConfig } from '../../src/config.js';

// Helpers for the suites that run against a real PostgreSQL. Only call these
// from setup hooks inside an enabled suite: a skipped suite's body still runs
// while tests are collected, and mustn't open a connection pool.

/** The test database, read the same way the bot reads its own. */
export const testDatabase = (): DatabaseConfig => parseDatabaseUrl(process.env.DATABASE_URL ?? '');

/**
 * A second client, separate from the service's, to set up and check fixtures.
 * Connects the way the service does, so its raw SQL finds the same tables.
 */
export const createFixtureClient = () => {
  const { url, schema } = testDatabase();
  const searchPath = schema && schema !== 'public' ? { options: `-c search_path="${schema}"` } : {};
  return new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: url, ...searchPath },
      schema ? { schema } : undefined,
    ),
  });
};
