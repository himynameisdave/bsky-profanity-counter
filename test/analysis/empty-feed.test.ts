import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppBskyActorDefs, BskyAgent } from '@atproto/api';
import type { Analysis, Mention } from '../../src/generated/prisma/client.js';
import type * as Db from '../../src/services/database.js';
import type * as Bsky from '../../src/services/bluesky.js';

// Runs processUnanalyzedMentions with the real getUserPosts and the real
// message, so the one year cutoff and the reply text are both covered

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

const bsky = vi.hoisted(() => ({
  replyToPost: vi.fn<typeof Bsky.replyToPost>(),
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
  replyToPost: bsky.replyToPost,
}));

const { processUnanalyzedMentions } = await import('../../src/analysis.js');

const HANDLE = 'quiet.bsky.social';
const EMPTY_WINDOW_MESSAGE = `No original posts found for @${HANDLE} in the last year to analyze.`;

const twoYearsAgo = () => {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 2);
  return date.toISOString();
};

const makeMention = (id: string): Mention => ({
  id,
  userHandle: HANDLE,
  did: `did:plc:${HANDLE}`,
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

// Runs one mention through, with the analysis table as a single row
const runMention = async (agent: BskyAgent, id: string) => {
  const pending = [makeMention(id)];
  db.getUnprocessedMentionsCount.mockImplementation(async () => pending.length);
  db.getUnprocessedMention.mockImplementation(async () => pending.shift() ?? null);
  await processUnanalyzedMentions(agent);
};

describe('processUnanalyzedMentions for a target with no posts in the last year', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    let stored: Analysis | null = null;
    db.findAnalysis.mockImplementation(async () => stored);
    db.createOrUpdateAnalysis.mockImplementation(async (data) => {
      const now = new Date();
      stored = { id: 'analysis', ...data, lastAnalyzedAt: now, createdAt: now, updatedAt: now };
      return stored;
    });
    bsky.replyToPost.mockResolvedValue({
      uri: 'at://did:plc:bot/app.bsky.feed.post/reply',
      cid: 'bafy-reply',
    });
  });

  it.each([
    { feed: 'is empty', items: [] },
    {
      feed: 'only has posts older than the cutoff',
      items: [{ post: { uri: 'at://p/old', record: { text: 'damn', createdAt: twoYearsAgo() } } }],
    },
  ])(
    'replies when their feed $feed, and serves a repeat request from the cache',
    async ({ items }) => {
      const getAuthorFeed = vi.fn<() => Promise<unknown>>(async () => ({ data: { feed: items } }));
      const agent = { getAuthorFeed } as unknown as BskyAgent;

      await runMention(agent, 'first');

      expect(db.createOrUpdateAnalysis).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ userHandle: HANDLE, totalPosts: 0, profanityCount: 0 }),
      );
      expect(bsky.replyToPost).toHaveBeenLastCalledWith(
        agent,
        expect.anything(),
        EMPTY_WINDOW_MESSAGE,
        { did: `did:plc:${HANDLE}`, handle: HANDLE },
      );
      expect(db.markMentionAsDone).toHaveBeenLastCalledWith(
        expect.objectContaining({ mentionId: 'first', analysisId: 'analysis' }),
      );

      await runMention(agent, 'second');

      expect(getAuthorFeed).toHaveBeenCalledOnce();
      expect(db.createOrUpdateAnalysis).toHaveBeenCalledOnce();
      expect(bsky.replyToPost).toHaveBeenCalledTimes(2);
      expect(bsky.replyToPost).toHaveBeenLastCalledWith(
        agent,
        expect.anything(),
        EMPTY_WINDOW_MESSAGE,
        { did: `did:plc:${HANDLE}`, handle: HANDLE },
      );
      expect(db.markMentionAsDone).toHaveBeenLastCalledWith(
        expect.objectContaining({ mentionId: 'second', analysisId: 'analysis' }),
      );
    },
  );

  it('pages past a page of only reposts instead of saying they have no posts', async () => {
    const reposts = Array.from({ length: 100 }, (_, n) => ({
      post: {
        uri: `at://p/repost-${n}`,
        record: { text: 'hi', createdAt: new Date().toISOString() },
      },
      reason: { $type: 'app.bsky.feed.defs#reasonRepost' },
    }));
    const original = {
      post: { uri: 'at://p/1', record: { text: 'oh shit', createdAt: new Date().toISOString() } },
    };
    const getAuthorFeed = vi.fn<(params: { cursor?: string }) => Promise<unknown>>(
      async ({ cursor }) =>
        cursor ? { data: { feed: [original] } } : { data: { feed: reposts, cursor: 'page-2' } },
    );
    const agent = { getAuthorFeed } as unknown as BskyAgent;

    await runMention(agent, 'first');

    expect(getAuthorFeed).toHaveBeenCalledTimes(2);
    expect(db.createOrUpdateAnalysis).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userHandle: HANDLE, totalPosts: 1, profanityCount: 1 }),
    );
    const firstReply = bsky.replyToPost.mock.lastCall?.[2];
    expect(firstReply).toContain('has swears');

    await runMention(agent, 'second');

    expect(getAuthorFeed).toHaveBeenCalledTimes(2);
    expect(bsky.replyToPost).toHaveBeenCalledTimes(2);
    expect(bsky.replyToPost).toHaveBeenLastCalledWith(agent, expect.anything(), firstReply, {
      did: `did:plc:${HANDLE}`,
      handle: HANDLE,
    });
  });
});
