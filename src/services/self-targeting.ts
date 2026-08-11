import type { BskyAgent } from '@atproto/api';
import type { Mention } from '@prisma/client';
import * as bsky from './bluesky.js';
import * as db from './database.js';
import * as logger from './logger.js';

/**
 * Whimsical responses for when the bot is targeted by itself.
 * Persona: nerdy accountant type who takes their job seriously but has a sense of humor.
 */
export const WHIMSICAL_RESPONSES = [
  'Nice try, buddy! 😏',
  "Hey now, that's not how this works! 🙃",
  "Trying to break me? I'm unbreakable! 💪",
  "I don't analyze myself, I'm perfect! ✨",
  "Plot twist: I'm squeaky clean! 🧼",
  'Error 404: Self-audit not found! 🤓',
  'My books are balanced, thank you very much! 📚⚖️',
  "I've already reconciled my accounts - they're spotless! 🧮✨",
  'Attempting to audit the auditor? Frig off buddy!',
  'My profanity ledger shows zero entries for this account! 📋✅',
];

function getRandomResponse() {
  return WHIMSICAL_RESPONSES[Math.floor(Math.random() * WHIMSICAL_RESPONSES.length)];
}

/**
 * Handles mentions where the bot is targeting itself.
 * Should only be called when we've already confirmed this is a self-targeting attempt.
 */
export async function handleSelfTargeting(agent: BskyAgent, mention: Mention): Promise<void> {
  logger.info(`🤖 Bot was targeted by itself, responding with whimsical message`);

  // Get the mention post to reply to
  const mentionPost = await bsky.getPost(agent, mention.postUrl);

  if (mentionPost) {
    // Select a random whimsical response
    const randomResponse = getRandomResponse();

    // Reply to the mention with the whimsical response
    const reply = (await bsky.replyToPost(
      agent,
      { uri: mentionPost.uri, cid: mentionPost.cid },
      randomResponse,
    )) as { uri?: string; cid?: string } | undefined;

    // Extract the reply post ID and URL
    const replyPostId = reply?.uri?.split('/').pop() || '';
    const replyUrl = reply?.uri || '';

    // Mark the mention as done
    await db.markMentionAsDone({
      mentionId: mention.id,
      replyPostId,
      replyUrl,
    });

    logger.success(`✅ Replied to self-targeting mention with whimsical response`);
  } else {
    // The post no longer exists, so we can't reply to it
    logger.warn(`⚠️ Could not find mention post to reply to (likely deleted): ${mention.postUrl}`);

    // Still mark the mention as done, but without a reply
    await db.markMentionAsDone({
      mentionId: mention.id,
      replyPostId: '',
      replyUrl: '',
    });

    logger.info(`✅ Marked self-targeting mention as processed (post unavailable)`);
  }
}
