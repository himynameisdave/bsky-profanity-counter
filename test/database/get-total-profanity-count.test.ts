import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { DUPLICATE_SNAPSHOT_REASON } from '../../src/services/identity-backfill.js';

const { queryRaw } = vi.hoisted(() => ({
  queryRaw:
    vi.fn<
      (strings: TemplateStringsArray, ...values: unknown[]) => Promise<[{ total: bigint | null }]>
    >(),
}));

vi.mock(import('@prisma/client'), async (importOriginal) => ({
  ...(await importOriginal()),
  // Just enough of a client for the query under test
  PrismaClient: vi.fn<() => unknown>(() => ({
    $queryRaw: queryRaw,
  })) as unknown as typeof PrismaClient,
}));

const { getTotalProfanityCount } = await import('../../src/services/database.js');

// The query as Postgres gets it, with nested fragments flattened
const sentQuery = () => {
  const [[strings, ...values]] = queryRaw.mock.calls;
  return Prisma.sql(strings, ...values);
};

// Which rows count is the SQL's job; test/database/profile-total.integration.test.ts
// checks that against a real database.
describe(getTotalProfanityCount, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryRaw.mockResolvedValue([{ total: 1234n }]);
  });

  it('leaves out the bot by DID and by handle', async () => {
    await expect(
      getTotalProfanityCount({
        excludeDid: 'did:plc:counter',
        excludeHandle: 'counter.bsky.social',
      }),
    ).resolves.toBe(1234);

    expect(sentQuery().values).toStrictEqual([
      DUPLICATE_SNAPSHOT_REASON,
      'did:plc:counter',
      'counter.bsky.social',
    ]);
  });

  it('counts everyone when not told who the bot is', async () => {
    await getTotalProfanityCount();

    expect(sentQuery().values).toStrictEqual([DUPLICATE_SNAPSHOT_REASON]);
  });

  it('is zero before anyone has been analyzed', async () => {
    queryRaw.mockResolvedValue([{ total: null }]);

    await expect(getTotalProfanityCount()).resolves.toBe(0);
  });
});
