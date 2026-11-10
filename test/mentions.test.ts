import { XRPCError } from '@atproto/api';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BskyAgent } from '@atproto/api';
import type { Notification } from '../src/types.js';
import type * as Db from '../src/services/database.js';
import type * as Bsky from '../src/services/bluesky.js';

vi.mock(import('../src/services/database.js'), () => ({
  storeMention: vi.fn<typeof Db.storeMention>(),
}));

vi.mock(import('../src/services/bluesky.js'), () => ({
  getPost: vi.fn<typeof Bsky.getPost>(),
  getProfile: vi.fn<typeof Bsky.getProfile>(),
}));

vi.mock(import('../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));

const db = await import('../src/services/database.js');
const bsky = await import('../src/services/bluesky.js');
const { default: storeMentions } = await import('../src/mentions.js');

const agent = {} as BskyAgent;

const makeMention = (id: string, indexedAt: string): Notification =>
  ({
    uri: `at://did:plc:someone/app.bsky.feed.post/${id}`,
    cid: 'bafycid',
    author: {
      did: 'did:plc:someone',
      handle: 'someone.bsky.social',
    },
    reason: 'mention',
    record: {},
    isRead: false,
    indexedAt,
    labels: [],
  }) as unknown as Notification;

describe(storeMentions, () => {
  beforeEach(() => {
    // Reset, not clear: these tests swap in their own storeMention implementations
    vi.resetAllMocks();
  });

  it('reports success only after every mention on the page is stored', async () => {
    const mentions = [
      makeMention('2', '2026-01-02T00:00:00.000Z'),
      makeMention('1', '2026-01-01T00:00:00.000Z'),
    ];

    const stored = await storeMentions(agent, mentions);

    expect(db.storeMention).toHaveBeenCalledTimes(2);
    // Keep processing deterministic, one mention at a time
    expect(vi.mocked(db.storeMention).mock.calls.map(([data]) => data.postId)).toStrictEqual([
      '1',
      '2',
    ]);
    expect(stored).toBe(true);
    expect(db.storeMention).toHaveBeenCalledWith(
      expect.objectContaining({ did: 'did:plc:someone' }),
    );
  });

  it('reports an incomplete page when any mention fails, while still saving the others', async () => {
    const mentions = [
      makeMention('1', '2026-01-01T00:00:00.000Z'),
      makeMention('2', '2026-01-02T00:00:00.000Z'),
      makeMention('3', '2026-01-03T00:00:00.000Z'),
    ];

    vi.mocked(db.storeMention).mockImplementation(async ({ postId }) => {
      if (postId === '2') {
        throw new Error('💥 database is having a day');
      }
      return {} as any;
    });

    const stored = await storeMentions(agent, mentions);

    expect(stored).toBe(false);
    expect(db.storeMention).toHaveBeenCalledTimes(3);
  });

  it('reports failure when the oldest mention cannot be stored', async () => {
    const mentions = [
      makeMention('1', '2026-01-01T00:00:00.000Z'),
      makeMention('2', '2026-01-02T00:00:00.000Z'),
    ];

    vi.mocked(db.storeMention).mockRejectedValue(new Error('💥 database is having a day'));

    const stored = await storeMentions(agent, mentions);

    expect(stored).toBe(false);
  });

  it.each([false, true])(
    'keeps a failed URI retryable when another repository shares its key (tied timestamps: %s)',
    async (tied) => {
      const first = makeMention('3abc', '2026-01-02T00:00:00.000Z');
      const second: Notification = {
        ...first,
        uri: 'at://did:plc:other/app.bsky.feed.post/3abc',
        author: { ...first.author, did: 'did:plc:other', handle: 'other.bsky.social' },
        indexedAt: tied ? first.indexedAt : '2026-01-03T00:00:00.000Z',
      };
      vi.mocked(db.storeMention).mockImplementation(async ({ postUrl }) => {
        if (postUrl === second.uri) {
          throw new Error('insert failed');
        }
        return {} as Awaited<ReturnType<typeof Db.storeMention>>;
      });

      const stored = await storeMentions(agent, [second, first]);

      expect(db.storeMention).toHaveBeenCalledTimes(2);
      expect(db.storeMention).toHaveBeenCalledWith(
        expect.objectContaining({ postUrl: second.uri }),
      );
      expect(stored).toBe(false);

      // Retrying the unread batch can persist both URIs before advancing the cursor.
      vi.mocked(db.storeMention).mockResolvedValue(
        {} as Awaited<ReturnType<typeof Db.storeMention>>,
      );
      await expect(storeMentions(agent, [second, first])).resolves.toBe(true);
    },
  );

  it("reports an incomplete page when a failed mention shares a stored mention's timestamp", async () => {
    const mentions = [
      makeMention('older', '2026-01-01T00:00:00.000Z'),
      makeMention('stored', '2026-01-02T00:00:00.000Z'),
      makeMention('failed', '2026-01-02T00:00:00.000Z'),
      makeMention('newer', '2026-01-03T00:00:00.000Z'),
    ];
    vi.mocked(db.storeMention).mockResolvedValueOnce(
      {} as Awaited<ReturnType<typeof Db.storeMention>>,
    );
    vi.mocked(db.storeMention).mockResolvedValueOnce(
      {} as Awaited<ReturnType<typeof Db.storeMention>>,
    );
    vi.mocked(db.storeMention).mockRejectedValueOnce(new Error('tied failure'));

    const stored = await storeMentions(agent, mentions);

    expect(db.storeMention).toHaveBeenCalledTimes(4);
    expect(stored).toBe(false);
  });

  it('completes pages with no mentions without storing anything', async () => {
    await expect(storeMentions(agent, [])).resolves.toBe(true);
    expect(db.storeMention).not.toHaveBeenCalled();
  });

  describe('when the mention is a reply', () => {
    const PARENT_URI = 'at://did:plc:parent/app.bsky.feed.post/parent';

    const makeReply = (id: string, indexedAt: string): Notification =>
      ({
        ...makeMention(id, indexedAt),
        record: { reply: { parent: { uri: PARENT_URI }, root: { uri: PARENT_URI } } },
      }) as unknown as Notification;

    it("audits the parent post's author", async () => {
      vi.mocked(bsky.getPost).mockResolvedValue({ uri: PARENT_URI, cid: 'bafy' } as any);
      vi.mocked(bsky.getProfile).mockResolvedValue({ handle: 'parent.bsky.social' } as any);

      const stored = await storeMentions(agent, [makeReply('1', '2026-01-01T00:00:00.000Z')]);
      expect(stored).toBe(true);

      expect(bsky.getProfile).toHaveBeenCalledWith(agent, 'did:plc:parent');
      expect(db.storeMention).toHaveBeenCalledWith(
        expect.objectContaining({ did: 'did:plc:parent', userHandle: 'parent.bsky.social' }),
      );
    });

    it('audits the person who tagged us when the parent post is gone', async () => {
      vi.mocked(bsky.getPost).mockResolvedValue(null);

      const stored = await storeMentions(agent, [makeReply('1', '2026-01-01T00:00:00.000Z')]);
      expect(stored).toBe(true);

      expect(db.storeMention).toHaveBeenCalledWith(
        expect.objectContaining({ did: 'did:plc:someone', userHandle: 'someone.bsky.social' }),
      );
    });

    it('queues a terminal parent-profile error under the parent DID so its failure can be persisted', async () => {
      vi.mocked(bsky.getPost).mockResolvedValue({ uri: PARENT_URI, cid: 'cid' });
      vi.mocked(bsky.getProfile).mockRejectedValue(new XRPCError(400, 'BlockedActor', 'Blocked'));
      const stored = await storeMentions(agent, [makeReply('1', '2026-01-01T00:00:00.000Z')]);
      expect(stored).toBe(true);
      expect(db.storeMention).toHaveBeenCalledWith(
        expect.objectContaining({ did: 'did:plc:parent' }),
      );
    });

    it.each([
      [
        'the parent post',
        () => vi.mocked(bsky.getPost).mockRejectedValue(new Error('Internal Server Error')),
      ],
      [
        "the parent author's profile",
        () => {
          vi.mocked(bsky.getPost).mockResolvedValue({ uri: PARENT_URI, cid: 'bafy' } as any);
          vi.mocked(bsky.getProfile).mockRejectedValue(new Error('Internal Server Error'));
        },
      ],
    ])(
      'leaves it unread for next run, rather than auditing the wrong person, when looking up %s fails',
      async (_step, fail) => {
        fail();

        const stored = await storeMentions(agent, [makeReply('1', '2026-01-01T00:00:00.000Z')]);

        expect(db.storeMention).not.toHaveBeenCalled();
        expect(stored).toBe(false);
      },
    );
  });
});
