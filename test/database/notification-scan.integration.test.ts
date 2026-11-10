import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { BskyAgent } from '@atproto/api';
import * as db from '../../src/services/database.js';
import { collectMentions } from '../../src/notifications.js';

vi.mock(import('../../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));

// Only run against an explicitly selected throwaway DB. CI supplies one.
describe.skipIf(!process.env.DATABASE_URL || process.env.NOTIFICATION_SCAN_DATABASE_TESTS !== '1')(
  'notification collection in PostgreSQL',
  () => {
    const fixtures = new PrismaClient();
    const id = randomUUID().replaceAll('-', '');
    const botDid = `did:plc:bot${id}`;
    const otherBotDid = `did:plc:other${id}`;
    const targetDid = `did:plc:target${id}`;
    const indexedAt = '2026-01-01T00:00:00.123456Z';
    const updateSeen = vi.fn<(args: { seenAt: string }) => Promise<void>>();
    const listNotifications = vi.fn<
      (args: {
        cursor?: string;
      }) => Promise<{ data: { notifications: unknown[]; cursor?: string } }>
    >(async ({ cursor }) => {
      const page = cursor ? Number(cursor) : 0;
      return {
        data: {
          notifications: [
            {
              uri: `at://${targetDid}/app.bsky.feed.post/${page}`,
              cid: 'cid',
              author: { did: targetDid, handle: 'fixture.bsky.social' },
              reason: 'mention',
              record: {},
              isRead: false,
              indexedAt,
            },
          ],
          cursor: page < 25 ? String(page + 1) : undefined,
        },
      };
    });
    const agent = {
      assertDid: botDid,
      listNotifications,
      app: { bsky: { notification: { updateSeen } } },
    } as unknown as BskyAgent;

    afterAll(async () => {
      await fixtures.mention.deleteMany({ where: { did: targetDid } });
      await fixtures.notificationScan.deleteMany({
        where: { botDid: { in: [botDid, otherBotDid] } },
      });
      await fixtures.$disconnect();
      await db.disconnect();
    });

    it('resumes after reconnecting, preserves the exact watermark, and isolates bots', async () => {
      await db.saveNotificationScan(otherBotDid, 'opaque-cursor', null);
      await collectMentions(agent);

      const paused = await fixtures.notificationScan.findUniqueOrThrow({ where: { botDid } });
      expect(paused).toMatchObject({ cursor: '25', latestIndexedAt: indexedAt });
      await expect(fixtures.mention.count({ where: { did: targetDid } })).resolves.toBe(25);
      expect(updateSeen).not.toHaveBeenCalled();

      // Lose the collector's connection, then resume from the durable bookmark.
      await db.disconnect();
      listNotifications.mockClear();
      await collectMentions(agent);

      expect(listNotifications).toHaveBeenCalledExactlyOnceWith(
        { cursor: '25', limit: 100 },
        expect.anything(),
      );
      await expect(fixtures.mention.count({ where: { did: targetDid } })).resolves.toBe(26);
      expect(updateSeen).toHaveBeenCalledExactlyOnceWith({ seenAt: indexedAt }, expect.anything());
      await expect(db.getNotificationScan(botDid)).resolves.toBeNull();
      await expect(db.getNotificationScan(otherBotDid)).resolves.toMatchObject({
        cursor: 'opaque-cursor',
        latestIndexedAt: null,
      });

      // Replaying a page cannot reset queued requests or duplicate their rows.
      await db.saveNotificationScan(botDid, '25', indexedAt);
      await collectMentions(agent);
      await expect(fixtures.mention.count({ where: { did: targetDid } })).resolves.toBe(26);
    });
  },
);
