import { BskyAgent, AppBskyFeedDefs, AppBskyRichtextFacet } from '@atproto/api';
import dotenv from 'dotenv';
import * as logger from './logger.js';
import type { Notification } from '../types.js';

dotenv.config();

// Environment variables
const BLUESKY_IDENTIFIER = process.env.BLUESKY_IDENTIFIER;
const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD;

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
  let allNotifications: Notification[] = [];

  logger.info('🔍 Getting notifications...');

  // Iterate through all pages of notifications
  // Recursive function to fetch notifications page by page
  const fetchNotificationsPage = async (currentCursor?: string): Promise<void> => {
    const response = await agent.listNotifications({
      limit: 100,
      cursor: currentCursor
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

  if (allNotifications.length) {
    logger.info(`📥 Found ${allNotifications.length} notifications`);
  } else {
    logger.info('❌ No notifications found');
    return [];
  }

  // Filter for mentions in replies that we haven't processed yet
  const unreadMentions = allNotifications.filter(
    (notification) =>
      notification.reason === 'mention' &&
      !notification.isRead
  );

  logger.info(`📤 Found ${unreadMentions.length} unread mentions`);

  return unreadMentions;
};

//  Marks all notifications as read
export const markNotificationsAsRead = async (agent: BskyAgent) => {
  const seenAt = new Date().toISOString();
  await agent.app.bsky.notification.updateSeen({
    seenAt: seenAt
  });
  logger.success(`📑 Successfully marked notifications as read up to ${seenAt}`);
};

// Get user's posts
export const getUserPosts = async (agent: BskyAgent, did: string): Promise<AppBskyFeedDefs.PostView[]> => {
  const allPosts: AppBskyFeedDefs.PostView[] = [];
  let cursor;
  const MAX_POSTS = 25_000; // Maximum number of posts to retrieve
  const CHUNK_SIZE = 100;  // Size of each chunk (API limit)
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
      if (posts.length > 0) {
        const lastPost = posts[posts.length - 1];
        const lastPostRecord = lastPost.record as any;

        if (lastPostRecord?.createdAt) {
          const postDate = new Date(lastPostRecord.createdAt);
          oldestPostDate = postDate;

          // Check if we've reached posts older than one year
          if (postDate < ONE_YEAR_AGO) {
            reachedYearOld = true;
            logger.info(`🕒 Reached posts older than one year (${postDate.toISOString()})`);

            // Filter out posts older than one year
            const recentPosts = posts.filter(post => {
              const record = post.record as any;
              return record?.createdAt && new Date(record.createdAt) >= ONE_YEAR_AGO;
            });

            allPosts.push(...recentPosts);
            logger.info(`✅ Processed chunk #${chunkCount}: Added ${recentPosts.length} posts (within last year), reached year limit`);
            break;
          }
        }
      }

      // Add all posts from this chunk
      allPosts.push(...posts);

      logger.info(`✅ Processed chunk #${chunkCount}: Added ${posts.length} posts (total: ${allPosts.length})`);

      // Break if no cursor for next page
      if (!response.data.cursor) {
        logger.info(`🔍 No more pages available after ${allPosts.length} total posts`);
        break;
      }

      cursor = response.data.cursor;

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

// Get a post by URI
export const getPost = async (agent: BskyAgent, uri: string) => {
  try {
    // Parse the URI to get the repo and record key
    const uriParts = uri.split('/');
    if (uriParts.length < 5) {
      throw new Error(`Invalid URI format: ${uri}`);
    }

    const repo = uriParts[2];
    const rkey = uriParts[4];

    // Use the correct API method for getting a post
    const response = await agent.getPost({ repo, rkey });
    return response;
  } catch (error) {
    logger.error(`❌ Error getting post ${uri}\n\t- ${error || 'unknown'}`);
    return null;
  }
};

// Reply to a post
export const replyToPost = async (
  agent: BskyAgent,
  replyTo: { uri: string; cid: string },
  text: string,
  rootUri?: string,
  rootCid?: string
) => {
  logger.info(`🗣️ Replying to ${replyTo.uri}...`);

  // Create facets for mentions in the text
  const facets: AppBskyRichtextFacet.Main[] = [];

  // Regular expression to find mentions in the text
  const mentionRegex = /@([a-zA-Z0-9.-]+)/g;
  let match;

  while ((match = mentionRegex.exec(text)) !== null) {
    const handle = match[1];
    const start = match.index;
    const end = start + match[0].length;

    try {
      // Resolve the handle to a DID
      const resolveResponse = await agent.resolveHandle({ handle });
      const did = resolveResponse.data.did;

      // Add facet for the mention
      facets.push({
        index: {
          byteStart: start,
          byteEnd: end
        },
        features: [
          {
            $type: 'app.bsky.richtext.facet#mention',
            did
          }
        ]
      } as AppBskyRichtextFacet.Main);
    } catch (error) {
      logger.error(`❌ Error resolving handle ${handle}\n\t- ${error || 'unknown'}`);
    }
  }

  // Set up the reply structure
  const reply: any = {
    parent: replyTo
  };

  // If rootUri and rootCid are provided, use them for the root
  // Otherwise, use the parent as the root (for direct replies to top-level posts)
  if (rootUri && rootCid) {
    reply.root = {
      uri: rootUri,
      cid: rootCid
    };
  } else {
    reply.root = replyTo;
  }

  // Post with facets if any were created
  return agent.post({
    text,
    facets: facets.length > 0 ? facets : undefined,
    reply: reply
  });
};

// Delete a post by URI
export const deletePost = async (agent: BskyAgent, uri: string): Promise<boolean> => {
  try {
    await agent.deletePost(uri);
    logger.success(`🗑️ Successfully deleted post: ${uri}`);
    return true;
  } catch (error) {
    logger.error(`❌ Error deleting post ${uri}\n\t- ${error || 'unknown'}`);
    return false;
  }
};

// Get a profile by DID
export const getProfile = async (agent: BskyAgent, did: string) => {
  const response = await agent.getProfile({ actor: did });
  return response.data;
};
