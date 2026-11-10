import type { BskyAgent } from '@atproto/api';
import * as bsky from './services/bluesky.js';
import * as db from './services/database.js';
import * as logger from './services/logger.js';
import storeMentions from './mentions.js';
import { MAX_NOTIFICATION_PAGES } from './config.js';
import { stats } from './run-stats.js';

/**
 * Walk unread notifications newest-first, saving each page before its bookmark.
 * The bookmark survives a killed run. The global read marker only moves once
 * we've reached the bottom, because it also marks every older notification read.
 * Scheduled runs are serialized by the workflow's concurrency group.
 */
export async function collectMentions(agent: BskyAgent): Promise<void> {
  const botDid = agent.assertDid;
  const scan = await db.getNotificationScan(botDid);
  let cursor = scan?.cursor;
  let latestIndexedAt = scan?.latestIndexedAt ?? null;
  const visited = new Set<string>();

  logger.info(scan ? '📖 Resuming unread notifications...' : '🗣️ Getting unread notifications...');

  for (let page = 0; page < MAX_NOTIFICATION_PAGES; page++) {
    if (cursor) {
      visited.add(cursor);
    }
    // Each page depends on the previous page being saved
    // oxlint-disable-next-line no-await-in-loop
    const batch = await bsky.getMentions(agent, cursor);
    stats.fetched += batch.mentions.length;

    if (batch.nextCursor && visited.has(batch.nextCursor)) {
      throw new Error('Bluesky repeated a notification cursor; leaving the scan unfinished');
    }

    // A failed save keeps the previous bookmark, so this page gets retried.
    // oxlint-disable-next-line no-await-in-loop
    if (!(await storeMentions(agent, batch.mentions))) {
      logger.warn('⚠️ Leaving this notification page unfinished so failed mentions are retried');
      return;
    }

    if (
      batch.latestIndexedAt &&
      (!latestIndexedAt || Date.parse(batch.latestIndexedAt) > Date.parse(latestIndexedAt))
    ) {
      ({ latestIndexedAt } = batch);
    }

    if (batch.nextCursor === null) {
      // Keep the bookmark if acknowledgement fails. If the process dies after
      // acknowledgement, replaying the last page and acknowledging again is safe.
      if (latestIndexedAt) {
        // oxlint-disable-next-line no-await-in-loop
        await bsky.markNotificationsAsRead(agent, latestIndexedAt);
      }
      // oxlint-disable-next-line no-await-in-loop
      await db.clearNotificationScan(botDid);
      logger.success('📑 Finished collecting unread notifications');
      return;
    }

    // Never save this cursor before all of the page's mentions are durable.
    // oxlint-disable-next-line no-await-in-loop
    await db.saveNotificationScan(botDid, batch.nextCursor, latestIndexedAt);
    cursor = batch.nextCursor;
  }

  logger.info(`📖 Paused after ${MAX_NOTIFICATION_PAGES} pages; continuing next run`);
}
