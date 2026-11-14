import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { DATABASE_CONNECT_TIMEOUT_MS, DATABASE_POOL_MAX } from '../config.js';
import type { DatabaseConfig } from '../config.js';
import { DUPLICATE_SNAPSHOT_REASON, planIdentityBackfill } from './identity-backfill.js';
import type { DailyCounts } from './profanity.js';
import type { FeedCheckpoint } from './bluesky.js';

// Type for profanity details stored in JSON
export type ProfanityDetails = {
  // Map of profanity words to counts
  wordCounts: Record<string, number>;
  // Array of top profanities with counts, sorted descending
  topProfanities: { word: string; count: number }[];
  // What a re-analysis needs to only count the posts since this one. Analyses
  // saved before these were added don't have them, so they get a full recount.

  // The account we counted, in case the handle has moved to someone else since
  did?: string;
  // The counts the totals above add up from
  days?: DailyCounts;
  // Where we left off in their feed
  checkpoint?: FeedCheckpoint;
  // When we last counted their whole year, rather than just their new posts
  fullCountAt?: string;
};

// The one Prisma client for the whole app. Everything that touches the database
// goes through this module, so there's a single connection pool to close. It's
// made by init(), never at import time, so importing this reads no environment.
let client: PrismaClient | undefined;

// The Postgres schema the generated queries use. Raw SQL names its tables in it
// too, rather than trusting search_path, which a role or database can set to
// put some other schema first.
let schema = 'public';

/**
 * Sets up the client and its connection pool for this run. Entry points call it
 * once, after loadEnv(). Nothing connects until the first query.
 */
export function init(config: DatabaseConfig) {
  if (client) {
    throw new Error('The database is already initialized; call init() once per run');
  }

  schema = config.schema ?? 'public';
  const adapter = new PrismaPg(
    {
      connectionString: config.url,
      max: DATABASE_POOL_MAX,
      connectionTimeoutMillis: DATABASE_CONNECT_TIMEOUT_MS,
      // Lets you spot the bot's connections in pg_stat_activity
      application_name: 'profanity.accountant',
    },
    { schema },
  );
  client = new PrismaClient({
    adapter,
    // Starting a transaction can mean opening a connection, since pg closes idle
    // ones after 10s, so give it as long as a connection gets rather than Prisma's 2s
    transactionOptions: { maxWait: DATABASE_CONNECT_TIMEOUT_MS },
  });
}

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A table in the generated queries' schema, quoted for raw SQL. */
const table = (name: string) => Prisma.raw(`${quoteIdentifier(schema)}.${quoteIdentifier(name)}`);

const prisma = (): PrismaClient => {
  if (!client) {
    throw new Error('The database is not initialized; call init() after loadEnv()');
  }
  return client;
};

/** Where this bot paused collecting unread notifications, if it hasn't finished. */
export async function getNotificationScan(botDid: string) {
  return prisma().notificationScan.findUnique({ where: { botDid } });
}

/** Call only after every mention on the page has been persisted. */
export async function saveNotificationScan(
  botDid: string,
  cursor: string,
  latestIndexedAt: string | null,
) {
  const data = { cursor, latestIndexedAt };
  return prisma().notificationScan.upsert({
    where: { botDid },
    create: { botDid, ...data },
    update: data,
  });
}

/** Clear only after Bluesky accepts the completed scan's read acknowledgement. */
export async function clearNotificationScan(botDid: string) {
  return prisma().notificationScan.deleteMany({ where: { botDid } });
}

/**
 * Store a new mention from a notification.
 *
 * The full AT URI is the identity; record keys can repeat across repositories.
 * INSERT ON CONFLICT DO NOTHING lets the database arbitrate concurrent stores,
 * without touching any state or metadata on a replay (including updatedAt).
 */
