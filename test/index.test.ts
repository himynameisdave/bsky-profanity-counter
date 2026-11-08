import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  // The entrypoint refuses to start without credentials
  process.env.BLUESKY_IDENTIFIER ||= 'test.bot';
  process.env.BLUESKY_PASSWORD ||= 'test-password';
});

const db = vi.hoisted(() => ({
  resetStuckMentions: vi.fn<() => Promise<number>>(),
  disconnect: vi.fn<() => Promise<void>>(),
}));
const bsky = vi.hoisted(() => ({
  createAgent: vi.fn<() => Promise<unknown>>(),
  getMentions: vi.fn<() => Promise<unknown>>(),
}));

vi.mock(import('../src/services/database.js'), () => db);
vi.mock(import('../src/services/bluesky.js'), () => bsky);
const analysis = vi.hoisted(() => ({
  checkAndProcessMentions: vi.fn<() => Promise<void>>(),
}));

vi.mock(import('../src/mentions.js'), () => ({ default: vi.fn<() => Promise<void>>() }));
vi.mock(import('../src/analysis.js'), () => analysis);
vi.mock(import('../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));

describe('the entrypoint', () => {
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);

    db.resetStuckMentions.mockResolvedValue(0);
    db.disconnect.mockResolvedValue();
    bsky.createAgent.mockResolvedValue({});
    bsky.getMentions.mockResolvedValue({ mentions: [], latestIndexedAt: null });
  });

  afterEach(() => {
    exit.mockRestore();
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
});
