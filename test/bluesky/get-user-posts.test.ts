import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { XRPCError, type BskyAgent } from '@atproto/api';
import { describeError } from '../../src/errors.js';

vi.mock(import('../../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));

const {
  getUserPosts,
  MAX_FEED_PAGE_ATTEMPTS,
  FEED_RETRY_BASE_DELAY_MS,
  FEED_PAGE_TIMEOUT_MS,
  MAX_RATE_LIMIT_WAIT_MS,
} = await import('../../src/services/bluesky.js');

const DID = 'did:plc:someone';

type FeedResponse = { data: { feed: unknown[]; cursor?: string } };
type FeedHandler = (
  cursor: string | undefined,
  signal: AbortSignal | undefined,
) => Promise<FeedResponse>;

// What @atproto/api throws when one post in a page breaks the lexicon: a
// generic message, with the field that was actually wrong in the cause
const makeInvalidResponseError = () =>
  new Error('The server gave an invalid response and may be out of date.', {
    cause: new Error(
      'Output/feed/13/post/embed/record/embeds/0/alt must not be longer than 1000 graphemes',
    ),
  });

// A page of recent posts, so we never stop early at the one year cutoff
const makePage = (id: string, cursor?: string): FeedResponse => ({
  data: {
    feed: [1, 2].map((n) => ({
      post: {
        uri: `at://${DID}/app.bsky.feed.post/${id}-${n}`,
        record: { createdAt: new Date().toISOString() },
      },
    })),
    cursor,
  },
});

// Before the fix, a failing page was retried forever, with no delay between
// attempts, which would hang this test. After this many calls the fake feed
// claims to be empty, so a regression fails the test instead of hanging it.
const RUNAWAY_CALL_LIMIT = 50;

const makeAgent = (handler: FeedHandler) => {
  let calls = 0;
  const getAuthorFeed = vi.fn<
    (params: { cursor?: string }, opts?: { signal?: AbortSignal }) => Promise<FeedResponse>
  >(async ({ cursor }, opts) => {
    calls++;
    if (calls > RUNAWAY_CALL_LIMIT) {
      return { data: { feed: [] } };
    }
    return handler(cursor, opts?.signal);
  });

  return { agent: { getAuthorFeed } as unknown as BskyAgent, getAuthorFeed };
};

// A request that stalls: it never answers, and only ends if its signal aborts
const stalledRequest = (signal?: AbortSignal) =>
  new Promise<FeedResponse>((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(signal.reason);
    });
  });

// Captures how a promise ends, so a rejection is never left unhandled while the
// test is still moving the fake clock along
const capture = async <T>(promise: Promise<T>) => {
  try {
    return { value: await promise, error: undefined };
  } catch (error) {
    return { value: undefined, error };
  }
};

// Lets getUserPosts sleep through its retry backoff without real waiting
const settle = async <T>(promise: Promise<T>) => {
  const outcome = capture(promise);
  await vi.runAllTimersAsync();
  return outcome;
};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

// A post Bluesky saw `minutes` ago
const postFrom = (id: string, minutes: number) => ({
  post: {
    uri: `at://${DID}/app.bsky.feed.post/${id}`,
    indexedAt: minutesAgo(minutes),
    record: { createdAt: minutesAgo(minutes) },
  },
});

