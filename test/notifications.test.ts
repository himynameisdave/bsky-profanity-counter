import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BskyAgent } from '@atproto/api';
import type * as Db from '../src/services/database.js';
import type { Notification } from '../src/types.js';

const db = vi.hoisted(() => ({
  getNotificationScan: vi.fn<typeof Db.getNotificationScan>(),
  saveNotificationScan: vi.fn<typeof Db.saveNotificationScan>(),
  clearNotificationScan: vi.fn<typeof Db.clearNotificationScan>(),
  storeMention: vi.fn<typeof Db.storeMention>(),
}));

vi.mock(import('../src/services/database.js'), () => db);
vi.mock(import('../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));

// Use the real collector, page reader and mention storage orchestration. Only
// the database and the API boundary are fake, including Bluesky's global seenAt.
const { collectMentions } = await import('../src/notifications.js');
const { stats } = await import('../src/run-stats.js');
const logger = await import('../src/services/logger.js');
const BOT_DID = 'did:plc:bot';
type Scan = NonNullable<Awaited<ReturnType<typeof Db.getNotificationScan>>>;
let scan: Scan | null;
let saved: Set<string>;

const notification = (id: string, indexedAt = '2026-01-01T00:00:00.000Z'): Notification => ({
  uri: `at://did:plc:someone/app.bsky.feed.post/${id}`,
  cid: 'bafyreihii74kynbhetoy37fuqwzux6cnbhmwkmtmlsigo6jcc4lrgjgoja',
  author: { did: 'did:plc:someone', handle: 'someone.bsky.social' },
  reason: 'mention',
  record: {},
  isRead: false,
  indexedAt,
});

const makeAgent = (pages: Notification[][]) => {
  let seenAt: string | undefined;
  const updateSeen = vi.fn<(args: { seenAt: string }) => Promise<void>>(
    async ({ seenAt: next }) => {
      seenAt = next;
    },
  );
  const listNotifications = vi.fn<
    (args: {
      cursor?: string;
    }) => Promise<{ data: { notifications: Notification[]; cursor?: string } }>
  >(async ({ cursor }) => {
    const index = cursor ? Number(cursor) : 0;
    return {
      data: {
        notifications: (pages[index] ?? []).map((item) => {
          const copy = structuredClone(item);
          copy.isRead ||= Boolean(seenAt && Date.parse(item.indexedAt) <= Date.parse(seenAt));
          return copy;
        }),
        cursor: index + 1 < pages.length ? String(index + 1) : undefined,
      },
    };
  });
  const agent = {
    assertDid: BOT_DID,
    listNotifications,
    app: { bsky: { notification: { updateSeen } } },
  } as unknown as BskyAgent;
  return { agent, listNotifications, updateSeen };
};

beforeEach(() => {
  vi.resetAllMocks();
  scan = null;
  saved = new Set();
  stats.fetched = 0;
  stats.stored = 0;
  stats.failed = 0;
  stats.errors = 0;
  db.getNotificationScan.mockImplementation(async () => (scan ? { ...scan } : null));
  db.saveNotificationScan.mockImplementation(async (botDid, cursor, latestIndexedAt) => {
    scan = { botDid, cursor, latestIndexedAt, updatedAt: new Date() };
    return { ...scan };
  });
  db.clearNotificationScan.mockImplementation(async () => {
    scan = null;
    return { count: 1 };
  });
  db.storeMention.mockImplementation(async ({ postUrl }) => {
    saved.add(postUrl);
    return {} as Awaited<ReturnType<typeof Db.storeMention>>;
  });
});

describe('collectMentions', () => {
  it('collects new arrivals while a historical parent profile consistently fails SDK validation', async () => {
    const parentUri = 'at://did:plc:parent/app.bsky.feed.post/parent';
    const first = notification('first');
    const failed: Notification = {
      ...notification('failed', '2025-12-31T00:00:00.000Z'),
      record: { reply: { parent: { uri: parentUri, cid: first.cid } } },
    };
    const newest = [first];
    const seen: string[] = [];
    let profileRequests = 0;
    let invalidProfile = true;
    const agent = new BskyAgent({
      service: 'https://pds.example',
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.endsWith('listNotifications')) {
          return Response.json(
            url.searchParams.has('cursor')
              ? { notifications: [failed] }
              : { notifications: newest, cursor: 'older' },
          );
        }
        if (url.pathname.endsWith('getRecord')) {
          return Response.json({ uri: parentUri, cid: first.cid, value: { text: 'parent' } });
        }
        if (url.pathname.endsWith('getProfile')) {
          profileRequests++;
          return Response.json({
            did: 'did:plc:parent',
            handle: 'parent.bsky.social',
            displayName: 'x'.repeat(invalidProfile ? 65 : 64),
          });
        }
        if (url.pathname.endsWith('updateSeen')) {
          const body = (await request.json()) as { seenAt: string };
          seen.push(body.seenAt);
          return Response.json({});
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      },
    });
    vi.spyOn(agent, 'assertDid', 'get').mockReturnValue(BOT_DID);

    await collectMentions(agent);

    expect(saved).toStrictEqual(new Set([first.uri]));
    expect(scan).toMatchObject({ cursor: 'older', latestIndexedAt: first.indexedAt });
    expect(profileRequests).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('displayName'));

    const arrival = notification('arrival', '2026-01-02T00:00:00.000Z');
    newest.unshift(arrival);
    await collectMentions(agent);

    expect(saved.has(arrival.uri)).toBe(true);
    expect(saved.has(failed.uri)).toBe(false);
    expect(scan).toMatchObject({ cursor: 'older', latestIndexedAt: first.indexedAt });
    expect(profileRequests).toBe(2);
    expect(seen).toStrictEqual([]);

    // The failure can last for multiple runs without starving later arrivals.
    const laterArrival = notification('later-arrival', '2026-01-03T00:00:00.000Z');
    newest.unshift(laterArrival);
    await collectMentions(agent);
    expect(saved.has(laterArrival.uri)).toBe(true);
    expect(profileRequests).toBe(3);
    expect(seen).toStrictEqual([]);

    invalidProfile = false;
    await collectMentions(agent);
    expect(saved.has(failed.uri)).toBe(true);
    expect(scan).toBeNull();
    // Collecting fresh arrivals must never raise the old scan's acknowledgement.
    expect(seen).toStrictEqual([first.indexedAt]);
  });

  it('resumes a 26-page backlog and acknowledges only after every page is durable', async () => {
    const pages = Array.from({ length: 26 }, (_, index) => [notification(String(index))]);
    const { agent, listNotifications, updateSeen } = makeAgent(pages);

    await collectMentions(agent);

    expect(saved.size).toBe(25);
    expect(scan).toMatchObject({ botDid: BOT_DID, cursor: '25' });
    expect(updateSeen).not.toHaveBeenCalled();
    expect(db.clearNotificationScan).not.toHaveBeenCalled();

    // A new invocation has no local memory of the first one, only the DB row.
    listNotifications.mockClear();
    await collectMentions(agent);

    expect(listNotifications).toHaveBeenNthCalledWith(
      1,
      { cursor: undefined, limit: 100 },
      expect.anything(),
    );
    expect(listNotifications).toHaveBeenNthCalledWith(
      2,
      { cursor: '25', limit: 100 },
      expect.anything(),
    );
    expect(saved.size).toBe(26);
    expect(updateSeen).toHaveBeenCalledExactlyOnceWith(
      { seenAt: pages[0][0].indexedAt },
      expect.anything(),
    );
    expect(scan).toBeNull();
    expect(db.storeMention.mock.invocationCallOrder.at(-1)).toBeLessThan(
      updateSeen.mock.invocationCallOrder[0],
    );
  });

  it('collects unread notifications older than seven days across multiple pages', async () => {
    const older = notification('older', '2020-01-01T00:00:00.000Z');
    const { agent, updateSeen } = makeAgent([[notification('newer')], [older]]);

    await collectMentions(agent);

    expect(saved.has(older.uri)).toBe(true);
    expect(updateSeen).toHaveBeenCalledOnce();
    expect(scan).toBeNull();
  });

  it('collects arrivals during a paused scan without extending its acknowledgement', async () => {
    const pages = Array.from({ length: 26 }, (_, index) => [notification(String(index))]);
    const { agent, updateSeen } = makeAgent(pages);
    await collectMentions(agent);

    const arrival = notification('arrived-later', '2026-01-02T00:00:00.000Z');
    pages[0].unshift(arrival);
    await collectMentions(agent);

    expect(saved.has(arrival.uri)).toBe(true);
    expect(updateSeen).toHaveBeenLastCalledWith(
      { seenAt: '2026-01-01T00:00:00.000Z' },
      expect.anything(),
    );

    await collectMentions(agent);
    expect(saved.has(arrival.uri)).toBe(true);
    expect(updateSeen).toHaveBeenLastCalledWith({ seenAt: arrival.indexedAt }, expect.anything());
  });

  it('keeps the page retryable if one mention fails, including tied timestamps', async () => {
    const first = notification('first');
    const failed = notification('failed');
    const peer = notification('peer');
    const { agent, updateSeen } = makeAgent([[first], [failed, peer], [notification('oldest')]]);
    const store = db.storeMention.getMockImplementation()!;
    db.storeMention.mockImplementation(async (input) => {
      if (input.postUrl === failed.uri) {
        throw new Error('database unavailable');
      }
      return store(input);
    });

    await collectMentions(agent);

    expect(scan?.cursor).toBe('1');
    expect(saved.has(peer.uri)).toBe(true);
    expect(saved.has(failed.uri)).toBe(false);
    expect(updateSeen).not.toHaveBeenCalled();

    db.storeMention.mockImplementation(store);
    await collectMentions(agent);
    expect(saved.size).toBe(4);
    expect(updateSeen).toHaveBeenCalledOnce();
    expect(scan).toBeNull();
  });

  it('continues across multiple new pages despite a failed new mention, without acknowledging it', async () => {
    const historical = notification('historical');
    const failed = notification('failed-new', '2026-01-03T00:00:00.000Z');
    const healthy = notification('healthy-new', '2026-01-02T00:00:00.000Z');
    scan = {
      botDid: BOT_DID,
      cursor: '2',
      latestIndexedAt: historical.indexedAt,
      updatedAt: new Date(),
    };
    const { agent, listNotifications, updateSeen } = makeAgent([[failed], [healthy], [historical]]);
    const store = db.storeMention.getMockImplementation()!;
    db.storeMention.mockImplementation(async (input) => {
      if (input.postUrl === failed.uri) {
        throw new Error('failed to persist new request');
      }
      return store(input);
    });

    await collectMentions(agent);

    expect(saved).toStrictEqual(new Set([healthy.uri, historical.uri]));
    expect(updateSeen).toHaveBeenCalledExactlyOnceWith(
      { seenAt: historical.indexedAt },
      expect.anything(),
    );
    // Only the historical scan was acknowledged. The failed newer request is
    // still unread, and is retried by the ordinary scan on the next run.
    const newestPage = await listNotifications({});
    expect(newestPage.data.notifications[0]).toMatchObject({ uri: failed.uri, isRead: false });
    db.storeMention.mockImplementation(store);
    await collectMentions(agent);
    expect(saved.has(failed.uri)).toBe(true);
  });

  it('resumes the historical scan even if fetching new arrivals fails', async () => {
    const historical = notification('historical');
    scan = {
      botDid: BOT_DID,
      cursor: '1',
      latestIndexedAt: historical.indexedAt,
      updatedAt: new Date(),
    };
    const { agent, listNotifications } = makeAgent([[notification('head')], [historical]]);
    listNotifications.mockRejectedValueOnce(new Error('newest page unavailable'));

    await collectMentions(agent);

    expect(saved.has(historical.uri)).toBe(true);
    expect(stats.errors).toBe(1);
    expect(scan).toBeNull();
  });

  it('stores new arrivals even if fetching the historical page keeps failing', async () => {
    const arrival = notification('arrival', '2026-01-02T00:00:00.000Z');
    scan = {
      botDid: BOT_DID,
      cursor: '1',
      latestIndexedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: new Date(),
    };
    const { agent, listNotifications, updateSeen } = makeAgent([[arrival], []]);
    const list = listNotifications.getMockImplementation()!;
    listNotifications.mockImplementation(async (input) => {
      if (input.cursor === '1') {
        throw new Error('historical page unavailable');
      }
      return list(input);
    });

    await expect(collectMentions(agent)).rejects.toThrow('historical page unavailable');

    expect(saved.has(arrival.uri)).toBe(true);
    expect(scan?.cursor).toBe('1');
    expect(updateSeen).not.toHaveBeenCalled();
  });

  it('preserves completed pages when the next API request fails', async () => {
    const { agent, listNotifications, updateSeen } = makeAgent([
      [notification('first')],
      [notification('second')],
    ]);
    const list = listNotifications.getMockImplementation()!;
    listNotifications.mockImplementationOnce(list).mockRejectedValueOnce(new Error('outage'));

    await expect(collectMentions(agent)).rejects.toThrow('outage');
    expect(scan?.cursor).toBe('1');
    expect(updateSeen).not.toHaveBeenCalled();

    await collectMentions(agent);
    expect(saved.size).toBe(2);
    expect(scan).toBeNull();
  });

  it('replays a page if saving its bookmark fails, without acknowledging it', async () => {
    const { agent, updateSeen } = makeAgent([[notification('first')], [notification('second')]]);
    db.saveNotificationScan.mockRejectedValueOnce(new Error('bookmark write failed'));

    await expect(collectMentions(agent)).rejects.toThrow('bookmark write failed');
    expect(scan).toBeNull();
    expect(saved.size).toBe(1);
    expect(updateSeen).not.toHaveBeenCalled();

    await collectMentions(agent);
    expect(saved.size).toBe(2);
    expect(db.storeMention).toHaveBeenCalledTimes(3);
    expect(updateSeen).toHaveBeenCalledOnce();
  });

  it('retains the bookmark when the read acknowledgement fails', async () => {
    const { agent, updateSeen } = makeAgent([[notification('first')], [notification('second')]]);
    updateSeen.mockRejectedValueOnce(new Error('acknowledgement timed out'));

    await expect(collectMentions(agent)).rejects.toThrow('acknowledgement timed out');
    expect(scan?.cursor).toBe('1');
    expect(db.clearNotificationScan).not.toHaveBeenCalled();

    await collectMentions(agent);
    expect(saved.size).toBe(2);
    expect(scan).toBeNull();
  });

  it('recovers if acknowledgement succeeds but clearing the bookmark fails', async () => {
    const { agent, updateSeen } = makeAgent([[notification('first')], [notification('second')]]);
    db.clearNotificationScan.mockRejectedValueOnce(new Error('delete failed'));

    await expect(collectMentions(agent)).rejects.toThrow('delete failed');
    expect(scan?.cursor).toBe('1');
    expect(updateSeen).toHaveBeenCalledOnce();

    await collectMentions(agent);
    expect(db.storeMention).toHaveBeenCalledTimes(2);
    expect(scan).toBeNull();
  });

  it('rejects a repeated cursor without treating the scan as finished', async () => {
    scan = {
      botDid: BOT_DID,
      cursor: 'stuck',
      latestIndexedAt: notification('first').indexedAt,
      updatedAt: new Date(),
    };
    const { agent, listNotifications, updateSeen } = makeAgent([]);
    listNotifications.mockResolvedValue({
      data: { notifications: [notification('loop')], cursor: 'stuck' },
    });

    await expect(collectMentions(agent)).rejects.toThrow('repeated a notification cursor');
    expect(updateSeen).not.toHaveBeenCalled();
    expect(scan?.cursor).toBe('stuck');
  });

  it('collects valid older requests after a page containing only malformed notifications', async () => {
    const older = notification('older');
    const seen: string[] = [];
    const agent = new BskyAgent({
      service: 'https://pds.example',
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.endsWith('updateSeen')) {
          const body = (await request.json()) as { seenAt: string };
          seen.push(body.seenAt);
          return Response.json({});
        }
        return Response.json(
          url.searchParams.has('cursor')
            ? { notifications: [older] }
            : {
                notifications: [
                  {
                    ...notification('bad'),
                    author: { ...older.author, displayName: 'x'.repeat(65) },
                  },
                ],
                cursor: 'older',
              },
        );
      },
    });
    vi.spyOn(agent, 'assertDid', 'get').mockReturnValue(BOT_DID);

    await collectMentions(agent);

    expect(saved).toStrictEqual(new Set([older.uri]));
    expect(seen).toStrictEqual([older.indexedAt]);
    expect(scan).toBeNull();
  });
});
