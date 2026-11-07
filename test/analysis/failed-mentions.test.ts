import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const { processUnanalyzedMentions, MAX_FAILED_ATTEMPTS, MENTION_RETRY_WINDOW_MS } =
  await import('../../src/analysis.js');

const agent = {} as BskyAgent;
const HOUR_MS = 60 * 60 * 1000;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
const pastRetryWindow = () => new Date(Date.now() - MENTION_RETRY_WINDOW_MS - HOUR_MS);

// Whose feed can never be fetched, like the account behind the October outage
const BROKEN_HANDLE = 'broken.example.com';

const makeMention = (overrides: Partial<Mention>): Mention => ({
  id: 'mention',
  userHandle: 'someone.bsky.social',
  postId: 'abc',
  postUrl: 'at://did:plc:someone/app.bsky.feed.post/abc',
  isReply: false,
  status: 'UNPROCESSED',
  attempts: 0,
  firstAttemptedAt: null,
  replyPostId: null,
  replyUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  analysisId: null,
  ...overrides,
});

// A stand-in for the Mention table, with just enough of the real queries to run
// processUnanalyzedMentions several times over, as successive runs would
const useMentionTable = (mentions: Mention[]) => {
  const rows = mentions.map((mention) => ({ ...mention }));

  const find = (id: string) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) {
      throw new Error(`No mention ${id}`);
    }
    return row;
  };
  const unprocessed = () => rows.filter((row) => row.status === 'UNPROCESSED');

  db.getUnprocessedMentionsCount.mockImplementation(async () => unprocessed().length);
  // Claims the oldest mention and counts the attempt, like the real transaction
  db.getUnprocessedMention.mockImplementation(async () => {
    const [row] = unprocessed();
    if (!row) {
      return null;
    }
    row.status = 'ANALYZING';
    row.attempts += 1;
    row.firstAttemptedAt ??= new Date();
    return { ...row };
  });
  db.markMentionAsDone.mockImplementation(async ({ mentionId }) => {
    find(mentionId).status = 'DONE';
  });
  db.markMentionAsFailed.mockImplementation(async (mentionId) => {
    find(mentionId).status = 'FAILED';
  });

  return {
    statusOf: (id: string) => find(id).status,
    // What resetStuckMentions does at the start of the next run
    startNextRun: () => {
      for (const row of rows) {
        if (row.status === 'ANALYZING') {
          row.status = 'UNPROCESSED';
        }
      }
    },
  };
};

describe(processUnanalyzedMentions, () => {
  beforeEach(() => {
    vi.clearAllMocks();

    db.findFreshAnalysis.mockResolvedValue(null);
    db.createOrUpdateAnalysis.mockResolvedValue({ id: 'analysis' });

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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("doesn't let a mention that fails hold up the ones queued behind it", async () => {
    const table = useMentionTable([
      makeMention({ id: 'broken', userHandle: BROKEN_HANDLE }),
      makeMention({ id: 'healthy' }),
    ]);

    await processUnanalyzedMentions(agent);

    expect(table.statusOf('broken')).toBe('ANALYZING');
    expect(table.statusOf('healthy')).toBe('DONE');
  });

  it.each([
    {
      step: 'profile lookup',
      failOnce: () => bsky.getProfile.mockRejectedValueOnce(new Error('Internal Server Error')),
    },
    {
      step: 'reply',
      failOnce: () => bsky.replyToPost.mockRejectedValueOnce(new Error('Upstream Failure')),
    },
  ])(
    'retries an old, never-attempted mention after a temporary $step error, and replies on a later run',
    async ({ failOnce }) => {
      // Stored two weeks ago, like the mentions stuck behind the broken one
      const table = useMentionTable([makeMention({ id: 'old', createdAt: hoursAgo(14 * 24) })]);
      failOnce();

      await processUnanalyzedMentions(agent);
      expect(table.statusOf('old')).toBe('ANALYZING');

      table.startNextRun();
      await processUnanalyzedMentions(agent);
      expect(table.statusOf('old')).toBe('DONE');
    },
  );

  it('gives up on a mention that always fails, once it has failed enough times over a day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const table = useMentionTable([makeMention({ id: 'broken', userHandle: BROKEN_HANDLE })]);

    // A run every six hours, about what GitHub's cron actually delivers
    for (let run = 1; run <= MAX_FAILED_ATTEMPTS; run++) {
      // Each run follows the last
      // oxlint-disable-next-line no-await-in-loop
      await processUnanalyzedMentions(agent);
      expect(table.statusOf('broken')).toBe('ANALYZING');

      vi.setSystemTime(Date.now() + 6 * HOUR_MS);
      table.startNextRun();
    }

    await processUnanalyzedMentions(agent);

    expect(table.statusOf('broken')).toBe('FAILED');
    expect(bsky.getUserPosts).toHaveBeenCalledTimes(MAX_FAILED_ATTEMPTS);
  });

  it('gives up without trying again once the budget is spent, even if no attempt ever finished', async () => {
    // eg. every earlier run was killed by the workflow timeout partway through
    // this mention, so no catch ever ran. The attempts were counted at claim time.
    const table = useMentionTable([
      makeMention({
        id: 'broken',
        attempts: MAX_FAILED_ATTEMPTS,
        firstAttemptedAt: pastRetryWindow(),
      }),
    ]);

    await processUnanalyzedMentions(agent);

    expect(table.statusOf('broken')).toBe('FAILED');
    expect(bsky.getProfile).not.toHaveBeenCalled();
  });

  it('keeps retrying a mention that has failed many times, if its first attempt was recent', async () => {
    const table = useMentionTable([
      makeMention({
        id: 'broken',
        userHandle: BROKEN_HANDLE,
        attempts: MAX_FAILED_ATTEMPTS * 10,
        firstAttemptedAt: hoursAgo(1),
      }),
    ]);

    await processUnanalyzedMentions(agent);

    expect(bsky.getUserPosts).toHaveBeenCalledOnce();
    expect(table.statusOf('broken')).toBe('ANALYZING');
  });

  it('keeps retrying a mention first attempted long ago, if it has only failed a few times', async () => {
    const table = useMentionTable([
      makeMention({
        id: 'broken',
        userHandle: BROKEN_HANDLE,
        attempts: 1,
        firstAttemptedAt: hoursAgo(72),
      }),
    ]);

    await processUnanalyzedMentions(agent);

    expect(bsky.getUserPosts).toHaveBeenCalledOnce();
    expect(table.statusOf('broken')).toBe('ANALYZING');
  });

  it('carries on with the queue if recording the failure itself fails', async () => {
    const table = useMentionTable([
      makeMention({
        id: 'broken',
        attempts: MAX_FAILED_ATTEMPTS,
        firstAttemptedAt: pastRetryWindow(),
      }),
      makeMention({ id: 'healthy' }),
    ]);
    db.markMentionAsFailed.mockRejectedValue(new Error('Connection reset'));

    await processUnanalyzedMentions(agent);

    expect(table.statusOf('healthy')).toBe('DONE');
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
    useMentionTable([makeMention({ id: 'broken' })]);

    await processUnanalyzedMentions(agent);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Output/feed/13/post/embed/record/embeds/0/alt is too long'),
    );
  });
});
