import { describe, it, expect, vi, beforeEach } from 'vitest';

const tx = vi.hoisted(() => ({
  mention: {
    findFirst: vi.fn<() => Promise<unknown>>(),
    update: vi.fn<(args: { where: unknown; data: unknown }) => Promise<unknown>>(),
  },
}));

vi.mock(import('@prisma/client'), () => ({
  PrismaClient: vi.fn<() => unknown>(() => ({
    $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
  })),
}));

const { getUnprocessedMention } = await import('../../src/services/database.js');

describe(getUnprocessedMention, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.mention.update.mockResolvedValue({});
  });

  it('counts the attempt in the same transaction that claims the mention', async () => {
    tx.mention.findFirst.mockResolvedValue({ id: 'mention-id', firstAttemptedAt: null });

    await getUnprocessedMention();

    expect(tx.mention.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'mention-id' },
      data: {
        status: 'ANALYZING',
        attempts: { increment: 1 },
        firstAttemptedAt: expect.any(Date),
      },
    });
  });

  it('keeps the time of the first attempt on later attempts', async () => {
    const firstAttemptedAt = new Date('2026-10-24T19:16:33.000Z');
    tx.mention.findFirst.mockResolvedValue({ id: 'mention-id', firstAttemptedAt });

    await getUnprocessedMention();

    expect(tx.mention.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ firstAttemptedAt }) }),
    );
  });

  it('returns null without claiming anything when the queue is empty', async () => {
    tx.mention.findFirst.mockResolvedValue(null);

    await expect(getUnprocessedMention()).resolves.toBeNull();
    expect(tx.mention.update).not.toHaveBeenCalled();
  });
});
