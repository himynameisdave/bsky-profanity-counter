import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BskyAgent } from '@atproto/api';
import type { Mention } from '@prisma/client';

const db = vi.hoisted(() => ({
  getUnprocessedMentionsCount: vi.fn<() => Promise<number>>(),
  getUnprocessedMention: vi.fn<() => Promise<unknown>>(),
  findFreshAnalysis: vi.fn<() => Promise<unknown>>(),
  createOrUpdateAnalysis: vi.fn<() => Promise<unknown>>(),
  markMentionAsDone: vi.fn<(args: { mentionId: string }) => Promise<unknown>>(),
  markMentionAsFailed: vi.fn<(mentionId: string) => Promise<unknown>>(),
}));

const bsky = vi.hoisted(() => ({
  getProfile: vi.fn<(agent: unknown, handle: string) => Promise<{ did: string }>>(),
  getUserPosts: vi.fn<(agent: unknown, did: string) => Promise<unknown[]>>(),
  getPost: vi.fn<() => Promise<unknown>>(),
  replyToPost: vi.fn<() => Promise<unknown>>(),
}));

const logger = vi.hoisted(() => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<(message: string) => void>(),
}));

vi.mock(import('../../src/services/database.js'), () => db);
vi.mock(import('../../src/services/bluesky.js'), () => bsky);
vi.mock(import('../../src/services/logger.js'), () => logger);
vi.mock(import('../../src/services/profanity.js'), () => ({
  analyzePosts: vi.fn<() => unknown>(() => ({ totalCount: 0, wordCounts: {}, topThree: [] })),
  generateResponseMessage: vi.fn<() => string>(() => 'Squeaky clean!'),
}));

const { processUnanalyzedMentions, MENTION_RETRY_WINDOW_MS } =
  await import('../../src/analysis.js');

const agent = {} as BskyAgent;
const HOUR_MS = 60 * 60 * 1000;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
// Old enough that, if it fails now, we stop retrying it
const pastRetryWindow = () => new Date(Date.now() - MENTION_RETRY_WINDOW_MS - HOUR_MS);

// Whose feed can never be fetched, like the account behind the October outage
const BROKEN_HANDLE = 'broken.example.com';

const makeMention = (overrides: Partial<Mention>): Mention => ({
  id: 'mention',
  userHandle: 'someone.bsky.social',
  postId: 'abc',
  postUrl: 'at://did:plc:someone/app.bsky.feed.post/abc',
  isReply: false,
  status: 'ANALYZING',
  replyPostId: null,
  replyUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  analysisId: null,
  ...overrides,
});

// The UNPROCESSED queue, oldest first, as getUnprocessedMention claims from it
const queueMentions = (mentions: Mention[]) => {
  const pending = [...mentions];
  db.getUnprocessedMentionsCount.mockImplementation(async () => pending.length);
  db.getUnprocessedMention.mockImplementation(async () => pending.shift() ?? null);
};

const markedDone = () => db.markMentionAsDone.mock.calls.map(([args]) => args.mentionId);

describe(processUnanalyzedMentions, () => {
  beforeEach(() => {
    vi.clearAllMocks();

    db.findFreshAnalysis.mockResolvedValue(null);
    db.createOrUpdateAnalysis.mockResolvedValue({ id: 'analysis' });
    db.markMentionAsDone.mockResolvedValue({});
    db.markMentionAsFailed.mockResolvedValue({});

    bsky.getProfile.mockImplementation(async (_agent, handle) => ({ did: `did:plc:${handle}` }));
    bsky.getUserPosts.mockImplementation(async (_agent, did) => {
      if (did === `did:plc:${BROKEN_HANDLE}`) {
        throw new Error('Gave up fetching posts chunk #1');
      }
      return [{ uri: 'at://did:plc:someone/app.bsky.feed.post/1' }];
    });
    bsky.getPost.mockResolvedValue({ uri: 'at://did:plc:someone/app.bsky.feed.post/abc' });
    bsky.replyToPost.mockResolvedValue({ uri: 'at://did:plc:bot/app.bsky.feed.post/reply' });
  });

  it("doesn't let a mention that fails hold up the ones queued behind it", async () => {
    queueMentions([
      makeMention({ id: 'broken', userHandle: BROKEN_HANDLE }),
      makeMention({ id: 'healthy' }),
    ]);

    await processUnanalyzedMentions(agent);

    expect(markedDone()).toStrictEqual(['healthy']);
  });

  it('gives up on a mention that is still failing once the retry window has passed', async () => {
    queueMentions([
      makeMention({
        id: 'broken',
        userHandle: BROKEN_HANDLE,
        createdAt: pastRetryWindow(),
      }),
    ]);

    await processUnanalyzedMentions(agent);

    expect(db.markMentionAsFailed).toHaveBeenCalledExactlyOnceWith('broken');
    expect(markedDone()).toStrictEqual([]);
  });

  it('leaves a recent mention that fails to be retried on a later run', async () => {
    queueMentions([
      makeMention({
        id: 'broken',
        userHandle: BROKEN_HANDLE,
        createdAt: hoursAgo(1),
      }),
    ]);

    await processUnanalyzedMentions(agent);

    // Neither DONE nor FAILED: it stays ANALYZING until resetStuckMentions frees it
    expect(db.markMentionAsFailed).not.toHaveBeenCalled();
    expect(markedDone()).toStrictEqual([]);
  });

  it('carries on with the queue if recording the failure itself fails', async () => {
    // eg. the code is deployed before `db:push` has added FAILED to the enum
    db.markMentionAsFailed.mockRejectedValue(
      new Error('invalid input value for enum "MentionStatus": "FAILED"'),
    );
    queueMentions([
      makeMention({
        id: 'broken',
        userHandle: BROKEN_HANDLE,
        createdAt: pastRetryWindow(),
      }),
      makeMention({ id: 'healthy' }),
    ]);

    await processUnanalyzedMentions(agent);

    expect(markedDone()).toStrictEqual(['healthy']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not mark mention broken as failed'),
    );
  });

  it('logs the cause of a failure, not just the top-level message', async () => {
    const validationError = new Error('Output/feed/13/post/embed/record/embeds/0/alt is too long');
    const invalidResponse = new Error(
      'The server gave an invalid response and may be out of date.',
      { cause: validationError },
    );
    bsky.getUserPosts.mockRejectedValue(
      new Error('Gave up fetching posts chunk #3', { cause: invalidResponse }),
    );
    queueMentions([makeMention({ id: 'broken' })]);

    await processUnanalyzedMentions(agent);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Output/feed/13/post/embed/record/embeds/0/alt is too long'),
    );
  });
});
