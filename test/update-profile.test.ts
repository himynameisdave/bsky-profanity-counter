import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import type { BskyAgent } from '@atproto/api';
import type * as Db from '../src/services/database.js';
import type * as Bsky from '../src/services/bluesky.js';
import type * as ProfileUpdater from '../src/services/profile-updater.js';
import type * as Config from '../src/config.js';

const ENV = {
  bluesky: { identifier: 'test.bot', password: 'test-password' },
  database: { url: 'postgresql://test:test@localhost:5432/test' },
};

const db = vi.hoisted(() => ({
  init: vi.fn<typeof Db.init>(),
  disconnect: vi.fn<typeof Db.disconnect>(),
}));
const bsky = vi.hoisted(() => ({
  createAgent: vi.fn<typeof Bsky.createAgent>(),
}));
const profileUpdater = vi.hoisted(() => ({
  updateProfileDescription: vi.fn<typeof ProfileUpdater.updateProfileDescription>(),
}));
const loadEnv = vi.hoisted(() => vi.fn<typeof Config.loadEnv>());

vi.mock(import('../src/services/database.js'), () => db);
// The real withTimeout, around a mocked login and update
vi.mock(import('../src/services/bluesky.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  ...bsky,
}));
vi.mock(import('../src/services/profile-updater.js'), () => profileUpdater);
vi.mock(import('../src/config.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  loadEnv,
}));
vi.mock(import('../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));

describe('the profile update entrypoint', () => {
  let exit: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);

    loadEnv.mockReturnValue(ENV);
    db.disconnect.mockResolvedValue();
    bsky.createAgent.mockResolvedValue({} as BskyAgent);
    profileUpdater.updateProfileDescription.mockResolvedValue();
  });

  afterEach(() => {
    exit.mockRestore();
  });

  it('sets up the database from the validated environment before logging in or querying', async () => {
    await import('../src/update-profile.js');

    expect(db.init).toHaveBeenCalledExactlyOnceWith(ENV.database);
    expect(db.init.mock.invocationCallOrder[0]).toBeLessThan(
      bsky.createAgent.mock.invocationCallOrder[0],
    );
    expect(db.init.mock.invocationCallOrder[0]).toBeLessThan(
      profileUpdater.updateProfileDescription.mock.invocationCallOrder[0],
    );
  });

  it('disconnects once the update is done, without forcing an exit', async () => {
    await import('../src/update-profile.js');

    expect(db.disconnect).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it('disconnects before exiting with an error when the update fails', async () => {
    profileUpdater.updateProfileDescription.mockRejectedValue(new Error('Internal Server Error'));

    await import('../src/update-profile.js');

    expect(db.disconnect).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(db.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      exit.mock.invocationCallOrder[0],
    );
  });

  it("still disconnects and exits with an error when it can't log in", async () => {
    bsky.createAgent.mockRejectedValue(new Error('AuthenticationRequired'));

    await import('../src/update-profile.js');

    expect(profileUpdater.updateProfileDescription).not.toHaveBeenCalled();
    expect(db.disconnect).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('fails before touching the database or Bluesky when a variable is missing', async () => {
    loadEnv.mockImplementation(() => {
      throw new Error('🕵️ Missing environment variables: DATABASE_URL');
    });

    await expect(import('../src/update-profile.js')).rejects.toThrow(
      'Missing environment variables: DATABASE_URL',
    );

    expect(db.init).not.toHaveBeenCalled();
    expect(bsky.createAgent).not.toHaveBeenCalled();
  });
});
