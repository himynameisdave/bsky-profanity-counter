import { loadDatabaseEnv } from '../src/config.js';
import * as db from '../src/services/database.js';
import * as logger from '../src/services/logger.js';

// Uses the same database configuration as the bot; no Bluesky login or writes.
db.init(loadDatabaseEnv());
try {
  const apply = process.argv.includes('--apply');
  if (!apply && !process.argv.includes('--dry-run')) {
    throw new Error('Use --dry-run to review the plan, or --apply to commit it');
  }
  const summary = await db.backfillIdentity(apply);
  logger.info(JSON.stringify({ apply, ...summary }, null, 2));
} finally {
  await db.disconnect();
}
