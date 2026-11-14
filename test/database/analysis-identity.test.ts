import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

const queries = vi.hoisted(() => ({
  findUnique: vi.fn<(args: unknown) => Promise<unknown>>(),
  upsert: vi.fn<(args: unknown) => Promise<unknown>>(),
  update: vi.fn<(args: unknown) => Promise<unknown>>(),
  updateMany: vi.fn<(args: unknown) => Promise<unknown>>(),
  transaction: vi.fn<(args: unknown) => Promise<unknown>>(),
}));
vi.mock(import('../../src/generated/prisma/client.js'), () => ({
  PrismaClient: class {
    analysis = {
      findUnique: queries.findUnique,
      upsert: queries.upsert,
      updateMany: queries.updateMany,
    };
    mention = { update: queries.update };
    $transaction = queries.transaction;
  } as unknown as typeof PrismaClient,
}));
const { init, findAnalysis, createOrUpdateAnalysis, refreshTargetHandle, recordMentionError } =
  await import('../../src/services/database.js');
init({ url: 'postgresql://test:test@localhost:5432/test' });

beforeEach(() => vi.clearAllMocks());

describe('canonical analysis identity', () => {
  it('queries by DID and upserts renames into the same row without adding old totals', async () => {
    const data = {
      did: 'did:plc:one',
      userHandle: 'old.example.com',
      totalPosts: 10,
      profanityCount: 7,
      profanityDetails: { wordCounts: { shit: 7 }, topProfanities: [] },
    };
    await findAnalysis(data.did);
    expect(queries.findUnique).toHaveBeenCalledExactlyOnceWith({ where: { did: data.did } });
    await createOrUpdateAnalysis(data);
    const renamed = { ...data, userHandle: 'new.example.com', totalPosts: 12, profanityCount: 9 };
    await createOrUpdateAnalysis(renamed);
    expect(queries.upsert).toHaveBeenLastCalledWith({
      where: { did: data.did },
      create: renamed,
      update: {
        userHandle: renamed.userHandle,
        totalPosts: 12,
        profanityCount: 9,
        profanityDetails: data.profanityDetails,
        lastAnalyzedAt: expect.any(Date),
      },
    });
  });

  it('refreshes mention and analysis display without extending the cache timestamp', async () => {
    await refreshTargetHandle('mention', 'did:plc:one', 'new.example.com');
    expect(queries.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'mention' },
      data: { userHandle: 'new.example.com' },
    });
    expect(queries.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { did: 'did:plc:one' },
      data: { userHandle: 'new.example.com' },
    });
    expect(queries.transaction).toHaveBeenCalledOnce();
  });

  it('persists retry errors without changing status or attempt history', async () => {
    await recordMentionError('mention', 'Network failed');
    expect(queries.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'mention' },
      data: { lastError: 'Network failed' },
    });
  });
});