export async function storeMention({
  did,
  userHandle,
  postId,
  postUrl,
  isReply,
}: {
  did: string;
  userHandle: string;
  postId: string;
  postUrl: string;
  isReply: boolean;
}) {
  await prisma().mention.createMany({
    skipDuplicates: true,
    data: {
      did,
      userHandle,
      postId,
      postUrl,
      isReply,
      // Status defaults to UNPROCESSED
    },
  });

  // Read after the atomic insert, never check before inserting. Throw if the
  // URI wasn't stored, so ingestion cannot advance its cursor on a false success.
  return prisma().mention.findUniqueOrThrow({ where: { postUrl } });
}

/**
 * Claim the oldest unprocessed mention: mark it ANALYZING and count the
 * attempt, in one transaction to prevent race conditions.
 *
 * The attempt is counted here, not when processing fails, so an attempt still
 * counts if the run is killed partway through it (eg. by the workflow timeout).
 */
export async function getUnprocessedMention() {
  return prisma().$transaction(async (tx) => {
    // Find the first unprocessed mention
    const mention = await tx.mention.findFirst({
      where: {
        status: 'UNPROCESSED',
      },
      orderBy: {
        createdAt: 'asc', // Order by creation date, oldest first
      },
    });

    if (!mention) {
      return null;
    }

    // Immediately mark it as analyzing within the same transaction
    const updatedMention = await tx.mention.update({
      where: {
        id: mention.id,
      },
      data: {
        status: 'ANALYZING',
        attempts: { increment: 1 },
        firstAttemptedAt: mention.firstAttemptedAt ?? new Date(),
      },
    });

    return updatedMention;
  });
}

/**
 * Get count of all mentions with UNPROCESSED status
 */
export async function getUnprocessedMentionsCount() {
  return prisma().mention.count({
    where: {
      status: 'UNPROCESSED',
    },
  });
}

/**
 * Mark a mention as done and store reply information
 */
export async function markMentionAsDone({
  mentionId,
  replyPostId,
  replyUrl,
  analysisId,
}: {
  mentionId: string;
  replyPostId: string;
  replyUrl: string;
  analysisId?: string;
}) {
  return prisma().mention.update({
    where: { id: mentionId },
    data: {
      status: 'DONE',
      replyPostId,
      replyUrl,
      analysisId,
    },
  });
}

/**
 * Mark a mention as failed: we gave up on it, and it will never be retried.
 * Unlike ANALYZING, resetStuckMentions leaves FAILED mentions alone.
 */
export async function markMentionAsFailed(mentionId: string, lastError: string) {
  return prisma().mention.update({
    where: { id: mentionId },
    data: { status: 'FAILED', lastError },
  });
}

/** Record an attempt's error without changing its retry state. */
export async function recordMentionError(mentionId: string, lastError: string) {
  return prisma().mention.update({ where: { id: mentionId }, data: { lastError } });
}

/** Find a proven account's analysis, however old it is. */
export async function findAnalysis(did: string) {
  return prisma().analysis.findUnique({ where: { did } });
}

/** Save one snapshot per account, keeping its latest display handle. */
export async function createOrUpdateAnalysis({
  did,
  userHandle,
  totalPosts,
  profanityCount,
  profanityDetails,
}: {
  did: string;
  userHandle: string;
  totalPosts: number;
  profanityCount: number;
  profanityDetails: ProfanityDetails;
}) {
  const data = { userHandle, totalPosts, profanityCount, profanityDetails };
  return prisma().analysis.upsert({
    where: { did },
    update: { ...data, lastAnalyzedAt: new Date() },
    create: { ...data, did },
  });
}

/** Refresh display fields without extending the analysis cache's lifetime. */
export async function refreshTargetHandle(mentionId: string, did: string, userHandle: string) {
  const db = prisma();
  await db.$transaction([
    db.mention.update({ where: { id: mentionId }, data: { userHandle } }),
    db.analysis.updateMany({ where: { did }, data: { userHandle } }),
  ]);
}

/**
 * Clean up old analyses (optional, for storage management)
 * Removes analyses older than specified days
 */
export async function cleanupOldAnalyses(olderThanDays = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  const result = await prisma().analysis.deleteMany({
    where: {
      updatedAt: {
        lt: cutoffDate,
      },
    },
  });

  return result.count;
}

