import type { BskyAgent } from '@atproto/api';
import * as db from './database.js';
import * as logger from './logger.js';
import { describeError } from '../errors.js';

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

    // The bot never counts itself, whatever DID or handle it's running under
    const totalCount = await db.getTotalProfanityCount({
      excludeDid: agent.session?.did,
      excludeHandle: agent.session?.handle,
    });
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
    logger.error(`❌ Error updating profile description: ${describeError(error)}`);
    throw error;
  }
}
