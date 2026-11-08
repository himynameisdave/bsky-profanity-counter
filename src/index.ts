import dotenv from 'dotenv';
import { createAgent, getMentions } from './services/bluesky.js';
import * as logger from './services/logger.js';
import * as db from './services/database.js';
import storeMentions from './mentions.js';
import { checkAndProcessMentions } from './analysis.js';
import { describeError } from './errors.js';

// Load environment variables
dotenv.config();

// Environment variables
const BLUESKY_IDENTIFIER = process.env.BLUESKY_IDENTIFIER || '';
const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD || '';

// Hardcoded bot DID for self-mention detection (no need to fetch it each time)
const BOT_DID = 'did:plc:zq2louqgczh23wrrduwwbvbn';

if (!BLUESKY_IDENTIFIER || !BLUESKY_PASSWORD) {
  logger.error('🕵️ Missing Bluesky credentials in environment variables');
  throw new Error('🕵️ Missing Bluesky credentials in environment variables');
}

async function main() {
  logger.info('🤬 Starting profanity.accountant');

  try {
    // Reset any mentions that have been stuck in ANALYZING state for more than 20 minutes
    const resetCount = await db.resetStuckMentions(20);
    if (resetCount > 0) {
      logger.info(`🔄 Reset ${resetCount} mentions that were stuck in ANALYZING state`);
    }

    // Create and authenticate the Bluesky agent
    const agent = await createAgent();

    logger.info(`🤖 Bot authenticated as: ${BLUESKY_IDENTIFIER} (${BOT_DID})`);

    // STEP 1: Get recent mentions and store them in the database
    logger.info('🗣️ Getting unread mentions from Bluesky...');
    const { mentions, latestIndexedAt } = await getMentions(agent);

    if (mentions.length > 0) {
      logger.info(`✅ Found ${mentions.length} unread mentions to process`);
    } else {
      logger.info('🫤 No new mentions to store, going to process some analysis');
    }

    //  First thing we do is store the mentions in the database, then move the
    //  read cursor up to the batch we just fetched
    await storeMentions(agent, mentions, latestIndexedAt);

    // Now we check for unanalyzed mentions and process them
    await checkAndProcessMentions(agent);
  } catch (error) {
    logger.error(`❌ Error running the bot:\n\t- ${describeError(error)}`);
  }
}

try {
  await main();
} finally {
  await db.disconnect();
  // Exit as soon as the run is done, not whenever the event loop drains. A feed
  // request we gave up on can stay open even after it's aborted (see withTimeout
  // in services/bluesky.ts), and it would keep this process alive, its work
  // done, until the workflow timeout killed it.
  // oxlint-disable-next-line unicorn/no-process-exit -- this is the entrypoint, and stray sockets must not keep it running
  process.exit();
}
