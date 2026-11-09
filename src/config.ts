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

// How long an analysis gets reused before we count someone's posts again
export const ANALYSIS_CACHE_TTL_MS = 24 * HOUR_MS;

// Counting someone again normally just adds their posts since last time. Every
// so often we recount their whole year instead, to catch posts they've deleted.
export const FULL_RECOUNT_INTERVAL_MS = 30 * 24 * HOUR_MS;

// A mention left ANALYZING for this long belongs to a run that died partway
// through, so it goes back in the queue. Keep it longer than a run can last
// (the scheduled workflow's timeout is 15 minutes).
export const STUCK_MENTION_TIMEOUT_MINUTES = 20;

export type BlueskyCredentials = { identifier: string; password: string };

export type Env = { bluesky: BlueskyCredentials };

// Prisma reads DATABASE_URL by itself when it first connects. We only check it's
// set, so a run without it fails straight away with a clear message.
const REQUIRED_ENV_VARS = ['BLUESKY_IDENTIFIER', 'BLUESKY_PASSWORD', 'DATABASE_URL'] as const;

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
