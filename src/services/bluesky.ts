import {
  AppBskyNotificationListNotifications,
  BskyAgent,
  XRPCError,
  type AppBskyFeedDefs,
  type AppBskyRichtextFacet,
} from '@atproto/api';
import * as logger from './logger.js';
import { describeError } from '../errors.js';
import { BLUESKY_SERVICE, MAX_POSTS } from '../config.js';
import type { BlueskyCredentials } from '../config.js';
import type { Notification } from '../types.js';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs a request with a deadline. When the deadline passes, the request's
 * signal is aborted, which normally tears it down, and the returned promise
 * rejects either way. Don't rely on the abort alone: in testing on Node 22,
 * fetch sometimes ignored it for a request that had been pending a while.
 */
export const withTimeout = async <T>(
  ms: number,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Timed out after ${ms}ms`);
      controller.abort(error);
      reject(error);
    }, ms);
  });

  try {
    return await Promise.race([request(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

// How long any other single request to Bluesky may take before we give up on
// it. They normally come back in well under a second. Without a deadline, one
// stalled request holds up the whole run until the workflow timeout kills it.
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Whether Bluesky says the record we asked for doesn't exist. Checked against
 * the live API: a deleted post is `RecordNotFound`, and a post whose account is
 * gone is `InvalidRequest` with "Could not find repo". Anything else (a 500, a
 * timeout, a network blip) might work next time, so it isn't "not found".
 */
export const isNotFound = (error: unknown): boolean =>
  error instanceof XRPCError &&
  (error.error === 'RecordNotFound' ||
    (error.error === 'InvalidRequest' && error.message.startsWith('Could not find repo')));

// Create and authenticate the Bluesky agent
export const createAgent = async ({
  identifier,
  password,
}: BlueskyCredentials): Promise<BskyAgent> => {
  const agent = new BskyAgent({
    service: BLUESKY_SERVICE,
  });

  await withTimeout(REQUEST_TIMEOUT_MS, () => agent.login({ identifier, password }));

  logger.success(
    `🔑 Successfully authenticated with Bluesky as ${agent.session?.handle} (${agent.session?.did})`,
  );

  return agent;
};

// Most pages of notifications we're willing to walk in a single run
const MAX_NOTIFICATION_PAGES = 25;
// Belt-and-suspenders cutoff, in case we never hit a fully-read page
const NOTIFICATION_LOOKBACK_DAYS = 7;
const NOTIFICATIONS_PER_PAGE = 100;

export type MentionsBatch = {
  // The unread mentions we still owe a reply to
  mentions: Notification[];
  // The `indexedAt` of the newest notification in the batch we actually fetched.
  // This is what `seenAt` should be derived from — see markNotificationsAsRead.
  // `null` when there was nothing to fetch.
  latestIndexedAt: string | null;
};

const toTime = (indexedAt: string) => Date.parse(indexedAt);

/**
 * Fetches one page of notifications.
 *
 * `@atproto/api` rejects a whole page when any one notification in it breaks
 * the lexicon (ie: an author's display name is a grapheme over the limit), and
 * Bluesky does serve records like that. Since that notification stays in the
 * list, every run would fail on it until it fell out of the lookback window.
 * So when that happens we check the notifications one at a time and drop the
 * ones that don't parse.
 */
const getNotificationsPage = async (
  agent: BskyAgent,
  cursor: string | undefined,
): Promise<{ notifications: Notification[]; cursor?: string }> => {
  try {
    const response = await withTimeout(REQUEST_TIMEOUT_MS, (signal) =>
      agent.listNotifications({ limit: NOTIFICATIONS_PER_PAGE, cursor }, { signal }),
    );
    return response.data;
  } catch (error) {
    // XRPCInvalidResponseError isn't exported by @atproto/api, but it's the
    // only XRPCError that carries the response body
    const body =
      error instanceof XRPCError && 'responseBody' in error
        ? (error.responseBody as { notifications?: unknown; cursor?: unknown } | undefined)
        : undefined;

    if (!Array.isArray(body?.notifications)) {
      throw error;
    }

    logger.warn(`⚠️ A page of notifications failed validation: ${describeError(error)}`);

    const notifications: Notification[] = [];
    for (const raw of body.notifications) {
      const result = AppBskyNotificationListNotifications.validateNotification(raw);
      if (result.success) {
        notifications.push(result.value);
      } else {
        const uri = (raw as { uri?: unknown } | null)?.uri;
        logger.warn(`⚠️ Skipping notification ${String(uri)}: ${describeError(result.error)}`);
      }
    }

    return {
      notifications,
      cursor: typeof body.cursor === 'string' ? body.cursor : undefined,
    };
  }
};

// Get notifications where the bot is mentioned
export const getMentions = async (agent: BskyAgent): Promise<MentionsBatch> => {
  logger.info('🔍 Getting notifications...');

  const cutoff = Date.now() - NOTIFICATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const mentions: Notification[] = [];
  let latestIndexedAt: string | null = null;
  let fetchedCount = 0;
  let cursor: string | undefined;
  let page = 0;
  let keepPaging = true;
  let stoppedEarly = false;
  let unreadOnLastPage = 0;

  // Notifications come back newest-first, so we only page far enough back to
  // cover everything that is still unread — not the account's whole history.
  while (keepPaging && page < MAX_NOTIFICATION_PAGES) {
    page++;

    // Pagination is inherently sequential: each request needs the previous cursor
    // oxlint-disable-next-line no-await-in-loop
    const response = await getNotificationsPage(agent, cursor);

    const { notifications } = response;

    if (notifications.length === 0) {
      keepPaging = false;
      break;
    }

    fetchedCount += notifications.length;

    for (const notification of notifications) {
      if (!latestIndexedAt || toTime(notification.indexedAt) > toTime(latestIndexedAt)) {
        latestIndexedAt = notification.indexedAt;
      }

      if (notification.reason === 'mention' && !notification.isRead) {
        mentions.push(notification);
      }
    }

    const oldestOnPage = notifications[notifications.length - 1];
    unreadOnLastPage = notifications.filter((notification) => !notification.isRead).length;

    if (unreadOnLastPage === 0) {
      // Everything on this page has been read, so everything older has been too
      logger.info(`🛑 Stopping after page #${page}: it was entirely read`);
      keepPaging = false;
    } else if (toTime(oldestOnPage.indexedAt) < cutoff) {
      stoppedEarly = response.cursor !== undefined;
      logger.info(
        `🕒 Stopping after page #${page}: reached notifications older than ${NOTIFICATION_LOOKBACK_DAYS} days`,
      );
      keepPaging = false;
    } else if (response.cursor) {
      ({ cursor } = response);
    } else {
      keepPaging = false;
    }
  }

  if (keepPaging && page === MAX_NOTIFICATION_PAGES) {
    stoppedEarly = true;
  }

  // We mark everything up to the newest notification as read, so any unread
  // mentions on the pages we didn't fetch are lost. We don't know how many
  // there are, but unread notifications on the last page mean there likely are.
  if (stoppedEarly) {
    logger.warn(
      `⚠️ Stopped paging after ${page} page(s) with ${unreadOnLastPage} unread notifications on the last one. Older unread mentions, if any, will be marked read without a reply`,
    );
  }

  if (fetchedCount === 0) {
    logger.info('❌ No notifications found');
    return { mentions: [], latestIndexedAt: null };
  }

  logger.info(`📥 Fetched ${fetchedCount} notifications across ${page} page(s)`);
  logger.info(`📤 Found ${mentions.length} unread mentions`);

  return { mentions, latestIndexedAt };
};

