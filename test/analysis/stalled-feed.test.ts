import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BskyAgent } from '@atproto/api';
import type { Mention } from '@prisma/client';

// Runs processUnanalyzedMentions with the real getUserPosts, so a feed request
// that stalls goes through the real per-attempt deadline and retries

vi.hoisted(() => {
  // The bluesky service throws at import time without credentials
  process.env.BLUESKY_IDENTIFIER ||= 'test.bot';
  process.env.BLUESKY_PASSWORD ||= 'test-password';
});

const db = vi.hoisted(() => ({
  getUnprocessedMentionsCount: vi.fn<() => Promise<number>>(),
  getUnprocessedMention: vi.fn<() => Promise<unknown>>(),
  findFreshAnalysis: vi.fn<() => Promise<unknown>>(),
  createOrUpdateAnalysis: vi.fn<() => Promise<unknown>>(),
  markMentionAsDone: vi.fn<(args: { mentionId: string }) => Promise<unknown>>(),
  markMentionAsFailed: vi.fn<(mentionId: string) => Promise<unknown>>(),
}));

vi.mock(import('../../src/services/database.js'), () => db);
vi.mock(import('../../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));
vi.mock(import('../../src/services/bluesky.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  getProfile: vi.fn<(agent: unknown, handle: string) => Promise<{ did: string }>>(
    async (_agent, handle) => ({ did: `did:plc:${handle}` }),
  ),
  getPost: vi.fn<() => Promise<unknown>>(async () => ({
    uri: 'at://did:plc:someone/app.bsky.feed.post/abc',
  })),
  replyToPost: vi.fn<() => Promise<unknown>>(async () => ({
    uri: 'at://did:plc:bot/app.bsky.feed.post/reply',
  })),
}));

const { processUnanalyzedMentions } = await import('../../src/analysis.js');
const { MAX_FEED_PAGE_ATTEMPTS } = await import('../../src/services/bluesky.js');

const STALLED_DID = 'did:plc:stalled.example.com';

const makeMention = (id: string, userHandle: string): Mention => ({
  id,
  userHandle,
  postId: id,
  postUrl: `at://did:plc:someone/app.bsky.feed.post/${id}`,
  isReply: false,
  status: 'ANALYZING',
  attempts: 1,
  firstAttemptedAt: new Date(),
  replyPostId: null,
  replyUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  analysisId: null,
});

describe('processUnanalyzedMentions with a feed request that stalls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    db.findFreshAnalysis.mockResolvedValue(null);
    db.createOrUpdateAnalysis.mockResolvedValue({ id: 'analysis' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out every attempt at the stalled feed, then replies to the next mention', async () => {
    const pending = [
      makeMention('stalled', 'stalled.example.com'),
      makeMention('healthy', 'someone.bsky.social'),
    ];
    db.getUnprocessedMentionsCount.mockImplementation(async () => pending.length);
    db.getUnprocessedMention.mockImplementation(async () => pending.shift() ?? null);

    const stalledSignals: AbortSignal[] = [];
    const getAuthorFeed = vi.fn<
      (params: { actor: string }, opts?: { signal?: AbortSignal }) => Promise<unknown>
    >(async ({ actor }, opts) => {
      if (actor !== STALLED_DID) {
        return {
          data: {
            feed: [{ post: { uri: 'at://p/1', record: { createdAt: new Date().toISOString() } } }],
          },
        };
      }
      // Never answers. Only ends if the request is aborted.
      const signal = opts?.signal;
      if (signal) {
        stalledSignals.push(signal);
      }
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(signal.reason);
        });
      });
    });
    const agent = { getAuthorFeed } as unknown as BskyAgent;

    const run = processUnanalyzedMentions(agent);
    await vi.runAllTimersAsync();
    await run;

    expect(stalledSignals).toHaveLength(MAX_FEED_PAGE_ATTEMPTS);
    expect(stalledSignals.every((signal) => signal.aborted)).toBe(true);
    expect(db.markMentionAsDone).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ mentionId: 'healthy' }),
    );
  });
});