describe(getUserPosts, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a page that fails every time, instead of retrying forever', async () => {
    const { agent, getAuthorFeed } = makeAgent(async () => {
      throw makeInvalidResponseError();
    });

    const { value, error } = await settle(getUserPosts(agent, DID));

    expect(value).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Gave up fetching posts chunk #1/u);
    expect(getAuthorFeed).toHaveBeenCalledTimes(MAX_FEED_PAGE_ATTEMPTS);
  });

  it('does not retry a clearly terminal blocked feed', async () => {
    const blocked = new XRPCError(400, 'BlockedActor', 'Blocked by target');
    const { agent, getAuthorFeed } = makeAgent(async () => {
      throw blocked;
    });
    const { error } = await settle(getUserPosts(agent, DID));
    expect(error).toBe(blocked);
    expect(getAuthorFeed).toHaveBeenCalledOnce();
  });

  it('keeps the original error, and the field that broke validation, as the cause', async () => {
    const { agent } = makeAgent(async () => {
      throw makeInvalidResponseError();
    });

    const { error } = await settle(getUserPosts(agent, DID));

    expect(describeError(error)).toContain('embeds/0/alt must not be longer than 1000 graphemes');
  });

  it('retries a page that fails once, with the same cursor, then carries on', async () => {
    let failedOnce = false;
    const { agent, getAuthorFeed } = makeAgent(async (cursor) => {
      if (!cursor) {
        return makePage('first', 'next');
      }
      if (!failedOnce) {
        failedOnce = true;
        throw new Error('Internal Server Error');
      }
      return makePage('second');
    });

    const { value: posts, error } = await settle(getUserPosts(agent, DID));

    expect(error).toBeUndefined();
    expect(posts).toHaveLength(4);
    expect(getAuthorFeed.mock.calls.map(([params]) => params.cursor)).toStrictEqual([
      undefined,
      'next',
      'next',
    ]);
  });

  it('counts attempts per page, so occasional failures across many pages are fine', async () => {
    const failuresSoFar = new Map<string, number>();
    const pages: Record<string, FeedResponse> = {
      start: makePage('a', 'b'),
      b: makePage('b', 'c'),
      c: makePage('c'),
    };

    // Every page fails as many times as it can and still succeed
    const { agent } = makeAgent(async (cursor = 'start') => {
      const failures = failuresSoFar.get(cursor) ?? 0;
      if (failures < MAX_FEED_PAGE_ATTEMPTS - 1) {
        failuresSoFar.set(cursor, failures + 1);
        throw new Error('Upstream Failure');
      }
      return pages[cursor];
    });

    const { value: posts, error } = await settle(getUserPosts(agent, DID));

    expect(error).toBeUndefined();
    expect(posts).toHaveLength(6);
  });

  it('backs off between retries rather than hammering the API', async () => {
    const { agent, getAuthorFeed } = makeAgent(async () => {
      throw new Error('Rate Limit Exceeded');
    });

    const outcome = capture(getUserPosts(agent, DID));

    await vi.advanceTimersByTimeAsync(0);
    expect(getAuthorFeed).toHaveBeenCalledOnce();

    // The first retry waits the base delay...
    await vi.advanceTimersByTimeAsync(FEED_RETRY_BASE_DELAY_MS - 1);
    expect(getAuthorFeed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(getAuthorFeed).toHaveBeenCalledTimes(2);

    // ...and the next waits twice as long
    await vi.advanceTimersByTimeAsync(FEED_RETRY_BASE_DELAY_MS * 2 - 1);
    expect(getAuthorFeed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(getAuthorFeed).toHaveBeenCalledTimes(3);

    const { error } = await outcome;
    expect(error).toBeInstanceOf(Error);
  });

  it('aborts an attempt that never answers, and gives up once every attempt has timed out', async () => {
    const signals: AbortSignal[] = [];
    const { agent, getAuthorFeed } = makeAgent(async (_cursor, signal) => {
      if (signal) {
        signals.push(signal);
      }
      return stalledRequest(signal);
    });

    const { error } = await settle(getUserPosts(agent, DID));

    expect((error as Error).message).toMatch(/Gave up fetching posts chunk #1/u);
    expect(describeError(error)).toContain(`Timed out after ${FEED_PAGE_TIMEOUT_MS}ms`);
    expect(getAuthorFeed).toHaveBeenCalledTimes(MAX_FEED_PAGE_ATTEMPTS);
    // Each stalled request was torn down, not just left behind
    expect(signals).toHaveLength(MAX_FEED_PAGE_ATTEMPTS);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('aborts an attempt only once its deadline has passed', async () => {
    let signal: AbortSignal | undefined;
    const { agent } = makeAgent(async (_cursor, attemptSignal) => {
      signal ??= attemptSignal;
      return stalledRequest(attemptSignal);
    });

    const outcome = capture(getUserPosts(agent, DID));

    await vi.advanceTimersByTimeAsync(FEED_PAGE_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);

    await vi.runAllTimersAsync();
    await outcome;
  });

  it('still gives up on a stalled request that ignores its abort signal', async () => {
    const { agent, getAuthorFeed } = makeAgent(async () => stalledRequest());

    const { error } = await settle(getUserPosts(agent, DID));

    expect((error as Error).message).toMatch(/Gave up fetching posts chunk #1/u);
    expect(getAuthorFeed).toHaveBeenCalledTimes(MAX_FEED_PAGE_ATTEMPTS);
  });

  it('waits for a rate limit to reset before retrying, then gives up if it never lifts', async () => {
    const resetInMs = 10_000;
    const { agent, getAuthorFeed } = makeAgent(async () => {
      throw new XRPCError(429, 'RateLimitExceeded', 'Rate Limit Exceeded', {
        'ratelimit-reset': String((Date.now() + resetInMs) / 1000),
      });
    });

    const outcome = capture(getUserPosts(agent, DID));

    await vi.advanceTimersByTimeAsync(resetInMs - 1);
    expect(getAuthorFeed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(getAuthorFeed).toHaveBeenCalledTimes(2);

    await vi.runAllTimersAsync();
    const { error } = await outcome;
    expect((error as Error).message).toMatch(/Gave up fetching posts chunk #1/u);
    expect(getAuthorFeed).toHaveBeenCalledTimes(MAX_FEED_PAGE_ATTEMPTS);
  });

  it("doesn't wait longer than the cap for a rate limit that resets far in the future", async () => {
    const { agent, getAuthorFeed } = makeAgent(async () => {
      throw new XRPCError(429, 'RateLimitExceeded', 'Rate Limit Exceeded', {
        'ratelimit-reset': String((Date.now() + 60 * 60 * 1000) / 1000),
      });
    });

    const outcome = capture(getUserPosts(agent, DID));

    await vi.advanceTimersByTimeAsync(MAX_RATE_LIMIT_WAIT_MS);
    expect(getAuthorFeed).toHaveBeenCalledTimes(2);

    await vi.runAllTimersAsync();
    await outcome;
  });

  it('only gets the posts after the checkpoint, stopping at the first one sorted before it', async () => {
    const pages: Record<string, FeedResponse> = {
      start: {
        data: {
          feed: [postFrom('new', 1), postFrom('tied-new', 10), postFrom('tied-seen', 10)],
          cursor: 'next',
        },
      },
      next: { data: { feed: [postFrom('older', 15)], cursor: 'more' } },
    };
    const { agent, getAuthorFeed } = makeAgent(async (cursor = 'start') => pages[cursor]);
    const checkpoint = {
      sortTime: Date.parse(minutesAgo(10)),
      uris: [`at://${DID}/app.bsky.feed.post/tied-seen`],
    };

    const { value: posts } = await settle(getUserPosts(agent, DID, checkpoint));

    expect(posts?.map((p) => p.uri)).toStrictEqual([
      `at://${DID}/app.bsky.feed.post/new`,
      `at://${DID}/app.bsky.feed.post/tied-new`,
    ]);
    // The first page was all at or after the checkpoint, so there could be more on the next
    expect(getAuthorFeed).toHaveBeenCalledTimes(2);
  });
});
