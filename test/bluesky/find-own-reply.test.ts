import { describe, it, expect, vi } from 'vitest';
import type { BskyAgent } from '@atproto/api';

vi.mock(import('../../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));

const { findOwnReply } = await import('../../src/services/bluesky.js');

const MENTION_URI = 'at://did:plc:someone/app.bsky.feed.post/mention';
const SINCE = new Date('2026-11-01T00:00:00.000Z');

type OwnPost = { uri: string; cid: string; value: { createdAt: string; reply?: unknown } };

const ownPost = (id: string, createdAt: string, parentUri?: string): OwnPost => ({
  uri: `at://did:plc:bot/app.bsky.feed.post/${id}`,
  cid: `bafy-${id}`,
  value: {
    createdAt,
    reply: parentUri ? { parent: { uri: parentUri }, root: { uri: parentUri } } : undefined,
  },
});

// Pages of our own posts, newest first, like listRecords
const makeAgent = (pages: OwnPost[][], { endless = false } = {}) => {
  const listRecords = vi.fn<
    (params: { repo: string; cursor?: string }) => Promise<{
      data: { records: OwnPost[]; cursor?: string };
    }>
  >(async ({ cursor }) => {
    const index = cursor ? Number(cursor) : 0;
    const hasNextPage = endless || index + 1 < pages.length;
    return {
      data: {
        records: pages[index] ?? pages[pages.length - 1],
        cursor: hasNextPage ? String(index + 1) : undefined,
      },
    };
  });

  const agent = {
    assertDid: 'did:plc:bot',
    com: { atproto: { repo: { listRecords } } },
  } as unknown as BskyAgent;

  return { agent, listRecords };
};

describe(findOwnReply, () => {
  it('finds a reply we already posted, even a few pages back', async () => {
    const { agent, listRecords } = makeAgent([
      [ownPost('1', '2026-11-03T00:00:00.000Z', 'at://did:plc:other/app.bsky.feed.post/x')],
      [ownPost('reply', '2026-11-02T00:00:00.000Z', MENTION_URI)],
    ]);

    await expect(findOwnReply(agent, MENTION_URI, SINCE)).resolves.toStrictEqual({
      uri: 'at://did:plc:bot/app.bsky.feed.post/reply',
      cid: 'bafy-reply',
    });
    expect(listRecords).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'did:plc:bot' }),
      expect.anything(),
    );
  });

  it('stops looking once it reaches posts from before the first attempt', async () => {
    const { agent, listRecords } = makeAgent([
      [ownPost('1', '2026-11-03T00:00:00.000Z'), ownPost('2', '2026-10-30T00:00:00.000Z')],
      // Older than the first attempt, so it can't be the reply
      [ownPost('old', '2026-10-01T00:00:00.000Z', MENTION_URI)],
    ]);

    await expect(findOwnReply(agent, MENTION_URI, SINCE)).resolves.toBeNull();
    expect(listRecords).toHaveBeenCalledOnce();
  });

  it('returns null when it runs out of posts', async () => {
    const { agent } = makeAgent([[ownPost('1', '2026-11-03T00:00:00.000Z')]]);

    await expect(findOwnReply(agent, MENTION_URI, SINCE)).resolves.toBeNull();
  });

  it("throws rather than risk a second reply when it can't check far enough back", async () => {
    const { agent } = makeAgent([[ownPost('1', '2026-11-03T00:00:00.000Z')]], { endless: true });

    await expect(findOwnReply(agent, MENTION_URI, SINCE)).rejects.toThrow(
      /Couldn't rule out an earlier reply/u,
    );
  });
});
