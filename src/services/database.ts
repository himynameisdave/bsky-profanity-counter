import { PrismaClient } from '@prisma/client';
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
// goes through this module, so there's a single connection pool to close.
const prisma = new PrismaClient();

/**
 * Store a new mention from a notification.
 *
 * Upserts on the unique postId so that replaying the same notification (a crash
 * between storing and marking it read, or two overlapping runs) yields one row
 * and one reply, and never resets a mention we've already replied to.
 */
export async function storeMention({
  userHandle,
  postId,
  postUrl,
  isReply,
}: {
  userHandle: string;
  postId: string;
  postUrl: string;
  isReply: boolean;
}) {
  return prisma.mention.upsert({
    where: { postId },
    // We've already recorded this one, leave its status and reply alone
    update: {},
    create: {
      userHandle,
      postId,
      postUrl,
      isReply,
      // Status defaults to UNPROCESSED
    },
  });
}

/**
 * Claim the oldest unprocessed mention: mark it ANALYZING and count the
 * attempt, in one transaction to prevent race conditions.
 *
 * The attempt is counted here, not when processing fails, so an attempt still
 * counts if the run is killed partway through it (eg. by the workflow timeout).
 */
export async function getUnprocessedMention() {
  return prisma.$transaction(async (tx) => {
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
  return prisma.mention.count({
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
  return prisma.mention.update({
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
export async function markMentionAsFailed(mentionId: string) {
  return prisma.mention.update({
    where: { id: mentionId },
    data: { status: 'FAILED' },
  });
}

/**
 * Find the analysis of a user, however old it is
 */
export async function findAnalysis(userHandle: string) {
  return prisma.analysis.findUnique({ where: { userHandle } });
}

/**
 * Create or update analysis for a user
 */
export async function createOrUpdateAnalysis({
  userHandle,
  totalPosts,
  profanityCount,
  profanityDetails,
}: {
  userHandle: string;
  totalPosts: number;
  profanityCount: number;
  profanityDetails: ProfanityDetails;
}) {
  // Try to find existing analysis to update
  const existingAnalysis = await prisma.analysis.findUnique({
    where: { userHandle },
  });

  if (existingAnalysis) {
    return prisma.analysis.update({
      where: { id: existingAnalysis.id },
      data: {
        totalPosts,
        profanityCount,
        profanityDetails,
        lastAnalyzedAt: new Date(),
      },
    });
  }

  // Create new analysis if none exists
  return prisma.analysis.create({
    data: {
      userHandle,
      totalPosts,
      profanityCount,
      profanityDetails,
      // lastAnalyzedAt defaults to now
    },
  });
}

/**
 * Clean up old analyses (optional, for storage management)
 * Removes analyses older than specified days
 */
export async function cleanupOldAnalyses(olderThanDays = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  const result = await prisma.analysis.deleteMany({
    where: {
      updatedAt: {
        lt: cutoffDate,
      },
    },
  });

  return result.count;
}

/**
 * Total profanity across every analysis, leaving out `excludeHandle` (the bot
 * itself) when it's given
 */
export async function getTotalProfanityCount({
  excludeHandle,
}: { excludeHandle?: string } = {}): Promise<number> {
  // `_sum` is Prisma's aggregate API, not ours to rename
  // oxlint-disable-next-line no-underscore-dangle
  const result = await prisma.analysis.aggregate({
    _sum: {
      profanityCount: true,
    },
    where: excludeHandle ? { userHandle: { not: excludeHandle } } : {},
  });

  // oxlint-disable-next-line no-underscore-dangle
  return result._sum.profanityCount ?? 0;
}

/**
 * Reset mentions that are stuck in ANALYZING state for more than the specified minutes
 * This helps recover from crashes or process terminations
 */
export async function resetStuckMentions(olderThanMinutes: number) {
  const cutoffDate = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  const result = await prisma.mention.updateMany({
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
 * Close the database connection when done
 */
export async function disconnect() {
  await prisma.$disconnect();
}
