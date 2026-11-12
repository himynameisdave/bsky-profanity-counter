import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaPg } from '@prisma/adapter-pg';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { DATABASE_CONNECT_TIMEOUT_MS, DATABASE_POOL_MAX } from '../../src/config.js';

const URL = 'postgresql://test:test@localhost:5432/test';

const mocks = vi.hoisted(() => ({
  newAdapter: vi.fn<(config: unknown, options?: unknown) => void>(),
  newClient: vi.fn<(options: unknown) => void>(),
  $disconnect: vi.fn<() => Promise<void>>(),
  count: vi.fn<() => Promise<number>>(),
}));

vi.mock(import('@prisma/adapter-pg'), () => ({
  PrismaPg: mocks.newAdapter as unknown as typeof PrismaPg,
}));
vi.mock(import('../../src/generated/prisma/client.js'), () => ({
  PrismaClient: class {
    $disconnect = mocks.$disconnect;
    mention = { count: mocks.count };
    constructor(options: unknown) {
      mocks.newClient(options);
    }
  } as unknown as typeof PrismaClient,
}));

// Each test gets a fresh copy of the module, and with it a fresh client slot
const importDatabase = async () => {
  vi.resetModules();
  return import('../../src/services/database.js');
};

describe('setting up the database service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.$disconnect.mockResolvedValue();
    mocks.count.mockResolvedValue(3);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("doesn't read the environment or make a client when it's imported", async () => {
    vi.stubEnv('DATABASE_URL', URL);
    const read: PropertyKey[] = [];
    const { env } = process;
    process.env = new Proxy(env, {
      get: (target, key) => {
        read.push(key);
        return Reflect.get(target, key);
      },
    });

    try {
      await importDatabase();
    } finally {
      process.env = env;
    }

    expect(read).not.toContain('DATABASE_URL');
    expect(mocks.newAdapter).not.toHaveBeenCalled();
    expect(mocks.newClient).not.toHaveBeenCalled();
  });

  it('makes one adapter and one client from the config it is given', async () => {
    const db = await importDatabase();

    db.init({ url: URL });

    const [[config, options]] = mocks.newAdapter.mock.calls;
    expect(mocks.newAdapter).toHaveBeenCalledOnce();
    expect(config).toStrictEqual({
      connectionString: URL,
      max: DATABASE_POOL_MAX,
      connectionTimeoutMillis: DATABASE_CONNECT_TIMEOUT_MS,
      application_name: 'profanity.accountant',
    });
    expect(options).toBeUndefined();
    expect(mocks.newClient).toHaveBeenCalledExactlyOnceWith({
      adapter: mocks.newAdapter.mock.instances[0],
    });
    await expect(db.getUnprocessedMentionsCount()).resolves.toBe(3);
  });

  it('gives up waiting for a connection, unlike the pg default', () => {
    expect(DATABASE_CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DATABASE_CONNECT_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it('refuses to make a second client in the same run', async () => {
    const db = await importDatabase();
    db.init({ url: URL });

    expect(() => db.init({ url: URL })).toThrow('already initialized');
    expect(mocks.newClient).toHaveBeenCalledOnce();
  });

  it('says so, rather than connecting somewhere, when used before init', async () => {
    const db = await importDatabase();

    await expect(db.getUnprocessedMentionsCount()).rejects.toThrow('not initialized');
    expect(mocks.newClient).not.toHaveBeenCalled();
  });

  it('is safe to disconnect when startup failed before init', async () => {
    const db = await importDatabase();

    await expect(db.disconnect()).resolves.toBeUndefined();
    expect(mocks.$disconnect).not.toHaveBeenCalled();
  });

  it('closes the pool once, and never quietly reopens it', async () => {
    const db = await importDatabase();
    db.init({ url: URL });

    await db.disconnect();
    await db.disconnect();

    expect(mocks.$disconnect).toHaveBeenCalledOnce();
    await expect(db.getUnprocessedMentionsCount()).rejects.toThrow('not initialized');
  });

  it("forgets the client even if closing it fails, so it's never reused", async () => {
    const db = await importDatabase();
    db.init({ url: URL });
    mocks.$disconnect.mockRejectedValue(new Error('Connection reset'));

    await expect(db.disconnect()).rejects.toThrow('Connection reset');
    await expect(db.getUnprocessedMentionsCount()).rejects.toThrow('not initialized');
  });

  // Prisma 6 qualified its queries with the URL's schema and set search_path, so
  // raw SQL found the same tables. The pg driver does neither by itself.
  it("uses the URL's schema for generated queries and raw SQL alike", async () => {
    const db = await importDatabase();

    db.init({ url: `${URL}?schema=bot_data`, schema: 'bot_data' });

    expect(mocks.newAdapter).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ options: '-c search_path="bot_data"' }),
      { schema: 'bot_data' },
    );
  });

  // Poolers like PgBouncer can reject startup options, so don't send one for nothing
  it("doesn't set search_path for the default schema", async () => {
    const db = await importDatabase();

    db.init({ url: `${URL}?schema=public`, schema: 'public' });

    const [[config, options]] = mocks.newAdapter.mock.calls;
    expect(config).not.toHaveProperty('options');
    expect(options).toStrictEqual({ schema: 'public' });
  });
});
