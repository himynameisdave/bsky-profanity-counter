import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppBskyActorDefs, AppBskyFeedDefs, BskyAgent } from '@atproto/api';
import type { Analysis, Mention } from '../../src/generated/prisma/client.js';
import type * as Db from '../../src/services/database.js';
import type * as Bsky from '../../src/services/bluesky.js';
import { ANALYSIS_CACHE_TTL_MS } from '../../src/config.js';

const db = vi.hoisted(() => ({
  getUnprocessedMentionsCount: vi.fn<typeof Db.getUnprocessedMentionsCount>(),
  getUnprocessedMention: vi.fn<typeof Db.getUnprocessedMention>(),
  findAnalysis: vi.fn<typeof Db.findAnalysis>(),
  createOrUpdateAnalysis: vi.fn<typeof Db.createOrUpdateAnalysis>(),
  refreshTargetHandle: vi.fn<typeof Db.refreshTargetHandle>(),
  recordMentionError: vi.fn<typeof Db.recordMentionError>(),
  markMentionAsFailed: vi.fn<typeof Db.markMentionAsFailed>(),
  markMentionAsDone: vi.fn<typeof Db.markMentionAsDone>(),
}));
const bsky = vi.hoisted(() => ({
  getProfile: vi.fn<typeof Bsky.getProfile>(),
  getUserPosts: vi.fn<typeof Bsky.getUserPosts>(),
  getPost: vi.fn<typeof Bsky.getPost>(),
  replyToPost: vi.fn<typeof Bsky.replyToPost>(),
}));
vi.mock(import('../../src/services/database.js'), () => db);
vi.mock(import('../../src/services/bluesky.js'), async (original) => ({
  ...(await original()),
  ...bsky,
}));
vi.mock(import('../../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
}));
const { processUnanalyzedMentions } = await import('../../src/analysis.js');

const DID = 'did:plc:original';
const OLD_HANDLE = 'old.example.com';
const NEW_HANDLE = 'New.Example.com';
const agent = {} as BskyAgent;
let analyses: Map<string, Analysis>;
let currentHandle: string;

