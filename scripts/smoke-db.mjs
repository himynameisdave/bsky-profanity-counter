// Checks the compiled bot can reach DATABASE_URL through Prisma's pg adapter, in
// plain Node rather than Vitest: `pnpm build && pnpm smoke:db`. It only reads,
// so it's safe against production. It never calls process.exit, so if a
// connection were left open it would hang here rather than exit.
import { loadDatabaseEnv } from '../dist/config.js';
import * as db from '../dist/services/database.js';
import * as logger from '../dist/services/logger.js';

const started = Date.now();
db.init(loadDatabaseEnv());
try {
  // Raw SQL with nested fragments and a bigint (or null) result
  const totalProfanity = await db.getTotalProfanityCount({ excludeDid: 'did:plc:smoke-check' });
  // A generated model query
  const unprocessedMentions = await db.getUnprocessedMentionsCount();
  // A lookup that finds nothing
  const missing = await db.findAnalysis('did:plc:smoke-check-does-not-exist');
  if (missing !== null) {
    throw new Error('Found an analysis for a DID that should not exist');
  }

  logger.success(
    `✅ Database OK in ${Date.now() - started}ms: ${totalProfanity} profanities, ${unprocessedMentions} unprocessed mentions`,
  );
} finally {
  await db.disconnect();
}
