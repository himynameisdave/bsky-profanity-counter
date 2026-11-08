import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MockInstance } from 'vitest';
import type { BskyAgent } from '@atproto/api';
import type * as Db from '../src/services/database.js';
import type * as Bsky from '../src/services/bluesky.js';
import type * as Analysis from '../src/analysis.js';
import type * as Config from '../src/config.js';

const ENV = { bluesky: { identifier: 'test.bot', password: 'test-password' } };

const db = vi.hoisted(() => ({
  resetStuckMentions: vi.fn<typeof Db.resetStuckMentions>(),
  disconnect: vi.fn<typeof Db.disconnect>(),
}));
const bsky = vi.hoisted(() => ({
  createAgent: vi.fn<typeof Bsky.createAgent>(),
  getMentions: vi.fn<typeof Bsky.getMentions>(),
}));
const analysis = vi.hoisted(() => ({
  checkAndProcessMentions: vi.fn<typeof Analysis.checkAndProcessMentions>(),
}));
const loadEnv = vi.hoisted(() => vi.fn<typeof Config.loadEnv>());

vi.mock(import('../src/services/database.js'), () => db);
vi.mock(import('../src/services/bluesky.js'), () => bsky);
vi.mock(import('../src/mentions.js'), () => ({ default: vi.fn<() => Promise<void>>() }));
vi.mock(import('../src/analysis.js'), () => analysis);
// Keep the real limits, but not the real environment or `.env`
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

describe('the entrypoint', () => {
  let exit: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);

    loadEnv.mockReturnValue(ENV);
    db.resetStuckMentions.mockResolvedValue(0);
    db.disconnect.mockResolvedValue();
    bsky.createAgent.mockResolvedValue({} as BskyAgent);
    bsky.getMentions.mockResolvedValue({ mentions: [], latestIndexedAt: null });
    analysis.checkAndProcessMentions.mockResolvedValue();
  });

  afterEach(() => {
    exit.mockRestore();
    vi.unstubAllEnvs();
    // Don't let the run's exit code leak into vitest's own
    process.exitCode = undefined;
  });

  // A request we gave up on can stay open after it's aborted, and would keep
  // the process alive, with its work done, until the workflow timeout
  it('disconnects and exits once the run is done, without waiting on stray sockets', async () => {
    await import('../src/index.js');

    expect(db.disconnect).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('still disconnects and exits when the run fails', async () => {
    bsky.getMentions.mockRejectedValue(new Error('Internal Server Error'));

    await import('../src/index.js');

    expect(db.disconnect).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('still works through the queued mentions when fetching new ones fails', async () => {
    bsky.getMentions.mockRejectedValue(new Error('Internal Server Error'));

    await import('../src/index.js');

    expect(analysis.checkAndProcessMentions).toHaveBeenCalledOnce();
  });

  it("doesn't try to process anything when it can't log in", async () => {
    bsky.createAgent.mockRejectedValue(new Error('AuthenticationRequired'));

    await import('../src/index.js');

    expect(analysis.checkAndProcessMentions).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('logs in with the credentials from the environment', async () => {
    await import('../src/index.js');

    expect(bsky.createAgent).toHaveBeenCalledExactlyOnceWith(ENV.bluesky);
  });

  it('fails before touching the database or Bluesky when a variable is missing', async () => {
    loadEnv.mockImplementation(() => {
      throw new Error('🕵️ Missing environment variables: DATABASE_URL');
    });

    await expect(import('../src/index.js')).rejects.toThrow('DATABASE_URL');

    expect(db.resetStuckMentions).not.toHaveBeenCalled();
    expect(bsky.createAgent).not.toHaveBeenCalled();
  });

  it("exits with an error when it can't log in, so the job goes red", async () => {
    bsky.createAgent.mockRejectedValue(new Error('AuthenticationRequired'));

    await import('../src/index.js');

    expect(process.exitCode).toBe(1);
  });

  it('exits with an error when a mention fails', async () => {
    analysis.checkAndProcessMentions.mockImplementation(async () => {
      const { stats } = await import('../src/run-stats.js');
      stats.failed++;
    });

    await import('../src/index.js');

    expect(process.exitCode).toBe(1);
  });

  it('exits cleanly when there was nothing to do', async () => {
    await import('../src/index.js');

    expect(process.exitCode).toBe(0);
  });

  it('writes a run summary for GitHub Actions', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'summary-'));
    const summaryPath = path.join(dir, 'summary.md');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summaryPath);
    bsky.getMentions.mockResolvedValue({
      mentions: [{}, {}] as Awaited<ReturnType<typeof Bsky.getMentions>>['mentions'],
      latestIndexedAt: null,
    });

    await import('../src/index.js');

    const summary = readFileSync(summaryPath, 'utf8');
    expect(summary).toContain('| Result | ✅ OK |');
    expect(summary).toContain('| Mentions fetched | 2 |');
  });
});
