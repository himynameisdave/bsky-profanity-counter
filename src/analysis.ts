import type { BskyAgent } from '@atproto/api';
import type { Mention } from '@prisma/client';
import * as db from './services/database.js';
import * as bsky from './services/bluesky.js';
import * as profanity from './services/profanity.js';
import * as logger from './services/logger.js';
import { handleSelfTargeting } from './services/self-targeting.js';
import { replyToMention } from './services/reply.js';
import { describeError } from './errors.js';
import type { ProfanityDetails } from './services/database.js';

const HOUR_MS = 60 * 60 * 1000;

// We give up on a mention only once it has failed at least this many times...
export const MAX_FAILED_ATTEMPTS = 5;
// ...and its first attempt was at least this long ago. Requiring both means a
// Bluesky outage gets the whole window however often runs happen, and a mention
// that always fails still gets several tries however rarely they happen.
export const MENTION_RETRY_WINDOW_MS = 24 * HOUR_MS;

/**
 * Whether a mention we've just claimed has used up its retry budget.
 *
 * Its `attempts` include this claim. Every earlier attempt either failed or was
 * cut short by a killed run, otherwise the mention would be DONE. The window
 * runs from the first attempt, so time spent waiting in the queue behind other
 * mentions doesn't count against it.
 */
function hasExhaustedRetries(mention: Mention): boolean {
  const failedAttempts = mention.attempts - 1;

  if (failedAttempts < MAX_FAILED_ATTEMPTS || !mention.firstAttemptedAt) {
    return false;
  }

  return Date.now() - mention.firstAttemptedAt.getTime() >= MENTION_RETRY_WINDOW_MS;
}

/**
 * Marks a mention FAILED so it's never retried.
 */
async function giveUpOnMention(mention: Mention) {
  try {
    await db.markMentionAsFailed(mention.id);
    logger.warn(
      `🪦 Giving up on mention ${mention.id} for ${mention.userHandle}: ${mention.attempts - 1} attempts have failed since ${mention.firstAttemptedAt?.toISOString()}`,
    );
  } catch (error) {
    // Not being able to record the failure mustn't stop the rest of the queue
    logger.error(`❌ Could not mark mention ${mention.id} as failed: ${describeError(error)}`);
  }
}

/**
 * Process a single mention by analyzing the user's post history
 * and replying with the profanity analysis results.
 */
async function processMention(agent: BskyAgent, mention: Mention) {
  try {
    // The mention is already marked as ANALYZING by our transaction
    // so we don't need to call markMentionAsAnalyzing here anymore
    logger.info(`🔍 Processing mention for user: ${mention.userHandle}`);

    // Check if user is trying to target the bot itself
    if (mention.userHandle === 'profanity.accountant') {
      await handleSelfTargeting(agent, mention);
      return; // Exit early, don't do profanity analysis
    }

    // Check if we have a fresh analysis (less than 24 hours old)
    const freshAnalysis = await db.findFreshAnalysis(mention.userHandle);

    if (freshAnalysis) {
      logger.info(`✨ Found freshly cached analysis for ${mention.userHandle}`);

      // Generate the response message using the existing analysis
      const responseMessage = profanity.generateResponseMessage(
        {
          totalCount: freshAnalysis.profanityCount,
          wordCounts: (freshAnalysis.profanityDetails as ProfanityDetails)?.wordCounts,
          topThree: (freshAnalysis.profanityDetails as ProfanityDetails)?.topProfanities
            ?.slice(0, 3)
            .map((p: { word: string; count: number }, i: number) => ({
              word: p.word,
              count: p.count,
              rank: i + 1,
            })),
          postCount: freshAnalysis.totalPosts,
        },
        mention.userHandle,
        freshAnalysis.totalPosts,
      );

      await replyToMention(agent, mention, responseMessage, freshAnalysis.id);
      logger.success(`✅ Used cached analysis for mention for ${mention.userHandle}`);
    } else {
      // No fresh analysis, need to analyze post history
      logger.info(`🔍 No cached analysis found for ${mention.userHandle}, fetching posts...`);

      // Get the user's profile to get their DID
      const profile = await bsky.getProfile(agent, mention.userHandle);

      // Get the user's posts
      const posts = await bsky.getUserPosts(agent, profile.did);

      // Saved and answered even with no posts, so a quiet account still gets a
      // reply, and a repeat request is served from the cache
      const analysis = profanity.analyzePosts(posts);

      // Store the analysis in the database
      const dbAnalysis = await db.createOrUpdateAnalysis({
        userHandle: mention.userHandle,
        totalPosts: posts.length,
        profanityCount: analysis.totalCount,
        profanityDetails: {
          wordCounts: analysis.wordCounts,
          topProfanities: analysis.topThree.map((p) => ({ word: p.word, count: p.count })),
        },
      });

      // Generate the response message
      const responseMessage = profanity.generateResponseMessage(
        analysis,
        mention.userHandle,
        posts.length,
      );

      await replyToMention(agent, mention, responseMessage, dbAnalysis.id);
      logger.success(`✅ Analyzed ${posts.length} posts for mention for ${mention.userHandle}`);
    }
  } catch (error) {
    // Leave it ANALYZING. The rest of this run moves on past it, and
    // resetStuckMentions puts it back in the queue for a later run, which
    // decides whether it still has retries left (see hasExhaustedRetries)
    logger.error(
      `❌ Attempt ${mention.attempts} at mention ${mention.id} for ${mention.userHandle} failed, leaving it for a later run: ${describeError(error)}`,
    );
  }
}

/**
 * Recursively process unanalyzed mentions until there are none left.
 * This is the main function which will get run
 */
export async function processUnanalyzedMentions(agent: BskyAgent): Promise<void> {
  // Get unprocessed mentions
  const unprocessedMentionsCount = await db.getUnprocessedMentionsCount();

  // Base case: no more unprocessed mentions
  if (unprocessedMentionsCount === 0) {
    logger.info('✅ No more unprocessed mentions to analyze');
    return;
  }

  logger.info(`📈 Found ${unprocessedMentionsCount} unprocessed mentions to analyze`);

  // Process the first mention
  // getUnprocessedMention also marks it as ANALYZING and counts the attempt, atomically
  const mention = await db.getUnprocessedMention();
  if (mention && hasExhaustedRetries(mention)) {
    // Checked when it's claimed rather than when it fails, so attempts that
    // were cut short by a killed run, and never reached a catch, count too
    await giveUpOnMention(mention);
  } else if (mention) {
    await processMention(agent, mention);
  } else {
    logger.warn(
      '⚠️ No unprocessed mention found to process. Maybe another job already snatched the last one?',
    );
  }

  // Recursively process the remaining mentions
  await processUnanalyzedMentions(agent);
}

/**
 * Main function to check for unanalyzed mentions and process them
 */
export async function checkAndProcessMentions(agent: BskyAgent): Promise<void> {
  logger.info('🔍 Checking for unanalyzed mentions...');

  try {
    await processUnanalyzedMentions(agent);
    logger.success('✅ Completed processing of unanalyzed mentions');
  } catch (error) {
    logger.error(`❌ Error checking and processing mentions: ${describeError(error)}`);
  }
}
