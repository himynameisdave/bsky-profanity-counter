import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppBskyActorDefs, BskyAgent } from '@atproto/api';
import type { Analysis, Mention } from '../../src/generated/prisma/client.js';
import type * as Db from '../../src/services/database.js';
import type * as Bsky from '../../src/services/bluesky.js';

// Runs processUnanalyzedMentions with the real getUserPosts, so a feed request
// that stalls goes through the real per-attempt deadline and retries

const db = vi.hoisted(() => ({
  getUnprocessedMentionsCount: vi.fn<typeof Db.getUnprocessedMentionsCount>(),
  getUnprocessedMention: vi.fn<typeof Db.getUnprocessedMention>(),
  findAnalysis: vi.fn<typeof Db.findAnalysis>(),
  createOrUpdateAnalysis: vi.fn<typeof Db.createOrUpdateAnalysis>(),
  markMentionAsDone: vi.fn<typeof Db.markMentionAsDone>(),
  recordMentionError: vi.fn<typeof Db.recordMentionError>(),
  refreshTargetHandle: vi.fn<typeof Db.refreshTargetHandle>(),
  markMentionAsFailed: vi.fn<typeof Db.markMentionAsFailed>(),
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
  getProfile: vi.fn<typeof Bsky.getProfile>(
    async (_agent, did) =>
      ({ did, handle: did.slice('did:plc:'.length) }) as AppBskyActorDefs.ProfileViewDetailed,
  ),
  getPost: vi.fn<typeof Bsky.getPost>(async () => ({
    uri: 'at://did:plc:someone/app.bsky.feed.post/abc',
    cid: 'bafy-abc',
  })),
  replyToPost: vi.fn<typeof Bsky.replyToPost>(async () => ({
    uri: 'at://did:plc:bot/app.bsky.feed.post/reply',
    cid: 'bafy-reply',
  })),
}));

const { processUnanalyzedMentions } = await import('../../src/analysis.js');
const { MAX_FEED_PAGE_ATTEMPTS } = await import('../../src/services/bluesky.js');

const STALLED_DID = 'did:plc:stalled.example.com';

const makeMention = (id: string, userHandle: string): Mention => ({
  id,
  userHandle,
  did: `did:plc:${userHandle}`,
  lastError: null,
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
    db.findAnalysis.mockResolvedValue(null);
    db.createOrUpdateAnalysis.mockResolvedValue({ id: 'analysis' } as Analysis);
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
