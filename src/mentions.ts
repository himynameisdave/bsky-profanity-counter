import type { BskyAgent } from '@atproto/api';
import * as bsky from './services/bluesky.js';
import * as db from './services/database.js';
import * as logger from './services/logger.js';
import type { Notification } from './types.js';

// Notification records are loosely typed, so narrow before reading the reply parent
type NotificationRecord = { reply?: { parent?: { uri?: string } } };

/**
 * Takes a Bluesky notification and maps it to our database Mention schema structure
 * Fields required by our Prisma Mention model:
 * - userHandle: String (handle of user to analyze)
 * - postId: String (ID of post containing the mention)
 * - postUrl: String (URL to the post)
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
    userHandle,
    postId,
    postUrl,
    isReply,
  };
}

/**
 * Resolve the handle of the author of the post a reply is pointing at.
 * Returns null when the parent post (or its author) can't be looked up.
 */
async function getParentAuthorHandle(
  agent: BskyAgent,
  notification: Notification,
): Promise<string | null> {
  const record = notification.record as NotificationRecord | undefined;
  const parentUri = record?.reply?.parent?.uri;

  if (!parentUri) {
    return null;
  }

  try {
    // Get parent post details using the utility function
    const parentPostResponse = await bsky.getPost(agent, parentUri);

    if (!parentPostResponse) {
      return null;
    }

    // Get the author's DID from the URI, then their profile
    const [authorDid] = parentPostResponse.uri.split('/').slice(2);
    const profileResponse = await bsky.getProfile(agent, authorDid);

    return profileResponse.handle;
  } catch {
    // If we can't get the parent post, we'll keep the original mention author
    return null;
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
        const parentHandle = await getParentAuthorHandle(agent, mention);
        if (parentHandle) {
          mentionData.userHandle = parentHandle;
        }
      }

      // Store in database (an upsert, so replaying a notification is a no-op)
      // oxlint-disable-next-line no-await-in-loop
      await db.storeMention(mentionData);

      if (!firstFailure) {
        lastStoredIndexedAt = mention.indexedAt;
      }
    } catch (error) {
      // A single bad mention shouldn't stop the rest from being stored, but it
      // does stop the read cursor from moving past it
      logger.error(`❌ Error storing mention ${mention.uri}\n\t- ${error}`);

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
