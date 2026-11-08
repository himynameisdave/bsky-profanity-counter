import { createAgent, getMentions } from './services/bluesky.js';
import * as logger from './services/logger.js';
import * as db from './services/database.js';
import storeMentions from './mentions.js';
import { checkAndProcessMentions } from './analysis.js';
import { describeError } from './errors.js';
import { STUCK_MENTION_TIMEOUT_MINUTES, loadEnv } from './config.js';
import { stats, hasFailed, writeSummary } from './run-stats.js';

// Throws before anything else happens if a variable is missing, so the run fails loudly
const env = loadEnv();

async function main() {
  logger.info('🤬 Starting profanity.accountant');

  let agent: Awaited<ReturnType<typeof createAgent>>;

  try {
    // Put mentions left ANALYZING by a failed attempt or a dead run back in the queue
    const resetCount = await db.resetStuckMentions(STUCK_MENTION_TIMEOUT_MINUTES);
    if (resetCount > 0) {
      logger.info(`🔄 Reset ${resetCount} mentions that were stuck in ANALYZING state`);
    }

    // Create and authenticate the Bluesky agent
    agent = await createAgent(env.bluesky);
  } catch (error) {
    logger.error(`❌ Error starting the bot:\n\t- ${describeError(error)}`);
    stats.errors++;
    return;
  }

  // Fetching new mentions failing mustn't stop us answering the ones already queued
  try {
    // STEP 1: Get recent mentions and store them in the database
    logger.info('🗣️ Getting unread mentions from Bluesky...');
    const { mentions, latestIndexedAt } = await getMentions(agent);
    stats.fetched = mentions.length;

    if (mentions.length > 0) {
      logger.info(`✅ Found ${mentions.length} unread mentions to process`);
    } else {
      logger.info('🫤 No new mentions to store, going to process some analysis');
    }

    //  First thing we do is store the mentions in the database, then move the
    //  read cursor up to the batch we just fetched
    await storeMentions(agent, mentions, latestIndexedAt);
  } catch (error) {
    logger.error(
      `❌ Error getting new mentions, still working through the queue:\n\t- ${describeError(error)}`,
    );
    stats.errors++;
  }

  // Now we check for unanalyzed mentions and process them
  await checkAndProcessMentions(agent);
}

try {
  await main();
} catch (error) {
  logger.error(`❌ The run crashed:\n\t- ${describeError(error)}`);
  stats.errors++;
} finally {
  await db.disconnect();
  writeSummary();
  // Any failure turns the job red, so a broken bot doesn't hide behind green checkmarks
  process.exitCode = hasFailed() ? 1 : 0;
  // Exit as soon as the run is done, not whenever the event loop drains. A feed
  // request we gave up on can stay open even after it's aborted (see withTimeout
  // in services/bluesky.ts), and it would keep this process alive, its work
  // done, until the workflow timeout killed it.
  // oxlint-disable-next-line unicorn/no-process-exit -- this is the entrypoint, and stray sockets must not keep it running
  process.exit();
}
