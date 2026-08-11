// This is a CLI entry point, so a non-zero exit code is how it reports failure
// oxlint-disable unicorn/no-process-exit
import dotenv from 'dotenv';
import * as bsky from './services/bluesky.js';
import * as profileUpdater from './services/profile-updater.js';
import * as logger from './services/logger.js';

// Load environment variables
dotenv.config();

/**
 * Main function to update the bot's profile description with total profanity count
 */
async function main() {
  try {
    logger.info('🚀 Starting profile update process...');

    // Create and authenticate the Bluesky agent
    const agent = await bsky.createAgent();

    // Update the profile description
    await profileUpdater.updateProfileDescription(agent);

    logger.success('✅ Profile update completed successfully');
  } catch (error) {
    logger.error(`❌ Profile update failed: ${error}`);
    process.exit(1);
  } finally {
    // Clean up database connection
    await profileUpdater.disconnect();
  }
}

// Run the main function
try {
  await main();
} catch (error) {
  logger.error(`❌ Unexpected error: ${error}`);
  process.exit(1);
}
