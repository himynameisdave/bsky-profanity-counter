import { createAgent } from './services/bluesky.js';
import * as logger from './services/logger.js';
import * as db from './services/database.js';
import { collectMentions } from './notifications.js';
import { checkAndProcessMentions } from './analysis.js';
import { describeError } from './errors.js';
import { STUCK_MENTION_TIMEOUT_MINUTES, loadEnv } from './config.js';
import { stats, hasFailed, writeSummary } from './run-stats.js';

async function main() {
  logger.info('🤬 Starting profanity.accountant');

  let agent: Awaited<ReturnType<typeof createAgent>>;

  try {
    // Throws before anything else happens if a variable is missing, so the run fails loudly
    const env = loadEnv();

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
    await collectMentions(agent);
  } catch (error) {
    logger.error(
      `❌ Error getting new mentions, still working through the queue:\n\t- ${describeError(error)}`,
    );
    stats.errors++;
  }

  // Now we check for unanalyzed mentions and process them
  await checkAndProcessMentions(agent);
}

// Each step is caught on its own, so a failure in one still lets the summary
// get written and the process exit with the right code
try {
  await main();
} catch (error) {
  logger.error(`❌ The run crashed:\n\t- ${describeError(error)}`);
  stats.errors++;
}

try {
  await db.disconnect();
} catch (error) {
  logger.error(`❌ Error disconnecting from the database:\n\t- ${describeError(error)}`);
  stats.errors++;
}

writeSummary();
// Any failure turns the job red, so a broken bot doesn't hide behind green checkmarks
process.exitCode = hasFailed() ? 1 : 0;
// Exit as soon as the run is done, not whenever the event loop drains. A feed
// request we gave up on can stay open even after it's aborted (see withTimeout
// in services/bluesky.ts), and it would keep this process alive, its work
// done, until the workflow timeout killed it.
// oxlint-disable-next-line unicorn/no-process-exit -- this is the entrypoint, and stray sockets must not keep it running
process.exit();
