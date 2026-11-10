import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BskyAgent } from '@atproto/api';
import type { Notification } from '../../src/types.js';

const logger = vi.hoisted(() => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<(message: string) => void>(),
  error: vi.fn<() => void>(),
}));

vi.mock(import('../../src/services/logger.js'), () => logger);

const { getMentions, markNotificationsAsRead } = await import('../../src/services/bluesky.js');

type Page = Notification[];

const makeNotification = (overrides: Partial<Notification>): Notification =>
  ({
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
  }) as unknown as Notification;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

// Pages are cursor-indexed, exactly like listNotifications: newest page first,
// and the cursor points at the next page
const makeAgent = (pages: Page[]) => {
  const listNotifications = vi.fn<
    (params: {
      cursor?: string;
    }) => Promise<{ data: { notifications: Notification[]; cursor?: string } }>
  >(async ({ cursor }) => {
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

  it('returns a bookmark without fetching the next page before this one is stored', async () => {
    const { agent, listNotifications } = makeAgent([
      [makeNotification({ indexedAt: hoursAgo(1) })],
      [makeNotification({ indexedAt: hoursAgo(2) })],
    ]);

    const page = await getMentions(agent);

    expect(listNotifications).toHaveBeenCalledOnce();
    expect(page.nextCursor).toBe('1');
    expect(page.mentions).toHaveLength(1);
  });

  it('finishes at a fully-read page', async () => {
    const { agent } = makeAgent([
      [makeNotification({ isRead: true })],
      [makeNotification({ isRead: true })],
    ]);

    const page = await getMentions(agent);
    expect(page.nextCursor).toBeNull();
  });

  it('resumes at the supplied cursor', async () => {
    const older = makeNotification({ uri: 'at://did:plc:a/app.bsky.feed.post/older' });
    const { agent, listNotifications } = makeAgent([[makeNotification({})], [older]]);

    const page = await getMentions(agent, '1');
    expect(page.mentions).toStrictEqual([older]);
    expect(listNotifications).toHaveBeenCalledExactlyOnceWith(
      { cursor: '1', limit: 100 },
      expect.anything(),
    );
  });

  it('derives latestIndexedAt from the newest notification actually fetched', async () => {
    const newest = hoursAgo(1);
    const { agent } = makeAgent([
      [
        // A newer, already-read like still sets the ceiling for seenAt
        makeNotification({ reason: 'like', isRead: true, indexedAt: newest }),
        makeNotification({ indexedAt: hoursAgo(2) }),
      ],
      [makeNotification({ isRead: true, indexedAt: hoursAgo(3) })],
    ]);

    const { latestIndexedAt } = await getMentions(agent);

    expect(latestIndexedAt).toBe(newest);
  });

  it('returns only unread mentions', async () => {
    const { agent } = makeAgent([
      [
        makeNotification({ uri: 'at://did:plc:a/app.bsky.feed.post/unread-mention' }),
        makeNotification({ uri: 'at://did:plc:a/app.bsky.feed.post/read-mention', isRead: true }),
        makeNotification({ uri: 'at://did:plc:a/app.bsky.feed.post/unread-like', reason: 'like' }),
        makeNotification({
          uri: 'at://did:plc:a/app.bsky.feed.post/unread-reply',
          reason: 'reply',
        }),
      ],
    ]);

    const { mentions } = await getMentions(agent);

    expect(mentions.map((mention) => mention.uri)).toStrictEqual([
      'at://did:plc:a/app.bsky.feed.post/unread-mention',
    ]);
  });

  it('keeps an unread backlog eligible even when it is older than seven days', async () => {
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { agent } = makeAgent([
      [makeNotification({ indexedAt: longAgo })],
      [makeNotification({ indexedAt: longAgo })],
    ]);

    const page = await getMentions(agent);

    expect(page.mentions).toHaveLength(1);
    expect(page.nextCursor).toBe('1');
  });

  it('follows an empty page when the API supplies another cursor', async () => {
    const { agent } = makeAgent([[], [makeNotification({})]]);
    const page = await getMentions(agent);
    expect(page.nextCursor).toBe('1');
  });

  it('reports nothing to mark as read when there are no notifications', async () => {
    const { agent } = makeAgent([[]]);

    const { mentions, latestIndexedAt } = await getMentions(agent);

    expect(mentions).toStrictEqual([]);
    expect(latestIndexedAt).toBeNull();
  });
});

// A real agent over a fake server, so responses go through the same lexicon
// validation they would in production
const makeRealAgent = (respond: () => { status: number; body: unknown }) =>
  new BskyAgent({
    service: 'https://pds.example',
    fetch: async () => {
      const { status, body } = respond();
      return Response.json(body, { status });
    },
  });

const validNotification = (id: string) => ({
  uri: `at://did:plc:someone/app.bsky.feed.post/${id}`,
  cid: 'bafyreihii74kynbhetoy37fuqwzux6cnbhmwkmtmlsigo6jcc4lrgjgoja',
  author: { did: 'did:plc:someone', handle: 'someone.bsky.social' },
  reason: 'mention',
  record: {},
  isRead: false,
  indexedAt: hoursAgo(1),
});

describe('getMentions with notifications Bluesky serves but the lexicon rejects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips the one bad notification instead of failing the whole page', async () => {
    const agent = makeRealAgent(() => ({
      status: 200,
      body: {
        notifications: [
          validNotification('good'),
          {
            ...validNotification('bad'),
            // One grapheme over the limit, like the October outage's alt text
            author: {
              did: 'did:plc:other',
              handle: 'other.bsky.social',
              displayName: 'x'.repeat(65),
            },
          },
          validNotification('also-good'),
        ],
      },
    }));

    const { mentions } = await getMentions(agent);

    expect(mentions.map((mention) => mention.uri)).toStrictEqual([
      'at://did:plc:someone/app.bsky.feed.post/good',
      'at://did:plc:someone/app.bsky.feed.post/also-good',
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /Skipping notification at:\/\/did:plc:someone\/app.bsky.feed.post\/bad.*displayName/u,
      ),
    );
  });

  it.each([false, true])(
    'keeps the next page when filtering leaves only read notifications (empty: %s)',
    async (empty) => {
      const agent = makeRealAgent(() => ({
        status: 200,
        body: {
          notifications: [
            {
              ...validNotification('bad'),
              author: { ...validNotification('bad').author, displayName: 'x'.repeat(65) },
            },
            ...(empty ? [] : [{ ...validNotification('read'), isRead: true }]),
          ],
          cursor: 'older-page',
        },
      }));

      const page = await getMentions(agent);

      expect(page.mentions).toStrictEqual([]);
      expect(page.nextCursor).toBe('older-page');
    },
  );

  it('still throws on errors that are not about validation', async () => {
    const agent = makeRealAgent(() => ({
      status: 500,
      body: { error: 'InternalServerError', message: 'Internal Server Error' },
    }));

    await expect(getMentions(agent)).rejects.toThrow('Internal Server Error');
  });

  it('does not treat an invalid pagination cursor as the end of the inbox', async () => {
    const agent = makeRealAgent(() => ({
      status: 200,
      body: { notifications: [validNotification('good')], cursor: 123 },
    }));

    await expect(getMentions(agent)).rejects.toThrow('invalid response');
  });
});

describe('markNotificationsAsRead', () => {
  it('marks notifications read up to the timestamp it is given, not "now"', async () => {
    const updateSeen = vi.fn<(args: { seenAt: string }) => void>();
    const agent = {
      app: { bsky: { notification: { updateSeen } } },
    } as unknown as BskyAgent;

    await markNotificationsAsRead(agent, '2026-01-05T12:00:00.000Z');

    expect(updateSeen).toHaveBeenCalledWith(
      { seenAt: '2026-01-05T12:00:00.000Z' },
      expect.anything(),
    );
  });
});
