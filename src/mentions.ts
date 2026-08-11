import type { BskyAgent } from '@atproto/api';
import * as bsky from './services/bluesky.js';
import * as db from './services/database.js';
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
 */
export default async function storeMentions(agent: BskyAgent, mentions: Notification[]) {
  await Promise.all(
    mentions.map(async (mention) => {
      try {
        // Start with basic mention info
        const mentionData = notificationToMention(mention);

        // If this is a reply, we analyze the parent post author instead
        if (mentionData.isReply) {
          const parentHandle = await getParentAuthorHandle(agent, mention);
          if (parentHandle) {
            mentionData.userHandle = parentHandle;
          }
        }

        // Store in database
        await db.storeMention(mentionData);
      } catch {
        // A single bad mention shouldn't stop the rest from being stored
      }
    }),
  );

  // After storing all mentions, mark notifications as read
  if (mentions.length > 0) {
    await bsky.markNotificationsAsRead(agent);
  }
}