// Marks notifications as read up to (and including) the given timestamp.
// Always pass the `indexedAt` of a notification we actually fetched — using
// "now" would mark anything that landed mid-run as read without us ever having
// seen it, and those mentions would never get a reply.
export const markNotificationsAsRead = async (agent: BskyAgent, seenAt: string) => {
  await withTimeout(REQUEST_TIMEOUT_MS, (signal) =>
    agent.app.bsky.notification.updateSeen({ seenAt }, { signal }),
  );
  logger.success(`📑 Successfully marked notifications as read up to ${seenAt}`);
};

// Post records are loosely typed, so narrow before reading `createdAt`
const getPostDate = (post: AppBskyFeedDefs.PostView | undefined): Date | null => {
  const record = post?.record as { createdAt?: unknown } | undefined;
  return typeof record?.createdAt === 'string' ? new Date(record.createdAt) : null;
};

// Posts per page of an author feed (the API's limit)
const FEED_PAGE_SIZE = 100;
// How many times we'll ask for a single page of a feed before giving up on it
export const MAX_FEED_PAGE_ATTEMPTS = 3;
// Wait before the first retry, doubled for each retry after that
export const FEED_RETRY_BASE_DELAY_MS = 1000;
// How long one attempt at a page may take before we abort it. Pages normally
// come back in well under a second. Even when every attempt times out, giving
// up on a page takes 3 × 15s plus 3s of backoff, about 48s, well inside the
// workflow's 15 minute timeout, so the failure is handled before the job is killed.
export const FEED_PAGE_TIMEOUT_MS = 15_000;

