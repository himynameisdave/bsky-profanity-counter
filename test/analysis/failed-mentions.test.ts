import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppBskyActorDefs, AppBskyFeedDefs, BskyAgent } from '@atproto/api';
import type { Analysis, Mention } from '@prisma/client';
import type * as Db from '../../src/services/database.js';
import type * as Bsky from '../../src/services/bluesky.js';
import type * as Profanity from '../../src/services/profanity.js';

const db = vi.hoisted(() => ({
  getUnprocessedMentionsCount: vi.fn<typeof Db.getUnprocessedMentionsCount>(),
  getUnprocessedMention: vi.fn<typeof Db.getUnprocessedMention>(),
  findAnalysis: vi.fn<typeof Db.findAnalysis>(),
  createOrUpdateAnalysis: vi.fn<typeof Db.createOrUpdateAnalysis>(),
  markMentionAsDone: vi.fn<typeof Db.markMentionAsDone>(),
  markMentionAsFailed: vi.fn<typeof Db.markMentionAsFailed>(),
}));

const bsky = vi.hoisted(() => ({
  getProfile: vi.fn<typeof Bsky.getProfile>(),
  getUserPosts: vi.fn<typeof Bsky.getUserPosts>(),
  getPost: vi.fn<typeof Bsky.getPost>(),
  replyToPost: vi.fn<typeof Bsky.replyToPost>(),
  findOwnReply: vi.fn<typeof Bsky.findOwnReply>(),
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
  analyzePosts: vi.fn<typeof Profanity.analyzePosts>(() => ({
    totalCount: 0,
    wordCounts: {},
    topThree: [],
    postCount: 1,
    days: {},
  })),
  generateResponseMessage: vi.fn<typeof Profanity.generateResponseMessage>(() => 'Squeaky clean!'),
}));

const { processUnanalyzedMentions, MAX_FAILED_ATTEMPTS, MENTION_RETRY_WINDOW_MS } =
  await import('../../src/analysis.js');
const { stats } = await import('../../src/run-stats.js');

const agent = {} as BskyAgent;
const HOUR_MS = 60 * 60 * 1000;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
const pastRetryWindow = () => new Date(Date.now() - MENTION_RETRY_WINDOW_MS - HOUR_MS);

// Whose feed can never be fetched, like the account behind the October outage
const BROKEN_HANDLE = 'broken.example.com';

const failNextReply = () => bsky.replyToPost.mockRejectedValueOnce(new Error('Upstream Failure'));

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
    const row = find(mentionId);
    row.status = 'DONE';
    return { ...row };
  });
  db.markMentionAsFailed.mockImplementation(async (mentionId) => {
    const row = find(mentionId);
    row.status = 'FAILED';
    return { ...row };
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

    db.findAnalysis.mockResolvedValue(null);
    db.createOrUpdateAnalysis.mockResolvedValue({ id: 'analysis' } as Analysis);

    bsky.getProfile.mockImplementation(
      async (_agent, handle) =>
        ({ did: `did:plc:${handle}` }) as AppBskyActorDefs.ProfileViewDetailed,
    );
    bsky.getUserPosts.mockImplementation(async (_agent, did) => {
      if (did === `did:plc:${BROKEN_HANDLE}`) {
        throw new Error('Gave up fetching posts chunk #1');
      }
      return [{ uri: 'at://did:plc:someone/app.bsky.feed.post/1' } as AppBskyFeedDefs.PostView];
    });
    bsky.getPost.mockResolvedValue({
      uri: 'at://did:plc:someone/app.bsky.feed.post/abc',
      cid: 'bafy-abc',
    });
    bsky.replyToPost.mockResolvedValue({
      uri: 'at://did:plc:bot/app.bsky.feed.post/reply',
      cid: 'bafy-reply',
    });
    bsky.findOwnReply.mockResolvedValue(null);
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

  it('counts answered and failed mentions for the run summary', async () => {
    useMentionTable([
      makeMention({ id: 'broken', userHandle: BROKEN_HANDLE }),
      makeMention({ id: 'healthy' }),
    ]);
    const before = { ...stats };

    await processUnanalyzedMentions(agent);

    expect(stats.failed - before.failed).toBe(1);
    expect(stats.answered - before.answered).toBe(1);
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
    {
      // getPost only returns null for a deleted post, anything else is thrown
      step: 'mention post lookup',
      failOnce: () => bsky.getPost.mockRejectedValueOnce(new Error('Internal Server Error')),
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

    const gaveUpBefore = stats.gaveUp;
    await processUnanalyzedMentions(agent);

    expect(table.statusOf('broken')).toBe('FAILED');
    expect(bsky.getUserPosts).toHaveBeenCalledTimes(MAX_FAILED_ATTEMPTS);
    expect(stats.gaveUp - gaveUpBefore).toBe(1);
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

  it('marks a mention done without replying when its post has been deleted', async () => {
    const table = useMentionTable([makeMention({ id: 'deleted' })]);
    bsky.getPost.mockResolvedValue(null);
    const before = { ...stats };

    await processUnanalyzedMentions(agent);

    expect(table.statusOf('deleted')).toBe('DONE');
    expect(bsky.replyToPost).not.toHaveBeenCalled();
    expect(stats.skipped - before.skipped).toBe(1);
    expect(stats.answered - before.answered).toBe(0);
  });

  it("doesn't reply twice when an earlier attempt replied but couldn't mark the mention done", async () => {
    const table = useMentionTable([makeMention({ id: 'replied' })]);
    // The reply goes out, then recording it fails
    db.markMentionAsDone.mockRejectedValueOnce(new Error('Connection reset'));

    await processUnanalyzedMentions(agent);
    expect(table.statusOf('replied')).toBe('ANALYZING');
    expect(bsky.replyToPost).toHaveBeenCalledOnce();
    // A first attempt can't have replied already, so there's nothing to look for
    expect(bsky.findOwnReply).not.toHaveBeenCalled();

    // Our reply is in our repo now
    bsky.findOwnReply.mockResolvedValue({
      uri: 'at://did:plc:bot/app.bsky.feed.post/reply',
      cid: 'bafy-reply',
    });
    table.startNextRun();
    await processUnanalyzedMentions(agent);

    expect(table.statusOf('replied')).toBe('DONE');
    expect(bsky.replyToPost).toHaveBeenCalledOnce();
    expect(bsky.findOwnReply).toHaveBeenCalledWith(
      agent,
      'at://did:plc:someone/app.bsky.feed.post/abc',
      expect.any(Date),
    );
    expect(db.markMentionAsDone).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mentionId: 'replied',
        replyUrl: 'at://did:plc:bot/app.bsky.feed.post/reply',
      }),
    );
  });

  it('replies on a retry when no earlier reply turns up', async () => {
    const table = useMentionTable([makeMention({ id: 'retry' })]);
    failNextReply();

    await processUnanalyzedMentions(agent);
    table.startNextRun();
    await processUnanalyzedMentions(agent);

    expect(bsky.findOwnReply).toHaveBeenCalledOnce();
    expect(bsky.replyToPost).toHaveBeenCalledTimes(2);
    expect(table.statusOf('retry')).toBe('DONE');
  });
});
