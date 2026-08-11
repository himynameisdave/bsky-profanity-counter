import { BskyAgent, type AppBskyFeedDefs, type AppBskyRichtextFacet } from '@atproto/api';
import dotenv from 'dotenv';
import * as logger from './logger.js';
import type { Notification } from '../types.js';

dotenv.config();

// Environment variables
const { BLUESKY_IDENTIFIER } = process.env;
const { BLUESKY_PASSWORD } = process.env;

if (!BLUESKY_IDENTIFIER || !BLUESKY_PASSWORD) {
  throw new Error('Missing Bluesky credentials in environment variables');
}

// Create and authenticate the Bluesky agent
export const createAgent = async (): Promise<BskyAgent> => {
  const agent = new BskyAgent({
    service: 'https://bsky.social',
  });

  await agent.login({
    identifier: BLUESKY_IDENTIFIER,
    password: BLUESKY_PASSWORD,
  });

  logger.success('🔑 Successfully authenticated with Bluesky');

  return agent;
};

// Get notifications where the bot is mentioned
export const getMentions = async (agent: BskyAgent) => {
  const allNotifications: Notification[] = [];

  logger.info('🔍 Getting notifications...');

  // Iterate through all pages of notifications
  // Recursive function to fetch notifications page by page
  const fetchNotificationsPage = async (currentCursor?: string): Promise<void> => {
    const response = await agent.listNotifications({
      limit: 100,
      cursor: currentCursor,
    });

    allNotifications.push(...response.data.notifications);

    // Base case: no more pages to fetch
    if (!response.data.cursor) {
      return;
    }

    // Recursive case: fetch the next page
    return fetchNotificationsPage(response.data.cursor);
  };

  // Start the recursive fetching process
  await fetchNotificationsPage();

  if (allNotifications.length > 0) {
    logger.info(`📥 Found ${allNotifications.length} notifications`);
  } else {
    logger.info('❌ No notifications found');
    return [];
  }

  // Filter for mentions in replies that we haven't processed yet
  const unreadMentions = allNotifications.filter(
    (notification) => notification.reason === 'mention' && !notification.isRead,
  );

  logger.info(`📤 Found ${unreadMentions.length} unread mentions`);

  return unreadMentions;
};

//  Marks all notifications as read
export const markNotificationsAsRead = async (agent: BskyAgent) => {
  const seenAt = new Date().toISOString();
  await agent.app.bsky.notification.updateSeen({
    seenAt,
  });
  logger.success(`📑 Successfully marked notifications as read up to ${seenAt}`);
};

// Post records are loosely typed, so narrow before reading `createdAt`
const getPostDate = (post: AppBskyFeedDefs.PostView | undefined): Date | null => {
  const record = post?.record as { createdAt?: unknown } | undefined;
  return typeof record?.createdAt === 'string' ? new Date(record.createdAt) : null;
};

// Get user's posts
export const getUserPosts = async (
  agent: BskyAgent,
  did: string,
): Promise<AppBskyFeedDefs.PostView[]> => {
  const allPosts: AppBskyFeedDefs.PostView[] = [];
  let cursor;
  const MAX_POSTS = 25_000; // Maximum number of posts to retrieve
  const CHUNK_SIZE = 100; // Size of each chunk (API limit)
  const ONE_YEAR_AGO = new Date();
  ONE_YEAR_AGO.setFullYear(ONE_YEAR_AGO.getFullYear() - 1);

  logger.info(`🔍 Getting posts for ${did} (up to ${MAX_POSTS} posts from the last year)...`);

  let chunkCount = 0;
  let oldestPostDate = new Date();
  let reachedYearOld = false;

  // Fetch posts in batches until we hit the max, reach a year old posts, or there are no more
  while (allPosts.length < MAX_POSTS && !reachedYearOld) {
    chunkCount++;

    try {
      // Pagination is inherently sequential: each request needs the previous cursor
      // oxlint-disable-next-line no-await-in-loop
      const response = await agent.getAuthorFeed({
        actor: did,
        limit: CHUNK_SIZE,
        cursor,
      });

      const posts = response.data.feed.reduce((acc, item) => {
        // Only include items that are not reposts
        if (!item.reason) {
          acc.push(item.post);
        }
        return acc;
      }, [] as AppBskyFeedDefs.PostView[]);

      if (posts.length === 0) {
        logger.info(`🔍 No more posts found after ${allPosts.length} total posts`);
        break;
      }

      // Check the date of the last post in this chunk
      const lastPostDate = getPostDate(posts[posts.length - 1]);

      if (lastPostDate) {
        oldestPostDate = lastPostDate;

        // Check if we've reached posts older than one year
        if (lastPostDate < ONE_YEAR_AGO) {
          reachedYearOld = true;
          logger.info(`🕒 Reached posts older than one year (${lastPostDate.toISOString()})`);

          // Filter out posts older than one year
          const recentPosts = posts.filter((post) => {
            const postDate = getPostDate(post);
            return postDate !== null && postDate >= ONE_YEAR_AGO;
          });

          allPosts.push(...recentPosts);
          logger.info(
            `✅ Processed chunk #${chunkCount}: Added ${recentPosts.length} posts (within last year), reached year limit`,
          );
          break;
        }
      }

      // Add all posts from this chunk
      allPosts.push(...posts);

      logger.info(
        `✅ Processed chunk #${chunkCount}: Added ${posts.length} posts (total: ${allPosts.length})`,
      );

      // Break if no cursor for next page
      if (!response.data.cursor) {
        logger.info(`🔍 No more pages available after ${allPosts.length} total posts`);
        break;
      }

      ({ cursor } = response.data);
    } catch (error) {
      logger.error(`❌ Error fetching posts chunk #${chunkCount}: ${error || 'unknown'}`);
    }
  }

  // Log the reason for stopping
  if (allPosts.length >= MAX_POSTS) {
    logger.info(`🛑 Reached maximum post limit (${MAX_POSTS})`);
  } else if (reachedYearOld) {
    logger.info(`🕒 Stopped at posts from ${oldestPostDate.toISOString()} (one year limit)`);
  }

  logger.success(`✅ Found ${allPosts.length} posts within the last year`);
  return allPosts;
};

