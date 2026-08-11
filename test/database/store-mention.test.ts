import { describe, it, expect, vi, beforeEach } from 'vitest';

const { upsert } = vi.hoisted(() => ({
  upsert: vi.fn<(args: { where: unknown; update: unknown; create: unknown }) => Promise<unknown>>(),
}));

vi.mock(import('@prisma/client'), () => ({
  PrismaClient: vi.fn<() => { mention: { upsert: typeof upsert } }>(() => ({
    mention: { upsert },
  })),
}));

const { storeMention } = await import('../../src/services/database.js');

describe(storeMention, () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('upserts on postId so replaying a notification cannot create a second row', async () => {
    const mention = {
      userHandle: 'someone.bsky.social',
      postId: 'abc123',
      postUrl: 'at://did:plc:someone/app.bsky.feed.post/abc123',
      isReply: false,
    };

    await storeMention(mention);
    await storeMention(mention);

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith({
      where: { postId: 'abc123' },
      // A replay must not reset the status of a mention we've already replied to
      update: {},
      create: mention,
    });
  });
});
