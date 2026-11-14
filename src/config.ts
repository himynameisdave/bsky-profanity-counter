import dotenv from 'dotenv';

// The knobs worth turning when running your own copy of the bot. Its handle and
// DID aren't here: they come from the session once it logs in, so a fork works
// without changing any code.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// The server the bot logs in to
export const BLUESKY_SERVICE = 'https://bsky.social';

// Most posts we'll read when auditing someone. We also stop at a year old,
// whichever comes first.
export const MAX_POSTS = 25_000;

// Pages per pass. A paused run checks new arrivals separately, then resumes
// its checkpointed backlog, without marking unfinished notifications as read.
export const MAX_NOTIFICATION_PAGES = 25;

// How long an analysis gets reused before we count someone's posts again
export const ANALYSIS_CACHE_TTL_MS = 24 * HOUR_MS;

// Counting someone again normally just adds their posts since last time. Every
// so often we recount their whole year instead, to catch posts they've deleted.
export const FULL_RECOUNT_INTERVAL_MS = 30 * 24 * HOUR_MS;

// A mention left ANALYZING for this long belongs to a run that died partway
// through, so it goes back in the queue. Keep it longer than a run can last
// (the scheduled workflow's timeout is 15 minutes).
export const STUCK_MENTION_TIMEOUT_MINUTES = 20;

// Most database connections one run opens. The bot makes one query at a time,
// so it rarely needs more than one, but this leaves room without crowding a
// hosted database's connection limit (the two workflows can overlap).
export const DATABASE_POOL_MAX = 5;

// How long to wait for a database connection, or for a free one in the pool,
// before failing. The pg driver waits forever by default. This is long enough
// for a hosted database waking from sleep, and far short of the workflow timeout.
export const DATABASE_CONNECT_TIMEOUT_MS = 10_000;

export type BlueskyCredentials = { identifier: string; password: string };

export type DatabaseConfig = {
  // The whole connection string, password included. Never log it.
  url: string;
  // From the URL's `schema` parameter, which Prisma 6 read for us and the pg
  // driver ignores
  schema?: string;
};

export type Env = { bluesky: BlueskyCredentials; database: DatabaseConfig };

const REQUIRED_ENV_VARS = ['BLUESKY_IDENTIFIER', 'BLUESKY_PASSWORD', 'DATABASE_URL'] as const;

// A schema name we can safely quote into raw SQL. Postgres allows more, but
// nobody needs a schema called `my "schema"`.
const SCHEMA_NAME = /^[A-Za-z_][\w$]*$/u;

// Where it's fine to connect without TLS. The pg driver only uses TLS when the
// URL asks for it, where Prisma 6 tried it by default.
const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '[::1]']);

/**
 * Checks DATABASE_URL is a Postgres connection string, and picks out the
 * schema. Errors never include the URL, since it holds the password.
 */
export const parseDatabaseUrl = (value: string): DatabaseConfig => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('🕵️ DATABASE_URL is not a valid URL');
  }

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('🕵️ DATABASE_URL must start with postgresql:// or postgres://');
  }

  // Rather than quietly send the password to another machine in plain text
  if (!url.searchParams.has('sslmode') && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      '🕵️ DATABASE_URL points at another machine but has no sslmode; add ?sslmode=verify-full (or sslmode=disable if you mean it)',
    );
  }

  const schema = url.searchParams.get('schema') ?? undefined;
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
    throw new Error('🕵️ DATABASE_URL has a schema parameter that is not a plain identifier');
  }

  return { url: value, ...(schema ? { schema } : {}) };
};

/**
 * Checks every environment variable the bot needs is set, and picks out the
 * ones it passes around. Throws naming all the missing ones at once.
 */
export const parseEnv = (env: Record<string, string | undefined>): Env => {
  const missing = REQUIRED_ENV_VARS.filter((name) => !env[name]);

  if (missing.length > 0) {
    throw new Error(`🕵️ Missing environment variables: ${missing.join(', ')}`);
  }

  return {
    bluesky: {
      identifier: env.BLUESKY_IDENTIFIER ?? '',
      password: env.BLUESKY_PASSWORD ?? '',
    },
    database: parseDatabaseUrl(env.DATABASE_URL ?? ''),
  };
};

/**
 * Loads `.env`, if there is one, then checks the environment (see parseEnv).
 * Entry points call this once and pass along what's needed, so nothing reads
 * the environment at import time.
 */
export const loadEnv = (): Env => {
  dotenv.config({ quiet: true });
  return parseEnv(process.env);
};

/**
 * Like loadEnv, for tools that only touch the database (ie: the read-only
 * smoke check), so they don't need the bot's Bluesky password.
 */
export const loadDatabaseEnv = (): DatabaseConfig => {
  dotenv.config({ quiet: true });
  if (!process.env.DATABASE_URL) {
    throw new Error('🕵️ Missing environment variables: DATABASE_URL');
  }
  return parseDatabaseUrl(process.env.DATABASE_URL);
};