// A reference to a post, as used in a reply's parent/root
export type PostRef = { uri: string; cid: string };

// A post as returned by getPost(): a reference to it, plus its record
export type PostRecord = PostRef & { value?: unknown };

// The shape we care about within a post record: where its thread starts
type PostValue = { reply?: { root?: { uri?: unknown; cid?: unknown } } };

/**
 * Works out the parent and root refs to use when replying to a post.
 *
 * Per the atproto spec, every reply in a thread carries the *thread's* root,
 * not just the post it is replying to. If the post we're replying to is itself
 * a reply, its record already points at the real root, so we reuse that.
 * If it's a top-level post, then it is the root.
 *
 * Getting this wrong forks the conversation: the AppView groups thread views by
 * root, so a reply with the wrong root renders orphaned from the conversation
 * the person who tagged us is actually looking at.
 */
export const getReplyRefs = (replyTo: PostRecord): { parent: PostRef; root: PostRef } => {
  const parent: PostRef = { uri: replyTo.uri, cid: replyTo.cid };

  // Post records are loosely typed, so narrow before reading the thread root
  const record = replyTo.value as PostValue | undefined;
  const root = record?.reply?.root;

  if (typeof root?.uri === 'string' && typeof root.cid === 'string') {
    return { parent, root: { uri: root.uri, cid: root.cid } };
  }

  // No root on the record: the post we're replying to is the top of the thread
  return { parent, root: parent };
};

// Get a post by URI
export const getPost = async (agent: BskyAgent, uri: string) => {
  try {
    // Parse the URI to get the repo and record key
    const uriParts = uri.split('/');
    if (uriParts.length < 5) {
      throw new Error(`Invalid URI format: ${uri}`);
    }

    // at://<repo>/<collection>/<rkey>
    const [repo, , rkey] = uriParts.slice(2);

    // Use the correct API method for getting a post
    const response = await agent.getPost({ repo, rkey });
    return response;
  } catch (error) {
    logger.error(`❌ Error getting post ${uri}\n\t- ${error || 'unknown'}`);
    return null;
  }
};

// Reply to a post.
// `replyTo` should be the post record as returned by getPost(), so that the
// thread root can be derived from it (see getReplyRefs).
export const replyToPost = async (agent: BskyAgent, replyTo: PostRecord, text: string) => {
  logger.info(`🗣️ Replying to ${replyTo.uri}...`);

  // Create facets for mentions in the text
  const facets: AppBskyRichtextFacet.Main[] = [];

  // Regular expression to find mentions in the text
  const mentionRegex = /@(?<handle>[a-zA-Z0-9.-]+)/gu;
  let match;

  while ((match = mentionRegex.exec(text)) !== null) {
    const handle = match.groups?.handle ?? '';
    const start = match.index;
    const end = start + match[0].length;

    try {
      // Handles are resolved one at a time as the regex walks the text
      // oxlint-disable-next-line no-await-in-loop
      const resolveResponse = await agent.resolveHandle({ handle });
      const { did } = resolveResponse.data;

      // Add facet for the mention
      facets.push({
        index: {
          byteStart: start,
          byteEnd: end,
        },
        features: [
          {
            $type: 'app.bsky.richtext.facet#mention',
            did,
          },
        ],
      } as AppBskyRichtextFacet.Main);
    } catch (error) {
      logger.error(`❌ Error resolving handle ${handle}\n\t- ${error || 'unknown'}`);
    }
  }

  // Set up the reply structure, keeping the bot's reply in the same thread
  const reply = getReplyRefs(replyTo);

  // Post with facets if any were created
  return agent.post({
    text,
    facets: facets.length > 0 ? facets : undefined,
    reply,
  });
};

// Get a profile by DID
export const getProfile = async (agent: BskyAgent, did: string) => {
  const response = await agent.getProfile({ actor: did });
  return response.data;
};
