import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { aggregate } = vi.hoisted(() => ({
  aggregate:
    vi.fn<(args: { where: unknown }) => Promise<{ _sum: { profanityCount: number | null } }>>(),
}));

vi.mock(import('@prisma/client'), () => ({
  // Just enough of a client for the query under test
  PrismaClient: vi.fn<() => unknown>(() => ({
    analysis: { aggregate },
  })) as unknown as typeof PrismaClient,
}));

const { getTotalProfanityCount } = await import('../../src/services/database.js');

describe(getTotalProfanityCount, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aggregate.mockResolvedValue({ _sum: { profanityCount: 1234 } });
  });

  it('leaves out the DID it is told to, so the bot never counts itself', async () => {
    await expect(getTotalProfanityCount({ excludeDid: 'did:plc:counter' })).resolves.toBe(1234);

    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { did: { not: 'did:plc:counter' } } }),
    );
  });

  it('excludes quarantined legacy analyses even without a bot DID', async () => {
    await getTotalProfanityCount();

    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { did: { not: null } } }),
    );
  });

  it('is zero before anyone has been analyzed', async () => {
    aggregate.mockResolvedValue({ _sum: { profanityCount: null } });

    await expect(getTotalProfanityCount()).resolves.toBe(0);
  });
});
