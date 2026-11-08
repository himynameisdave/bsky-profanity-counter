import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppBskyActorDefs, BskyAgent } from '@atproto/api';
import type { Analysis, Mention } from '@prisma/client';
import type * as Db from '../../src/services/database.js';
import type * as Bsky from '../../src/services/bluesky.js';
import { ANALYSIS_CACHE_TTL_MS, FULL_RECOUNT_INTERVAL_MS } from '../../src/config.js';

// Runs processUnanalyzedMentions with the real getUserPosts and the real
// counting, so analyzing someone again only fetches and adds their new posts

const db = vi.hoisted(() => ({
  getUnprocessedMentionsCount: vi.fn<typeof Db.getUnprocessedMentionsCount>(),
  getUnprocessedMention: vi.fn<typeof Db.getUnprocessedMention>(),
  findAnalysis: vi.fn<typeof Db.findAnalysis>(),
  createOrUpdateAnalysis: vi.fn<typeof Db.createOrUpdateAnalysis>(),
  markMentionAsDone: vi.fn<typeof Db.markMentionAsDone>(),
  markMentionAsFailed: vi.fn<typeof Db.markMentionAsFailed>(),
}));

const profile = vi.hoisted(() => ({ did: 'did:plc:swearer' }));

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
    async () => ({ did: profile.did }) as AppBskyActorDefs.ProfileViewDetailed,
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

const HANDLE = 'swearer.bsky.social';
const PAGE_SIZE = 100;

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

const runMention = async (agent: BskyAgent, id: string) => {
  const pending = [makeMention(id)];
  db.getUnprocessedMentionsCount.mockImplementation(async () => pending.length);
  db.getUnprocessedMention.mockImplementation(async () => pending.shift() ?? null);
  await processUnanalyzedMentions(agent);
};

// Their feed, newest first, served a page at a time like the real one
let feed: { post: unknown }[] = [];

const makePosts = (prefix: string, count: number, text: string) =>
  Array.from({ length: count }, (_, n) => {
    // A minute apart, the first one newest
    const at = new Date(Date.now() - n * 60_000).toISOString();
    return {
      post: { uri: `at://p/${prefix}-${n}`, indexedAt: at, record: { text, createdAt: at } },
    };
  });

const getAuthorFeed = vi.fn<(params: { cursor?: string }) => Promise<unknown>>(
  async ({ cursor }) => {
    const start = Number(cursor ?? 0);
    const end = start + PAGE_SIZE;
    return {
      data: {
        feed: feed.slice(start, end),
        cursor: end < feed.length ? String(end) : undefined,
      },
    };
  },
);
const agent = { getAuthorFeed } as unknown as BskyAgent;

let stored: Analysis | null = null;
const lastSaved = () => db.createOrUpdateAnalysis.mock.lastCall?.[0];

describe('processUnanalyzedMentions for someone we analyzed before', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-15T12:00:00Z') });
    profile.did = 'did:plc:swearer';
    stored = null;
    db.findAnalysis.mockImplementation(async () => stored);
    db.createOrUpdateAnalysis.mockImplementation(async (data) => {
      const now = new Date();
      stored = { id: 'analysis', ...data, lastAnalyzedAt: now, createdAt: now, updatedAt: now };
      return stored;
    });

    // 250 posts, 50 of them with a swear
    feed = [...makePosts('old-clean', 200, 'hello'), ...makePosts('old-swear', 50, 'oh shit')];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('only fetches their new posts, and adds them to the last count', async () => {
    await runMention(agent, 'first');

    expect(getAuthorFeed).toHaveBeenCalledTimes(3);
    expect(lastSaved()).toMatchObject({ totalPosts: 250, profanityCount: 50 });

    vi.advanceTimersByTime(ANALYSIS_CACHE_TTL_MS + 1);
    feed = [...makePosts('new', 10, 'damn'), ...feed];
    getAuthorFeed.mockClear();

    await runMention(agent, 'second');

    expect(getAuthorFeed.mock.calls.length).toBeLessThanOrEqual(2);
    expect(lastSaved()).toMatchObject({
      totalPosts: 260,
      profanityCount: 60,
      profanityDetails: expect.objectContaining({ wordCounts: { shit: 50, damn: 10 } }),
    });
  });

  it.each([
    {
      when: 'the last full count is too old',
      change: () => {
        vi.advanceTimersByTime(FULL_RECOUNT_INTERVAL_MS);
      },
    },
    {
      when: 'the handle belongs to a different account now',
      change: () => {
        vi.advanceTimersByTime(ANALYSIS_CACHE_TTL_MS + 1);
        profile.did = 'did:plc:someone-else';
      },
    },
  ])('counts their whole year again when $when', async ({ change }) => {
    await runMention(agent, 'first');
    change();
    // A post deleted since the first count: only a full recount notices
    feed = feed.slice(0, -1);
    getAuthorFeed.mockClear();

    await runMention(agent, 'second');

    expect(getAuthorFeed).toHaveBeenCalledTimes(3);
    expect(lastSaved()).toMatchObject({ totalPosts: 249, profanityCount: 49 });
  });
});
