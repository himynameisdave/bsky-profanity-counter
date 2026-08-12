import { PrismaClient } from '@prisma/client';

// Type for profanity details stored in JSON
export type ProfanityDetails = {
  // Map of profanity words to counts
  wordCounts: Record<string, number>;
  // Array of top profanities with counts, sorted descending
  topProfanities: { word: string; count: number }[];
};

// Initialize Prisma client (only once at module level)
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
 * Get an unprocessed mention and atomically mark it as analyzing.
 * Uses a transaction to prevent race conditions.
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
 * Mark a mention as being analyzed
 * This is now handled in the getUnprocessedMention transaction,
 * but keeping for backward compatibility
 */
export async function markMentionAsAnalyzing(mentionId: string) {
  return prisma.mention.update({
    where: { id: mentionId },
    data: { status: 'ANALYZING' },
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
 * Find a fresh analysis (within 24 hours) for a user
 */
export async function findFreshAnalysis(userHandle: string) {
  const oneDayAgo = new Date();
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);

  return prisma.analysis.findFirst({
    where: {
      userHandle,
      lastAnalyzedAt: {
        gte: oneDayAgo,
      },
    },
  });
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
 * Reset mentions that are stuck in ANALYZING state for more than the specified minutes
 * This helps recover from crashes or process terminations
 */
export async function resetStuckMentions(olderThanMinutes = 30) {
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