/**
 * Total profanity across every analysis, leaving out the bot itself (by
 * `excludeDid`, and by `excludeHandle` for its archived rows, which have no DID).
 *
 * Archived analyses still count, so the total doesn't drop when old rows lose
 * their DID. Two kinds are skipped so nobody is counted twice: duplicate
 * snapshots of a DID we kept another analysis for, and anyone whose handle has
 * a DID'd analysis now (re-analyzing someone makes a new row, it doesn't update
 * their archived one).
 */
export async function getTotalProfanityCount({
  excludeDid,
  excludeHandle,
}: { excludeDid?: string; excludeHandle?: string } = {}): Promise<number> {
  const [{ total }] = await prisma().$queryRaw<[{ total: bigint | null }]>`
    SELECT SUM(a."profanityCount") AS total
    FROM ${table('Analysis')} a
    WHERE (
      a."did" IS NOT NULL
      OR (
        a."profanityDetails" -> 'identityBackfill' ->> 'reason' IS DISTINCT FROM ${DUPLICATE_SNAPSHOT_REASON}
        AND NOT EXISTS (
          SELECT 1 FROM ${table('Analysis')} b
          WHERE b."did" IS NOT NULL AND b."userHandle" = a."userHandle"
        )
      )
    )
    ${excludeDid ? Prisma.sql`AND a."did" IS DISTINCT FROM ${excludeDid}` : Prisma.empty}
    ${excludeHandle ? Prisma.sql`AND a."userHandle" <> ${excludeHandle}` : Prisma.empty}
  `;

  return Number(total ?? 0);
}

/**
 * Reset mentions that are stuck in ANALYZING state for more than the specified minutes
 * This helps recover from crashes or process terminations
 */
export async function resetStuckMentions(olderThanMinutes: number) {
  const cutoffDate = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  const result = await prisma().mention.updateMany({
    where: {
      status: 'ANALYZING',
      updatedAt: {
        lt: cutoffDate,
      },
    },
    data: {
      status: 'UNPROCESSED',
    },
  });

  return result.count;
}

/**
 * Close the connection pool when done. Safe to call if init() never ran (ie:
 * startup failed before it), and afterwards init() can run again.
 */
export async function disconnect() {
  const current = client;
  // Forget it first, so nothing can query a closed pool and quietly open a new one
  client = undefined;
  await current?.$disconnect();
}

/** Offline only: stop all bot writers first. The apply is atomic and rerunnable. */
export async function backfillIdentity(apply: boolean) {
  return prisma().$transaction(
    async (tx) => {
      const analyses = await tx.analysis.findMany();
      const mentions = await tx.mention.findMany();
      const plan = planIdentityBackfill(analyses, mentions);
      if (apply) {
        // Clear candidates first, so a different canonical snapshot can take over
        // an existing DID without violating the unique constraint mid-transaction.
        await tx.analysis.updateMany({
          where: { id: { in: plan.analysisUpdates.map((row) => row.id) } },
          data: { did: null },
        });
        for (const { id, ...data } of plan.analysisUpdates) {
          // Each update depends on the cleared unique keys in this transaction
          // oxlint-disable-next-line no-await-in-loop
          await tx.analysis.update({ where: { id }, data });
        }
        for (const { id, ...data } of plan.mentionUpdates) {
          // Keep all history, reply references and analysis relationships intact
          // oxlint-disable-next-line no-await-in-loop
          await tx.mention.update({ where: { id }, data });
        }
      }
      return {
        analyses: analyses.length,
        activeAnalyses: plan.analysisUpdates.filter((row) => row.did).length,
        quarantinedAnalyses: analyses.length - plan.analysisUpdates.filter((row) => row.did).length,
        mentions: mentions.length,
        mentionsWithoutIdentity: plan.mentionUpdates.filter((row) => !row.did).length,
        newlyFailedMentions: plan.mentionUpdates.filter((row) => row.status === 'FAILED').length,
      };
    },
    { timeout: 120_000 },
  );
}
