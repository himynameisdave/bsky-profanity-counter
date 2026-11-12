import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { DUPLICATE_SNAPSHOT_REASON } from '../../src/services/identity-backfill.js';

const { queryRaw } = vi.hoisted(() => ({
  queryRaw:
    vi.fn<
      (strings: TemplateStringsArray, ...values: unknown[]) => Promise<[{ total: bigint | null }]>
    >(),
}));

vi.mock(import('../../src/generated/prisma/client.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  // Just enough of a client for the query under test
  PrismaClient: class {
    $queryRaw = queryRaw;
    $disconnect = async () => {};
  } as unknown as typeof PrismaClient,
}));

const { init, disconnect, getTotalProfanityCount } = await import('../../src/services/database.js');
const URL = 'postgresql://test:test@localhost:5432/test';
init({ url: URL });

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

  // Not left to search_path, which a role can set to put another schema first
  it("names both of its tables in the generated queries' schema, public by default", async () => {
    await getTotalProfanityCount();

    const { text } = sentQuery();
    expect(text.match(/"public"\."Analysis"/gu)).toHaveLength(2);
    expect(text).not.toMatch(/FROM "Analysis"/u);
  });

  it("names both of its tables in the URL's schema when it has one", async () => {
    await disconnect();
    init({ url: `${URL}?schema=bot_data`, schema: 'bot_data' });
    try {
      await getTotalProfanityCount();
    } finally {
      await disconnect();
      init({ url: URL });
    }

    expect(sentQuery().text.match(/"bot_data"\."Analysis"/gu)).toHaveLength(2);
  });

  it('is zero before anyone has been analyzed', async () => {
    queryRaw.mockResolvedValue([{ total: null }]);

    await expect(getTotalProfanityCount()).resolves.toBe(0);
  });
});
