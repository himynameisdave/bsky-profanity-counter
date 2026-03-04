import { BskyAgent } from '@atproto/api';
import * as bsky from './services/bluesky.js';
import * as db from './services/database.js';
import * as logger from './services/logger.js';

/**
 * Checks all bot replies for orphaned posts (where the original mention post
 * has been deleted) and soft-deletes them: removes from Bluesky but keeps
 * the record in the database with replyDeletedAt set.
 */
export async function cleanupOrphanedReplies(agent: BskyAgent): Promise<number> {
  const mentions = await db.getMentionsWithActiveReplies();

  if (mentions.length === 0) {
    logger.info('🧹 No active replies to check for cleanup');
    return 0;
  }

  logger.info(`🧹 Checking ${mentions.length} active replies for orphaned posts...`);

  let deletedCount = 0;

  for (const mention of mentions) {
    // Check if the original mention post still exists
    const originalPost = await bsky.getPost(agent, mention.postUrl);

    if (!originalPost) {
      // The original post is gone — delete our reply from Bluesky
      logger.info(`🗑️ Original post deleted, cleaning up reply: ${mention.replyUrl}`);

      const deleted = await bsky.deletePost(agent, mention.replyUrl!);

      if (deleted) {
        await db.markReplyAsDeleted(mention.id);
        deletedCount++;
        logger.success(`✅ Soft-deleted orphaned reply for mention ${mention.id}`);
      }
    }
  }

  if (deletedCount > 0) {
    logger.info(`🧹 Cleaned up ${deletedCount} orphaned replies`);
  } else {
    logger.info('🧹 No orphaned replies found');
  }

  return deletedCount;
}
