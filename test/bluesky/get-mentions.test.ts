import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BskyAgent } from '@atproto/api';
import type { Notification } from '../../src/types.js';

vi.mock('../../src/services/logger.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// The bluesky service throws at import time without credentials
process.env.BLUESKY_IDENTIFIER = process.env.BLUESKY_IDENTIFIER || 'test.bot';
process.env.BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD || 'test-password';

const { getMentions, markNotificationsAsRead } = await import('../../src/services/bluesky.js');

type Page = Notification[];

const makeNotification = (overrides: Partial<Notification>): Notification => ({
  uri: 'at://did:plc:someone/app.bsky.feed.post/abc',
  cid: 'bafycid',
  author: {
    did: 'did:plc:someone',
    handle: 'someone.bsky.social',
  },
  reason: 'mention',
  record: {},
  isRead: false,
  indexedAt: '2026-01-01T00:00:00.000Z',
  labels: [],
  ...overrides,
} as unknown as Notification);

// Pages are cursor-indexed, exactly like listNotifications: newest page first,
// and the cursor points at the next page
const makeAgent = (pages: Page[]) => {
  const listNotifications = vi.fn(async ({ cursor }: { cursor?: string }) => {
    const index = cursor ? Number(cursor) : 0;
    const notifications = pages[index] ?? [];
    const hasNextPage = index + 1 < pages.length;

    return {
      data: {
        notifications,
        cursor: hasNextPage ? String(index + 1) : undefined,
      },
    };
  });

  return { agent: { listNotifications } as unknown as BskyAgent, listNotifications };
};

describe('getMentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops paginating after the first fully-read page', async () => {
    const { agent, listNotifications } = makeAgent([
      // Page 1: something unread, so we keep going
      [
        makeNotification({ uri: 'at://did:plc:a/app.bsky.feed.post/1', indexedAt: '2026-01-03T00:00:00.000Z' }),
        makeNotification({ uri: 'at://did:plc:a/app.bsky.feed.post/2', indexedAt: '2026-01-02T23:00:00.000Z', isRead: true }),
      ],
      // Page 2: entirely read, so page 3 should never be requested
      [
        makeNotification({ uri: 'at://did:plc:a/app.bsky.feed.post/3', indexedAt: '2026-01-02T00:00:00.000Z', isRead: true }),
      ],
      // Page 3: unread, but older than a page we've already read through
      [
        makeNotification({ uri: 'at://did:plc:a/app.bsky.feed.post/4', indexedAt: '2026-01-01T00:00:00.000Z' }),
      ],
    ]);

    const { mentions } = await getMentions(agent);

    expect(listNotifications).toHaveBeenCalledTimes(2);
    expect(mentions.map((mention) => mention.uri)).toEqual(['at://did:plc:a/app.bsky.feed.post/1']);
  });

  it('derives latestIndexedAt from the newest notification actually fetched', async () => {
    const { agent } = makeAgent([
      [
        // A newer, already-read like still sets the ceiling for seenAt
        makeNotification({ reason: 'like', isRead: true, indexedAt: '2026-01-05T12:00:00.000Z' }),
        makeNotification({ indexedAt: '2026-01-05T09:00:00.000Z' }),
      ],
      [
        makeNotification({ isRead: true, indexedAt: '2026-01-04T00:00:00.000Z' }),
      ],
    ]);

    const { latestIndexedAt } = await getMentions(agent);

    expect(latestIndexedAt).toBe('2026-01-05T12:00:00.000Z');
  });

  it('returns only unread mentions', async () => {
    const { agent } = makeAgent([
      [
        makeNotification({ uri: 'at://did:plc:a/app.bsky.feed.post/unread-mention' }),
        makeNotification({ uri: 'at://did:plc:a/app.bsky.feed.post/read-mention', isRead: true }),
        makeNotification({ uri: 'at://did:plc:a/app.bsky.feed.post/unread-like', reason: 'like' }),
        makeNotification({ uri: 'at://did:plc:a/app.bsky.feed.post/unread-reply', reason: 'reply' }),
      ],
    ]);

    const { mentions } = await getMentions(agent);

    expect(mentions.map((mention) => mention.uri)).toEqual(['at://did:plc:a/app.bsky.feed.post/unread-mention']);
  });

  it('stops paginating once notifications are older than the lookback window', async () => {
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { agent, listNotifications } = makeAgent([
      [makeNotification({ uri: 'at://did:plc:a/app.bsky.feed.post/old', indexedAt: longAgo })],
      [makeNotification({ uri: 'at://did:plc:a/app.bsky.feed.post/older', indexedAt: longAgo })],
    ]);

    await getMentions(agent);

    expect(listNotifications).toHaveBeenCalledTimes(1);
  });

  it('reports nothing to mark as read when there are no notifications', async () => {
    const { agent } = makeAgent([[]]);

    const { mentions, latestIndexedAt } = await getMentions(agent);

    expect(mentions).toEqual([]);
    expect(latestIndexedAt).toBeNull();
  });
});

describe('markNotificationsAsRead', () => {
  it('marks notifications read up to the timestamp it is given, not "now"', async () => {
    const updateSeen = vi.fn();
    const agent = {
      app: { bsky: { notification: { updateSeen } } },
    } as unknown as BskyAgent;

    await markNotificationsAsRead(agent, '2026-01-05T12:00:00.000Z');

    expect(updateSeen).toHaveBeenCalledWith({ seenAt: '2026-01-05T12:00:00.000Z' });
  });
});
