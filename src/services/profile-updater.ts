import type { BskyAgent } from '@atproto/api';
import { PrismaClient } from '@prisma/client';
import * as logger from './logger.js';

const prisma = new PrismaClient();

/**
 * Get the total profanity count from the Analysis table,
 * excluding the bot itself (profanity.accountant)
 */
export async function getTotalProfanityCount(): Promise<number> {
  // `_sum` is Prisma's aggregate API, not ours to rename
  // oxlint-disable-next-line no-underscore-dangle
  const result = await prisma.analysis.aggregate({
    _sum: {
      profanityCount: true,
    },
    where: {
      userHandle: {
        not: 'profanity.accountant',
      },
    },
  });

  // oxlint-disable-next-line no-underscore-dangle
  return result._sum.profanityCount || 0;
}

/**
 * Format a number with commas for readability
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Generate the profile description with the total profanity count
 */
export function generateProfileDescription(totalCount: number): string {
  const formattedCount = formatNumber(totalCount);

  return `Tag me and I will respond telling you how much a profanity you (or the user you're replying to) has used in the last year (it may take me a few minutes to respond).

${formattedCount} total profanities counted, you pottymouths!`;
}

/**
 * Update the bot's profile description with the current total profanity count
 */
export async function updateProfileDescription(agent: BskyAgent): Promise<void> {
  try {
    logger.info('📊 Getting total profanity count...');

    const totalCount = await getTotalProfanityCount();
    logger.info(`📈 Total profanity count: ${formatNumber(totalCount)}`);

    const newDescription = generateProfileDescription(totalCount);
    logger.info('📝 Updating profile description...');

    // Update the profile with the new description
    await agent.upsertProfile((existing) => ({
      ...existing,
      description: newDescription,
    }));

    logger.success(
      `✅ Profile description updated with ${formatNumber(totalCount)} total profanities`,
    );
  } catch (error) {
    logger.error(`❌ Error updating profile description: ${error}`);
    throw error;
  }
}

/**
 * Close the database connection when done
 */
export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
