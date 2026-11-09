import type { BskyAgent } from '@atproto/api';
import type { Analysis, Mention } from '@prisma/client';
import * as db from './services/database.js';
import * as bsky from './services/bluesky.js';
import * as profanity from './services/profanity.js';
import * as logger from './services/logger.js';
import { handleSelfTargeting } from './services/self-targeting.js';
import { replyToMention } from './services/reply.js';
import { describeError, isTerminalMentionError, TerminalMentionError } from './errors.js';
import { stats } from './run-stats.js';
import { ANALYSIS_CACHE_TTL_MS, FULL_RECOUNT_INTERVAL_MS, MAX_POSTS } from './config.js';
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
 * The details of an earlier analysis we can add someone's new posts to, or
 * null if we need to count their whole year again.
 */
function getRecountBase(existing: Analysis | null, did: string) {
  const details = existing?.profanityDetails as ProfanityDetails | undefined;
  if (
    !existing ||
    !details?.days ||
    !details.checkpoint ||
    !details.fullCountAt ||
    // Only reuse checkpoints belonging to this account
    existing.did !== did ||
    details.did !== did ||
    // We stopped at MAX_POSTS, so we never counted their oldest posts in the window
    existing.totalPosts >= MAX_POSTS ||
    // Time to catch up on any posts they've deleted
    Date.now() - Date.parse(details.fullCountAt) >= FULL_RECOUNT_INTERVAL_MS
  ) {
    return null;
  }
  return details;
}

/**
 * Marks a mention FAILED so it's never retried.
 */
async function giveUpOnMention(mention: Mention) {
  try {
    await db.markMentionAsFailed(
      mention.id,
      mention.lastError ?? 'Retry budget exhausted; previous attempts were interrupted',
    );
    stats.gaveUp++;
    logger.warn(
      `🪦 Giving up on mention ${mention.id} for ${mention.userHandle}: ${mention.attempts - 1} attempts have failed since ${mention.firstAttemptedAt?.toISOString()}`,
    );
  } catch (error) {
    // Not being able to record the failure mustn't stop the rest of the queue
    logger.error(`❌ Could not mark mention ${mention.id} as failed: ${describeError(error)}`);
    stats.failed++;
  }
}

/** Fetch the display handle at reply time; never resolve it to choose identity. */
async function refreshTarget(agent: BskyAgent, mention: Mention): Promise<Mention> {
  if (!mention.did) {
    throw new TerminalMentionError('Missing trustworthy target DID');
  }
  const profile = await bsky.getProfile(agent, mention.did);
  if (profile.did !== mention.did) {
    throw new TerminalMentionError('Profile DID does not match the recorded target');
  }
  await db.refreshTargetHandle(mention.id, mention.did, profile.handle);
  return { ...mention, userHandle: profile.handle };
}

/**
 * Process a single mention by analyzing the user's post history
 * and replying with the profanity analysis results.
 */
async function processMention(agent: BskyAgent, mention: Mention) {
  try {
    // getUnprocessedMention already marked it ANALYZING when it claimed it
    logger.info(`🔍 Processing mention for user: ${mention.userHandle}`);

    if (!mention.did) {
      throw new TerminalMentionError(
        'Missing trustworthy target DID; historical mention quarantined',
      );
    }

    if (mention.did === agent.session?.did) {
      const outcome = await handleSelfTargeting(agent, mention);
      stats[outcome]++;
      return;
    }

    const existing = await db.findAnalysis(mention.did);

    if (existing && Date.now() - existing.lastAnalyzedAt.getTime() < ANALYSIS_CACHE_TTL_MS) {
      const targetMention = await refreshTarget(agent, mention);
      logger.info(`✨ Found freshly cached analysis for ${mention.userHandle}`);

      // Generate the response message using the existing analysis
      const responseMessage = profanity.generateResponseMessage(
        {
          totalCount: existing.profanityCount,
          wordCounts: (existing.profanityDetails as ProfanityDetails)?.wordCounts,
          topThree: (existing.profanityDetails as ProfanityDetails)?.topProfanities
            ?.slice(0, 3)
            .map((p: { word: string; count: number }, i: number) => ({
              word: p.word,
              count: p.count,
              rank: i + 1,
            })),
          postCount: existing.totalPosts,
        },
        targetMention.userHandle,
        existing.totalPosts,
      );

      const outcome = await replyToMention(agent, targetMention, responseMessage, existing.id);
      stats[outcome]++;
      logger.success(`✅ Used cached analysis for mention for ${mention.userHandle}`);
    } else {
      const previous = getRecountBase(existing, mention.did);
      logger.info(
        previous
          ? `🔍 Adding ${mention.userHandle}'s new posts to their last analysis...`
          : `🔍 No cached analysis found for ${mention.userHandle}, fetching posts...`,
      );

      // Just their new posts if we can add them to the last analysis, otherwise their whole year
      const posts = await bsky.getUserPosts(agent, mention.did, previous?.checkpoint);

      // Saved and answered even with no posts, so a quiet account still gets a
      // reply, and a repeat request is served from the cache
      const analysis = profanity.analyzePosts(posts, previous?.days);

      // Refresh after the feed scan, which can take minutes on a full count.
      const targetMention = await refreshTarget(agent, mention);

      // Store the analysis in the database
      const dbAnalysis = await db.createOrUpdateAnalysis({
        did: mention.did,
        userHandle: targetMention.userHandle,
        totalPosts: analysis.postCount,
        profanityCount: analysis.totalCount,
        profanityDetails: {
          wordCounts: analysis.wordCounts,
          topProfanities: analysis.topThree.map((p) => ({ word: p.word, count: p.count })),
          did: mention.did,
          days: analysis.days,
          checkpoint: bsky.getFeedCheckpoint(posts, previous?.checkpoint),
          fullCountAt: previous?.fullCountAt ?? new Date().toISOString(),
        },
      });

      // Generate the response message
      const responseMessage = profanity.generateResponseMessage(
        analysis,
        targetMention.userHandle,
        analysis.postCount,
      );

      const outcome = await replyToMention(agent, targetMention, responseMessage, dbAnalysis.id);
      stats[outcome]++;
      logger.success(
        `✅ Analyzed ${posts.length} new posts (${analysis.postCount} in total) for mention for ${mention.userHandle}`,
      );
    }
  } catch (error) {
    const lastError = describeError(error);
    logger.error(
      `❌ Attempt ${mention.attempts} at mention ${mention.id} for ${mention.userHandle} failed: ${lastError}`,
    );
    try {
      if (isTerminalMentionError(error)) {
        await db.markMentionAsFailed(mention.id, lastError);
        // Counted once: it won't be retried, so it isn't also a failure
        stats.gaveUp++;
        return;
      }
      await db.recordMentionError(mention.id, lastError);
    } catch (recordError) {
      logger.error(
        `❌ Could not record error for mention ${mention.id}: ${describeError(recordError)}`,
      );
    }
    // Retryable failures stay ANALYZING. The rest of this run moves on past it, and
    // resetStuckMentions puts it back in the queue for a later run, which
    // decides whether it still has retries left (see hasExhaustedRetries)
    stats.failed++;
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
    stats.errors++;
  }
}