/**
 * Fetches one page of an author feed, retrying with backoff if it fails.
 *
 * Throws once every attempt has failed. Retrying forever is not an option:
 * some failures happen on every attempt, and an endless retry loop hangs the
 * whole run. For example, @atproto/api rejects a whole page when any post in it
 * fails lexicon validation, and Bluesky returns that same post every time.
 * Each attempt has a deadline too, so a request that stalls counts as a failed
 * attempt instead of hanging forever.
 */
const getAuthorFeedPage = async (
  agent: BskyAgent,
  did: string,
  cursor: string | undefined,
  chunk: number,
) => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_FEED_PAGE_ATTEMPTS; attempt++) {
    try {
      // Retries are deliberately sequential, each one waits out the last
      // oxlint-disable-next-line no-await-in-loop
      return await withTimeout(FEED_PAGE_TIMEOUT_MS, (signal) =>
        agent.getAuthorFeed({ actor: did, limit: FEED_PAGE_SIZE, cursor }, { signal }),
      );
    } catch (error) {
      lastError = error;
      logger.warn(
        `⚠️ Error fetching posts chunk #${chunk} (attempt ${attempt}/${MAX_FEED_PAGE_ATTEMPTS}): ${describeError(error)}`,
      );

      if (attempt < MAX_FEED_PAGE_ATTEMPTS) {
        // oxlint-disable-next-line no-await-in-loop
        await sleep(FEED_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }

  throw new Error(
    `Gave up fetching posts chunk #${chunk} for ${did} after ${MAX_FEED_PAGE_ATTEMPTS} attempts`,
    { cause: lastError },
  );
};

/**
 * Gets a user's posts from the last year, up to MAX_POSTS.
 * Throws if a page of their feed can't be fetched (see getAuthorFeedPage).
 */
export const getUserPosts = async (
  agent: BskyAgent,
  did: string,
): Promise<AppBskyFeedDefs.PostView[]> => {
  const allPosts: AppBskyFeedDefs.PostView[] = [];
  let cursor: string | undefined;
  const ONE_YEAR_AGO = new Date();
  ONE_YEAR_AGO.setFullYear(ONE_YEAR_AGO.getFullYear() - 1);

  logger.info(`🔍 Getting posts for ${did} (up to ${MAX_POSTS} posts from the last year)...`);

  let chunkCount = 0;
  let oldestPostDate = new Date();
  let reachedYearOld = false;

  // Fetch posts in batches until we hit the max, reach a year old posts, or there are no more
  while (allPosts.length < MAX_POSTS && !reachedYearOld) {
    chunkCount++;

    // Pagination is inherently sequential: each request needs the previous cursor
    // oxlint-disable-next-line no-await-in-loop
    const response = await getAuthorFeedPage(agent, did, cursor, chunkCount);

    const posts = response.data.feed.reduce((acc, item) => {
      // Only include items that are not reposts
      if (!item.reason) {
        acc.push(item.post);
      }
      return acc;
    }, [] as AppBskyFeedDefs.PostView[]);

    if (posts.length === 0) {
      // A page of only reposts isn't the end of the feed, so keep going while there's a cursor.
      // shortcut: reposts aren't checked against the one year cutoff, so a long run of them is
      // paged through to the end; stop on the repost's `reason.indexedAt` if that gets slow.
      if (response.data.feed.length > 0 && response.data.cursor) {
        ({ cursor } = response.data);
        continue;
      }
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

/**
 * Gets a post by URI. Returns null if it's been deleted (or its account has),
 * and throws on anything else, so a temporary error gets retried instead of
 * being mistaken for a deleted post.
 */
export const getPost = async (agent: BskyAgent, uri: string): Promise<PostRecord | null> => {
  // at://<repo>/<collection>/<rkey>
  const [repo, , rkey] = uri.split('/').slice(2);
  if (!repo || !rkey) {
    throw new Error(`Invalid URI format: ${uri}`);
  }

  try {
    // agent.getPost doesn't take an abort signal, but the deadline still applies
    return await withTimeout(REQUEST_TIMEOUT_MS, () => agent.getPost({ repo, rkey }));
  } catch (error) {
    if (isNotFound(error)) {
      logger.warn(`⚠️ Post ${uri} no longer exists: ${describeError(error)}`);
      return null;
    }
    throw error;
  }
};

// The shape we care about within one of our own post records
type OwnPostValue = { createdAt?: unknown; reply?: { parent?: { uri?: unknown } } };

// Our own posts are listed newest first, a page at a time
const OWN_POSTS_PAGE_SIZE = 100;
// Way more replies than the bot posts within a mention's retry window
const MAX_OWN_POSTS_PAGES = 10;

/**
 * Finds a reply we've already posted to `parentUri`, looking back through our
 * own posts as far as `since`.
 *
 * Replying and marking a mention done are two steps, and a run can fail or be
 * killed between them. Checking this before replying again on a retry is what
 * stops the same person getting two replies. It reads our own repo directly,
 * so a reply we've only just posted shows up straight away.
 */
export const findOwnReply = async (
  agent: BskyAgent,
  parentUri: string,
  since: Date,
): Promise<PostRef | null> => {
  let cursor: string | undefined;

  for (let page = 1; page <= MAX_OWN_POSTS_PAGES; page++) {
    const pageCursor = cursor;
    // Pagination is inherently sequential: each request needs the previous cursor
    // oxlint-disable-next-line no-await-in-loop
    const { data } = await withTimeout(REQUEST_TIMEOUT_MS, (signal) =>
      agent.com.atproto.repo.listRecords(
        {
          repo: agent.assertDid,
          collection: 'app.bsky.feed.post',
          limit: OWN_POSTS_PAGE_SIZE,
          cursor: pageCursor,
        },
        { signal },
      ),
    );

    for (const record of data.records) {
      const value = record.value as OwnPostValue;

      if (value.reply?.parent?.uri === parentUri) {
        return { uri: record.uri, cid: record.cid };
      }

      if (typeof value.createdAt === 'string' && Date.parse(value.createdAt) < since.getTime()) {
        // Older than the first attempt at this mention, so nothing further back can be its reply
        return null;
      }
    }

    if (!data.cursor) {
      return null;
    }
    ({ cursor } = data);
  }

  // Better to give up on this attempt than risk replying twice
  throw new Error(
    `Couldn't rule out an earlier reply to ${parentUri}: checked ${MAX_OWN_POSTS_PAGES * OWN_POSTS_PAGE_SIZE} of our posts`,
  );
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
      const resolveResponse = await withTimeout(REQUEST_TIMEOUT_MS, (signal) =>
        agent.resolveHandle({ handle }, { signal }),
      );
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
      logger.error(`❌ Error resolving handle ${handle}\n\t- ${describeError(error)}`);
    }
  }

  // Set up the reply structure, keeping the bot's reply in the same thread
  const reply = getReplyRefs(replyTo);

  // Post with facets if any were created. If this times out, the post may still
  // go through; the retry checks for that before replying again (see findOwnReply).
  return withTimeout(REQUEST_TIMEOUT_MS, () =>
    agent.post({
      text,
      facets: facets.length > 0 ? facets : undefined,
      reply,
    }),
  );
};

// Get a profile by DID
export const getProfile = async (agent: BskyAgent, did: string) => {
  const response = await withTimeout(REQUEST_TIMEOUT_MS, (signal) =>
    agent.getProfile({ actor: did }, { signal }),
  );
  return response.data;
};
