import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mention, Prisma, PrismaClient } from '@prisma/client';

const { createMany, findUniqueOrThrow } = vi.hoisted(() => ({
  createMany: vi.fn<(args: Prisma.MentionCreateManyArgs) => Promise<Prisma.BatchPayload>>(),
  findUniqueOrThrow: vi.fn<(args: Prisma.MentionFindUniqueOrThrowArgs) => Promise<Mention>>(),
}));

vi.mock(import('@prisma/client'), () => ({
  PrismaClient: class {
    mention = { createMany, findUniqueOrThrow };
  } as unknown as typeof PrismaClient,
}));

const { storeMention } = await import('../../src/services/database.js');

const mention = {
  did: 'did:plc:someone',
  userHandle: 'someone.bsky.social',
  postId: 'abc123',
  postUrl: 'at://did:plc:someone/app.bsky.feed.post/abc123',
  isReply: false,
};

describe(storeMention, () => {
  beforeEach(() => {
    vi.resetAllMocks();
    createMany.mockResolvedValue({ count: 0 });
  });

  it('inserts atomically with database conflict handling, then reads by the full URI', async () => {
    await storeMention(mention);
    await storeMention(mention);

    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany).toHaveBeenCalledWith({ data: mention, skipDuplicates: true });
    expect(findUniqueOrThrow).toHaveBeenCalledTimes(2);
    expect(findUniqueOrThrow).toHaveBeenCalledWith({ where: { postUrl: mention.postUrl } });
    expect(createMany.mock.invocationCallOrder[0]).toBeLessThan(
      findUniqueOrThrow.mock.invocationCallOrder[0],
    );
  });

  it.each(['DONE', 'FAILED'] as const)(
    'preserves all metadata when replaying a %s mention',
    async (status) => {
      const existing: Mention = {
        ...mention,
        id: 'existing-id',
        status,
        attempts: 3,
        lastError: 'previous error',
        firstAttemptedAt: new Date('2026-01-01T00:00:00.000Z'),
        analysisId: 'existing-analysis',
        replyPostId: 'existing-reply',
        replyUrl: 'at://did:plc:bot/app.bsky.feed.post/existing-reply',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      };
      findUniqueOrThrow.mockResolvedValue(existing);

      const result = await storeMention({
        ...mention,
        did: 'did:plc:changed',
        userHandle: 'changed.bsky.social',
        isReply: true,
      });

      expect(result).toStrictEqual(existing);
      // No update statement, even if the newly resolved target has changed.
      expect(createMany).toHaveBeenCalledExactlyOnceWith({
        data: {
          ...mention,
          did: 'did:plc:changed',
          userHandle: 'changed.bsky.social',
          isReply: true,
        },
        skipDuplicates: true,
      });
    },
  );

  it('propagates insert failures', async () => {
    createMany.mockRejectedValue(new Error('insert failed'));

    await expect(storeMention(mention)).rejects.toThrow('insert failed');
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('does not report success if a conflict did not persist this URI', async () => {
    findUniqueOrThrow.mockRejectedValue(new Error('URI not stored'));

    await expect(storeMention(mention)).rejects.toThrow('URI not stored');
  });
});