const run = async (did = DID, userHandle = OLD_HANDLE) => {
  const mention: Mention = {
    id: 'mention',
    did,
    userHandle,
    postId: 'post',
    postUrl: 'at://did:plc:requester/app.bsky.feed.post/post',
    isReply: true,
    status: 'ANALYZING',
    attempts: 1,
    firstAttemptedAt: new Date(),
    lastError: null,
    replyPostId: null,
    replyUrl: null,
    analysisId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  db.getUnprocessedMentionsCount.mockResolvedValueOnce(1).mockResolvedValue(0);
  db.getUnprocessedMention.mockResolvedValueOnce(mention);
  await processUnanalyzedMentions(agent);
};

const posts = (id: string) =>
  [
    {
      uri: `at://${DID}/app.bsky.feed.post/${id}`,
      cid: 'cid',
      author: { did: DID, handle: currentHandle },
      indexedAt: new Date().toISOString(),
      record: { text: 'shit', createdAt: new Date().toISOString() },
    },
  ] as AppBskyFeedDefs.PostView[];

beforeEach(() => {
  vi.resetAllMocks();
  analyses = new Map();
  currentHandle = NEW_HANDLE;
  db.findAnalysis.mockImplementation(async (did) => analyses.get(did) ?? null);
  db.createOrUpdateAnalysis.mockImplementation(async (data) => {
    const now = new Date();
    const row = { ...data, id: data.did, createdAt: now, updatedAt: now, lastAnalyzedAt: now };
    analyses.set(data.did, row);
    return row;
  });
  bsky.getProfile.mockImplementation(
    async (_agent, did) => ({ did, handle: currentHandle }) as AppBskyActorDefs.ProfileViewDetailed,
  );
  bsky.getUserPosts.mockResolvedValue(posts('first'));
  bsky.getPost.mockResolvedValue({
    uri: 'at://did:plc:requester/app.bsky.feed.post/post',
    cid: 'cid',
  });
  bsky.replyToPost.mockResolvedValue({
    uri: 'at://did:plc:bot/app.bsky.feed.post/reply',
    cid: 'cid',
  });
});

describe('target identity across handle changes', () => {
  it('audits the ingested parent DID after a rename, and mentions it using the verbatim current handle', async () => {
    await run();
    expect(bsky.getProfile).toHaveBeenCalledWith(agent, DID);
    expect(bsky.getUserPosts).toHaveBeenCalledWith(agent, DID, undefined);
    expect(bsky.replyToPost).toHaveBeenCalledWith(
      agent,
      expect.anything(),
      expect.stringContaining(`@${NEW_HANDLE}`),
      { did: DID, handle: NEW_HANDLE },
    );
    expect(db.refreshTargetHandle).toHaveBeenCalledWith('mention', DID, NEW_HANDLE);
  });

  it('refreshes fresh-reply display after a rename during a long feed scan', async () => {
    currentHandle = OLD_HANDLE;
    bsky.getUserPosts.mockImplementationOnce(async () => {
      currentHandle = NEW_HANDLE;
      return posts('first');
    });
    await run();
    expect(bsky.replyToPost).toHaveBeenLastCalledWith(
      agent,
      expect.anything(),
      expect.stringContaining(`@${NEW_HANDLE}`),
      { did: DID, handle: NEW_HANDLE },
    );
  });

  it('refreshes the handle on a cache hit without fetching the feed or extending its lifetime', async () => {
    currentHandle = OLD_HANDLE;
    await run();
    const analyzedAt = analyses.get(DID)?.lastAnalyzedAt;
    currentHandle = NEW_HANDLE;
    await run();
    expect(bsky.getProfile).toHaveBeenCalledTimes(2);
    expect(bsky.getUserPosts).toHaveBeenCalledOnce();
    expect(analyses.get(DID)?.lastAnalyzedAt).toStrictEqual(analyzedAt);
    expect(bsky.replyToPost).toHaveBeenLastCalledWith(
      agent,
      expect.anything(),
      expect.stringContaining(`@${NEW_HANDLE}`),
      { did: DID, handle: NEW_HANDLE },
    );
  });

  it('does not give a new owner of the old handle the previous owner’s cached analysis', async () => {
    await run();
    currentHandle = OLD_HANDLE;
    bsky.getUserPosts.mockResolvedValue([]);
    await run('did:plc:new-owner');
    expect(db.findAnalysis).toHaveBeenLastCalledWith('did:plc:new-owner');
    expect(bsky.getUserPosts.mock.lastCall).toStrictEqual([agent, 'did:plc:new-owner', undefined]);
    expect(analyses.size).toBe(2);
    expect(analyses.get('did:plc:new-owner')?.profanityCount).toBe(0);
    expect(analyses.get(DID)?.profanityCount).toBe(1);
    expect(bsky.replyToPost).toHaveBeenLastCalledWith(
      agent,
      expect.anything(),
      expect.stringContaining(`@${OLD_HANDLE}`),
      { did: 'did:plc:new-owner', handle: OLD_HANDLE },
    );
  });

  it('keeps one analysis and its incremental buckets/checkpoint across multiple handles', async () => {
    currentHandle = OLD_HANDLE;
    await run();
    const first = analyses.get(DID)!;
    first.lastAnalyzedAt = new Date(Date.now() - ANALYSIS_CACHE_TTL_MS - 1);
    const details = first.profanityDetails as Db.ProfanityDetails;
    currentHandle = NEW_HANDLE;
    bsky.getUserPosts.mockResolvedValue(posts('new'));
    await run(DID, NEW_HANDLE);
    expect(bsky.getUserPosts).toHaveBeenLastCalledWith(agent, DID, details.checkpoint);
    expect(analyses.size).toBe(1);
    expect(analyses.get(DID)).toMatchObject({
      userHandle: NEW_HANDLE,
      totalPosts: 2,
      profanityCount: 2,
      profanityDetails: { wordCounts: { shit: 2 }, fullCountAt: details.fullCountAt },
    });
  });
});
