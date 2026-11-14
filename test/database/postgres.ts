import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { parseDatabaseUrl } from '../../src/config.js';
import type { DatabaseConfig } from '../../src/config.js';

// Helpers for the suites that run against a real PostgreSQL. Only call these
// from setup hooks inside an enabled suite: a skipped suite's body still runs
// while tests are collected, and mustn't open a connection pool.

/** The test database, read the same way the bot reads its own. */
export const testDatabase = (): DatabaseConfig => parseDatabaseUrl(process.env.DATABASE_URL ?? '');

/** A second client, separate from the service's, to set up and check fixtures. */
export const createFixtureClient = (database = testDatabase()) =>
  new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: database.url },
      { schema: database.schema ?? 'public' },
    ),
  });

export const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A table in the test database's schema, for fixtures' raw SQL (like the service's). */
export const table = (name: string, schema = testDatabase().schema ?? 'public') =>
  Prisma.raw(`${quoteIdentifier(schema)}.${quoteIdentifier(name)}`);
