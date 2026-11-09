import type { BskyAgent } from '@atproto/api';
import * as bsky from './services/bluesky.js';
import * as db from './services/database.js';
import * as logger from './services/logger.js';
import { describeError, isTerminalMentionError } from './errors.js';
import { stats } from './run-stats.js';
import type { Notification } from './types.js';

// Notification records are loosely typed, so narrow before reading the reply parent
type NotificationRecord = { reply?: { parent?: { uri?: string } } };

/**
 * Takes a Bluesky notification and maps it to our database Mention schema structure
 * Fields required by our Prisma Mention model:
 * - userHandle: String (handle of user to analyze)
 * - postId: String (record key, only unique within its repository and collection)
 * - postUrl: String (full AT URI, the canonical unique identity)
 * - isReply: Boolean (whether it's a reply or direct mention)
 */
function notificationToMention(notification: Notification) {
  // Extract the userHandle - for direct mentions we analyze the author
  // For replies we analyze the parent post author (this gets set in storeMentions)
  const userHandle = notification.author.handle;

  // Extract post ID from the notification URI
  const postId = notification.uri.split('/').pop() || '';

  // The post URL is the full URI
  const postUrl = notification.uri;

  // Determine if this is a reply by checking the record structure
  const record = notification.record as NotificationRecord | undefined;
  const isReply = Boolean(record?.reply?.parent);

  return {
    did: notification.author.did,
    userHandle,
    postId,
    postUrl,
    isReply,
  };
}

/**
 * Find the identity of the author of the post a reply is pointing at.
 *
 * Returns null when there's no parent, or it's been deleted. Throws on any
 * other error: falling back to the person who tagged us then would audit the
 * wrong person, so it's better to leave the notification for the next run.
 */
async function getParentAuthor(
  agent: BskyAgent,
  notification: Notification,
): Promise<{ did: string; handle: string } | null> {
  const record = notification.record as NotificationRecord | undefined;
  const parentUri = record?.reply?.parent?.uri;

  if (!parentUri) {
    return null;
  }

  try {
    const parentPost = await bsky.getPost(agent, parentUri);

    if (!parentPost) {
      logger.info(
        `🫥 The post ${notification.uri} replies to is gone, auditing its author instead`,
      );
      return null;
    }

    // The canonical post URI proves its author's identity, independently of the handle.
    const [authorDid] = parentPost.uri.split('/').slice(2);
    const profile = await bsky.getProfile(agent, authorDid);
    return { did: authorDid, handle: profile.handle };
  } catch (error) {
    // Queue known terminal failures by the proven parent DID so processing can
    // persist FAILED/lastError instead of leaving this notification unread forever.
    // A deleted parent still takes the fallback above, exactly as before.
    const parentDid = /^at:\/\/(?<did>did:[^/]+)\/app\.bsky\.feed\.post\/[^/]+$/u.exec(parentUri)
      ?.groups?.did;
    if (parentDid && isTerminalMentionError(error)) {
      logger.warn(`⚠️ Queuing terminal parent error for ${parentDid}: ${describeError(error)}`);
      // A temporary display placeholder; processing must refresh it before replying.
      return { did: parentDid, handle: parentDid };
    }
    throw error;
  }
}

/**
 * Takes each notification from Bluesky, converts it to our Mention format,
 * and stores it in the database.
 *
 * `latestIndexedAt` is the newest notification in the batch we fetched (see
 * bsky.getMentions). Once everything is safely stored we mark notifications as
 * read up to that point — never up to "now", which would swallow anything that
 * arrived while this run was in flight.
 */
export default async function storeMentions(
  agent: BskyAgent,
  mentions: Notification[],
  latestIndexedAt: string | null,
) {
  if (!latestIndexedAt) {
    // Nothing was fetched, so there's no read cursor to advance
    return;
  }

  // Process mentions sequentially, oldest first: the read cursor can only move
  // past a mention once that mention is actually in the database
  const ordered = mentions.toSorted((a, b) => Date.parse(a.indexedAt) - Date.parse(b.indexedAt));

  let lastStoredIndexedAt: string | null = null;
  let firstFailure: Notification | null = null;

  for (const mention of ordered) {
    try {
      // Start with basic mention info
      const mentionData = notificationToMention(mention);

      // If this is a reply, we analyze the parent post author instead
      if (mentionData.isReply) {
        // Deliberately sequential: each mention gates how far the read cursor moves
        // oxlint-disable-next-line no-await-in-loop
        const parentAuthor = await getParentAuthor(agent, mention);
        if (parentAuthor) {
          mentionData.did = parentAuthor.did;
          mentionData.userHandle = parentAuthor.handle;
        }
      }

      // Store by full AT URI, so replaying a notification is a no-op
      // oxlint-disable-next-line no-await-in-loop
      await db.storeMention(mentionData);
      stats.stored++;

      if (!firstFailure) {
        lastStoredIndexedAt = mention.indexedAt;
      }
    } catch (error) {
      // A single bad mention shouldn't stop the rest from being stored, but it
      // does stop the read cursor from moving past it
      logger.error(`❌ Error storing mention ${mention.uri}\n\t- ${describeError(error)}`);
      stats.failed++;

      firstFailure ??= mention;
    }
  }

  // Don't move the cursor onto (or past) a mention we failed to store, otherwise
  // it gets marked read and is never retried
  if (
    firstFailure &&
    lastStoredIndexedAt &&
    Date.parse(lastStoredIndexedAt) >= Date.parse(firstFailure.indexedAt)
  ) {
    lastStoredIndexedAt = null;
  }

  const seenAt = firstFailure ? lastStoredIndexedAt : latestIndexedAt;

  if (firstFailure) {
    logger.warn(
      `⚠️ Leaving notifications from ${firstFailure.indexedAt} onwards unread so they're retried next run`,
    );
  }

  if (!seenAt) {
    logger.warn('🚧 Not marking any notifications as read this run');
    return;
  }

  await bsky.markNotificationsAsRead(agent, seenAt);
}
