import type { BskyAgent } from '@atproto/api';
import type { Mention } from '@prisma/client';
import * as bsky from './bluesky.js';
import * as db from './database.js';
import * as logger from './logger.js';

// Allows for clock drift between the runner that claimed the mention and the
// one that posted the reply
const CLOCK_SLACK_MS = 60 * 60 * 1000;

/**
 * Replies to a mention with `text` and marks it done.
 *
 * If the mention's post has been deleted, it's marked done without a reply. If
 * an earlier attempt already posted the reply (and then failed before marking
 * the mention done), that reply is recorded instead of posting another one.
 * Throws on anything else, so the mention is retried on a later run.
 */
export async function replyToMention(
  agent: BskyAgent,
  mention: Mention,
  text: string,
  analysisId?: string,
): Promise<void> {
  const mentionPost = await bsky.getPost(agent, mention.postUrl);

  if (!mentionPost) {
    await db.markMentionAsDone({
      mentionId: mention.id,
      replyPostId: '',
      replyUrl: '',
      analysisId,
    });
    logger.info(`✅ Marked mention ${mention.id} as processed (post deleted)`);
    return;
  }

  // `attempts` includes this one, so anything above 1 means an earlier attempt
  // got cut short, possibly after replying
  const earlierReply =
    mention.attempts > 1 && mention.firstAttemptedAt
      ? await bsky.findOwnReply(
          agent,
          mentionPost.uri,
          new Date(mention.firstAttemptedAt.getTime() - CLOCK_SLACK_MS),
        )
      : null;

  if (earlierReply) {
    logger.warn(
      `♻️ Already replied to mention ${mention.id} (${earlierReply.uri}), not replying again`,
    );
  }

  const reply = earlierReply ?? (await bsky.replyToPost(agent, mentionPost, text));

  await db.markMentionAsDone({
    mentionId: mention.id,
    replyPostId: reply.uri.split('/').pop() ?? '',
    replyUrl: reply.uri,
    analysisId,
  });
}
