// This is a CLI entry point, so a non-zero exit code is how it reports failure
// oxlint-disable unicorn/no-process-exit
import * as bsky from './services/bluesky.js';
import * as db from './services/database.js';
import * as profileUpdater from './services/profile-updater.js';
import * as logger from './services/logger.js';
import { describeError } from './errors.js';
import { loadEnv } from './config.js';

// Throws before anything else happens if a variable is missing, so the run fails loudly
const env = loadEnv();

/**
 * Main function to update the bot's profile description with total profanity count
 */
async function main() {
  let failed = false;

  try {
    logger.info('🚀 Starting profile update process...');

    db.init(env.database);

    // Create and authenticate the Bluesky agent
    const agent = await bsky.createAgent(env.bluesky);

    // Update the profile description
    // It's one database query and a read and write of our profile, so this is generous
    await bsky.withTimeout(bsky.REQUEST_TIMEOUT_MS * 2, () =>
      profileUpdater.updateProfileDescription(agent),
    );

    logger.success('✅ Profile update completed successfully');
  } catch (error) {
    logger.error(`❌ Profile update failed: ${describeError(error)}`);
    failed = true;
  } finally {
    // Clean up database connection, whether or not the update worked
    await db.disconnect();
  }

  // Only once the pool is closed. Exiting straight away still beats waiting on a
  // request withTimeout gave up on.
  if (failed) {
    process.exit(1);
  }
}

// Run the main function
try {
  await main();
} catch (error) {
  logger.error(`❌ Unexpected error: ${describeError(error)}`);
  process.exit(1);
}
