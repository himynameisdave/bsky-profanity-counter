import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BskyAgent } from '@atproto/api';
import type { Notification } from '../src/types.js';

vi.mock(import('../src/services/database.js'), () => ({
  storeMention: vi.fn<(mention: { userHandle: string; postId: string }) => Promise<unknown>>(),
}));

vi.mock(import('../src/services/bluesky.js'), () => ({
  markNotificationsAsRead: vi.fn<(agent: unknown, seenAt: string) => Promise<void>>(),
  getPost: vi.fn<() => void>(),
  getProfile: vi.fn<() => void>(),
}));

vi.mock(import('../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));

const db = await import('../src/services/database.js');
const bsky = await import('../src/services/bluesky.js');
const { default: storeMentions } = await import('../src/mentions.js');

const agent = {} as BskyAgent;

const makeMention = (id: string, indexedAt: string): Notification =>
  ({
    uri: `at://did:plc:someone/app.bsky.feed.post/${id}`,
    cid: 'bafycid',
    author: {
      did: 'did:plc:someone',
      handle: 'someone.bsky.social',
    },
    reason: 'mention',
    record: {},
    isRead: false,
    indexedAt,
    labels: [],
  }) as unknown as Notification;

describe(storeMentions, () => {
  beforeEach(() => {
    // Reset, not clear: these tests swap in their own storeMention implementations
    vi.resetAllMocks();
  });

  it('marks notifications read up to the newest one fetched when everything stores', async () => {
    const mentions = [
      makeMention('2', '2026-01-02T00:00:00.000Z'),
      makeMention('1', '2026-01-01T00:00:00.000Z'),
    ];

    await storeMentions(agent, mentions, '2026-01-02T06:00:00.000Z');

    expect(db.storeMention).toHaveBeenCalledTimes(2);
    // Oldest first, so the read cursor only ever moves over stored mentions
    expect(vi.mocked(db.storeMention).mock.calls.map(([data]) => data.postId)).toStrictEqual([
      '1',
      '2',
    ]);
    expect(bsky.markNotificationsAsRead).toHaveBeenCalledWith(agent, '2026-01-02T06:00:00.000Z');
  });

  it('advances the read cursor only up to the last mention stored before a failure', async () => {
    const mentions = [
      makeMention('1', '2026-01-01T00:00:00.000Z'),
      makeMention('2', '2026-01-02T00:00:00.000Z'),
      makeMention('3', '2026-01-03T00:00:00.000Z'),
    ];

    vi.mocked(db.storeMention).mockImplementation(async ({ postId }) => {
      if (postId === '2') {
        throw new Error('💥 database is having a day');
      }
      return {} as any;
    });

    await storeMentions(agent, mentions, '2026-01-03T12:00:00.000Z');

    // The failed mention (and the one after it) stay unread for the next run
    expect(bsky.markNotificationsAsRead).toHaveBeenCalledWith(agent, '2026-01-01T00:00:00.000Z');
  });

  it('does not mark anything read when the oldest mention fails to store', async () => {
    const mentions = [
      makeMention('1', '2026-01-01T00:00:00.000Z'),
      makeMention('2', '2026-01-02T00:00:00.000Z'),
    ];

    vi.mocked(db.storeMention).mockRejectedValue(new Error('💥 database is having a day'));

    await storeMentions(agent, mentions, '2026-01-02T12:00:00.000Z');

    expect(bsky.markNotificationsAsRead).not.toHaveBeenCalled();
  });

  it('still advances the read cursor when the batch had no mentions in it', async () => {
    await storeMentions(agent, [], '2026-01-02T12:00:00.000Z');

    expect(db.storeMention).not.toHaveBeenCalled();
    expect(bsky.markNotificationsAsRead).toHaveBeenCalledWith(agent, '2026-01-02T12:00:00.000Z');
  });

  it('does nothing when no notifications were fetched at all', async () => {
    await storeMentions(agent, [], null);

    expect(bsky.markNotificationsAsRead).not.toHaveBeenCalled();
  });
});
