import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppBskyActorDefs, AppBskyFeedDefs, BskyAgent } from '@atproto/api';
import type { Analysis, Mention } from '../src/generated/prisma/client.js';
import type * as Db from '../src/services/database.js';
import type * as Bsky from '../src/services/bluesky.js';
import type * as Profanity from '../src/services/profanity.js';
import { WHIMSICAL_RESPONSES } from '../src/services/self-targeting.js';

const db = vi.hoisted(() => ({
  getUnprocessedMentionsCount: vi.fn<typeof Db.getUnprocessedMentionsCount>(),
  getUnprocessedMention: vi.fn<typeof Db.getUnprocessedMention>(),
  findAnalysis: vi.fn<typeof Db.findAnalysis>(),
  createOrUpdateAnalysis: vi.fn<typeof Db.createOrUpdateAnalysis>(),
  markMentionAsDone: vi.fn<typeof Db.markMentionAsDone>(),
  recordMentionError: vi.fn<typeof Db.recordMentionError>(),
  refreshTargetHandle: vi.fn<typeof Db.refreshTargetHandle>(),
}));

const bsky = vi.hoisted(() => ({
  getProfile: vi.fn<typeof Bsky.getProfile>(),
  getUserPosts: vi.fn<typeof Bsky.getUserPosts>(),
  getFeedCheckpoint: vi.fn<typeof Bsky.getFeedCheckpoint>(),
  getPost: vi.fn<typeof Bsky.getPost>(),
  replyToPost: vi.fn<typeof Bsky.replyToPost>(),
}));

vi.mock(import('../src/services/database.js'), () => db);
vi.mock(import('../src/services/bluesky.js'), () => bsky);
vi.mock(import('../src/services/profanity.js'), () => ({
  analyzePosts: vi.fn<typeof Profanity.analyzePosts>(() => ({
    totalCount: 0,
    wordCounts: {},
    topThree: [],
    postCount: 1,
    days: {},
  })),
  generateResponseMessage: vi.fn<typeof Profanity.generateResponseMessage>(() => 'Squeaky clean!'),
}));
vi.mock(import('../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));

const { processUnanalyzedMentions } = await import('../src/analysis.js');
const profanity = vi.mocked(await import('../src/services/profanity.js'));

// Deliberately not profanity.accountant: someone running their own copy of the
// bot logs in as their own account, and the self-check has to follow it
const BOT_HANDLE = 'counter.example.com';

const agent = {
  session: { handle: BOT_HANDLE, did: 'did:plc:counter' },
} as unknown as BskyAgent;

const MENTION_POST = { uri: 'at://did:plc:someone/app.bsky.feed.post/abc', cid: 'bafy-abc' };

const makeMention = (userHandle: string): Mention => ({
  id: 'mention',
  userHandle,
  did: userHandle === BOT_HANDLE ? 'did:plc:counter' : `did:plc:${userHandle}`,
  lastError: null,
  postId: 'abc',
  postUrl: MENTION_POST.uri,
  isReply: true,
  status: 'ANALYZING',
  attempts: 1,
  firstAttemptedAt: new Date(),
  replyPostId: null,
  replyUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  analysisId: null,
});

// A queue holding just this one mention
const queue = (mention: Mention) => {
  db.getUnprocessedMentionsCount.mockResolvedValueOnce(1).mockResolvedValue(0);
  db.getUnprocessedMention.mockResolvedValueOnce(mention);
};

// The text of the one reply we posted
const repliedWith = () => {
  expect(bsky.replyToPost).toHaveBeenCalledOnce();
  // replyToPost(agent, post, text)
  return bsky.replyToPost.mock.calls[0][2];
};

describe('processUnanalyzedMentions when someone asks the bot to audit itself', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    db.findAnalysis.mockResolvedValue(null);
    db.createOrUpdateAnalysis.mockResolvedValue({ id: 'analysis' } as Analysis);
    bsky.getProfile.mockImplementation(
      async (_agent, did) =>
        ({ did, handle: did.slice('did:plc:'.length) }) as AppBskyActorDefs.ProfileViewDetailed,
    );
    bsky.getUserPosts.mockResolvedValue([{ uri: 'post' } as AppBskyFeedDefs.PostView]);
    bsky.getPost.mockResolvedValue(MENTION_POST);
    bsky.replyToPost.mockResolvedValue({
      uri: 'at://did:plc:counter/app.bsky.feed.post/reply',
      cid: 'bafy-reply',
    });
  });

  it('detects itself by DID even after the bot renames', async () => {
    queue({ ...makeMention(BOT_HANDLE), userHandle: 'old-bot.example.com' });

    await processUnanalyzedMentions(agent);

    expect(WHIMSICAL_RESPONSES).toContain(repliedWith());
    expect(bsky.getUserPosts).not.toHaveBeenCalled();
    expect(db.createOrUpdateAnalysis).not.toHaveBeenCalled();
    expect(db.markMentionAsDone).toHaveBeenCalledWith(
      expect.objectContaining({ mentionId: 'mention' }),
    );
  });

  it('audits anyone else as normal, whatever their handle', async () => {
    // The handle that used to be hardcoded, which is just another account to a fork
    queue(makeMention('profanity.accountant'));

    await processUnanalyzedMentions(agent);

    expect(repliedWith()).toBe('Squeaky clean!');
    expect(bsky.getUserPosts).toHaveBeenCalledWith(
      agent,
      'did:plc:profanity.accountant',
      undefined,
    );
  });
});

// Every profile lookup returns these pronouns
const profileWith = (pronouns: string) =>
  bsky.getProfile.mockImplementation(
    async (_agent, did) =>
      ({
        did,
        handle: did.slice('did:plc:'.length),
        pronouns,
      }) as AppBskyActorDefs.ProfileViewDetailed,
  );

describe("processUnanalyzedMentions uses the target's pronouns", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    db.findAnalysis.mockResolvedValue(null);
    db.createOrUpdateAnalysis.mockResolvedValue({ id: 'analysis' } as Analysis);
    bsky.getUserPosts.mockResolvedValue([{ uri: 'post' } as AppBskyFeedDefs.PostView]);
    bsky.getPost.mockResolvedValue(MENTION_POST);
    bsky.replyToPost.mockResolvedValue({
      uri: 'at://did:plc:counter/app.bsky.feed.post/reply',
      cid: 'bafy-reply',
    });
  });

  it('when counting their posts', async () => {
    profileWith('she/her');
    queue(makeMention('someone.bsky.social'));

    await processUnanalyzedMentions(agent);

    expect(profanity.generateResponseMessage).toHaveBeenCalledWith(
      expect.anything(),
      'someone.bsky.social',
      1,
      { subjectHas: "She's", possessive: 'her' },
    );
  });

  it('when reusing a cached analysis', async () => {
    profileWith('he/him');
    db.findAnalysis.mockResolvedValue({
      id: 'analysis',
      did: 'did:plc:someone.bsky.social',
      userHandle: 'someone.bsky.social',
      totalPosts: 20,
      profanityCount: 0,
      profanityDetails: { wordCounts: {}, topProfanities: [] },
      lastAnalyzedAt: new Date(),
    } as unknown as Analysis);
    queue(makeMention('someone.bsky.social'));

    await processUnanalyzedMentions(agent);

    expect(bsky.getUserPosts).not.toHaveBeenCalled();
    expect(profanity.generateResponseMessage).toHaveBeenCalledWith(
      expect.anything(),
      'someone.bsky.social',
      20,
      { subjectHas: "He's", possessive: 'his' },
    );
  });
});
