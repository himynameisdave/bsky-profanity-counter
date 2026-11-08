import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BskyAgent } from '@atproto/api';
import type { Mention } from '@prisma/client';

// Runs processUnanalyzedMentions with the real getUserPosts and the real
// message, so the one year cutoff and the reply text are both covered

vi.hoisted(() => {
  // The bluesky service throws at import time without credentials
  process.env.BLUESKY_IDENTIFIER ||= 'test.bot';
  process.env.BLUESKY_PASSWORD ||= 'test-password';
});

const db = vi.hoisted(() => ({
  getUnprocessedMentionsCount: vi.fn<() => Promise<number>>(),
  getUnprocessedMention: vi.fn<() => Promise<unknown>>(),
  findFreshAnalysis: vi.fn<() => Promise<unknown>>(),
  createOrUpdateAnalysis: vi.fn<(data: Record<string, unknown>) => Promise<unknown>>(),
  markMentionAsDone: vi.fn<(args: { mentionId: string }) => Promise<unknown>>(),
  markMentionAsFailed: vi.fn<(mentionId: string) => Promise<unknown>>(),
}));

const bsky = vi.hoisted(() => ({
  replyToPost: vi.fn<(agent: unknown, post: unknown, text: string) => Promise<unknown>>(),
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

    let stored: Record<string, unknown> | null = null;
    db.findFreshAnalysis.mockImplementation(async () => stored);
    db.createOrUpdateAnalysis.mockImplementation(async (data) => {
      stored = { id: 'analysis', ...data };
      return stored;
    });
    bsky.replyToPost.mockResolvedValue({ uri: 'at://did:plc:bot/app.bsky.feed.post/reply' });
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
      );
      expect(db.markMentionAsDone).toHaveBeenLastCalledWith(
        expect.objectContaining({ mentionId: 'second', analysisId: 'analysis' }),
      );
    },
  );
});
