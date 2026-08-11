import type { BskyAgent } from '@atproto/api';
import type { Mention } from '@prisma/client';
import * as db from './services/database.js';
import * as bsky from './services/bluesky.js';
import * as profanity from './services/profanity.js';
import * as logger from './services/logger.js';
import { handleSelfTargeting } from './services/self-targeting.js';
import type { ProfanityDetails } from './services/database.js';

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

      // Get the mention post to reply to
      const mentionPost = await bsky.getPost(agent, mention.postUrl);

      if (mentionPost) {
        // Reply to the mention with the analysis results
        const posted = await bsky.replyToPost(agent, mentionPost, responseMessage);
        const reply = posted as { uri?: string; cid?: string } | undefined;

        // Extract the reply post ID and URL
        const replyPostId = reply?.uri?.split('/').pop() || '';
        const replyUrl = reply?.uri || '';

        // Mark the mention as done
        await db.markMentionAsDone({
          mentionId: mention.id,
          replyPostId,
          replyUrl,
          analysisId: freshAnalysis.id,
        });

        logger.success(`✅ Used cached analysis to reply to mention for ${mention.userHandle}`);
      } else {
        // The post no longer exists, so we can't reply to it
        logger.warn(
          `⚠️ Could not find mention post to reply to (likely deleted): ${mention.postUrl}`,
        );

        // Still mark the mention as done, but without a reply
        await db.markMentionAsDone({
          mentionId: mention.id,
          replyPostId: '',
          replyUrl: '',
          analysisId: freshAnalysis.id,
        });

        logger.info(`✅ Marked mention as processed (post unavailable) for ${mention.userHandle}`);
      }
    } else {
      // No fresh analysis, need to analyze post history
      logger.info(`🔍 No cached analysis found for ${mention.userHandle}, fetching posts...`);

      // Get the user's profile to get their DID
      const profile = await bsky.getProfile(agent, mention.userHandle);

      // Get the user's posts
      const posts = await bsky.getUserPosts(agent, profile.did);

      if (posts.length > 0) {
        // Analyze the posts for profanity
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

        // Get the mention post to reply to
        const mentionPost = await bsky.getPost(agent, mention.postUrl);

        if (mentionPost) {
          // Reply to the mention with the analysis results
          const posted = await bsky.replyToPost(agent, mentionPost, responseMessage);
          const reply = posted as { uri?: string; cid?: string } | undefined;

          // Extract the reply post ID and URL
          const replyPostId = reply?.uri?.split('/').pop() || '';
          const replyUrl = reply?.uri || '';

          // Mark the mention as done
          await db.markMentionAsDone({
            mentionId: mention.id,
            replyPostId,
            replyUrl,
            analysisId: dbAnalysis.id,
          });

          logger.success(`✅ Analyzed and replied to mention for ${mention.userHandle}`);
        } else {
          // The post no longer exists, so we can't reply to it
          logger.warn(
            `⚠️ Could not find mention post to reply to (likely deleted): ${mention.postUrl}`,
          );

          // Still mark the mention as done, but without a reply
          await db.markMentionAsDone({
            mentionId: mention.id,
            replyPostId: '',
            replyUrl: '',
            analysisId: dbAnalysis.id,
          });

          logger.info(
            `✅ Marked mention as processed (post unavailable) for ${mention.userHandle}`,
          );
        }
      } else {
        logger.warn(`⚠️ No posts found for ${mention.userHandle}`);

        // Mark the mention as done, but with no analysis or reply
        await db.markMentionAsDone({
          mentionId: mention.id,
          replyPostId: '',
          replyUrl: '',
        });

        logger.info(`✅ Marked mention as processed (no posts found) for ${mention.userHandle}`);
      }
    }
  } catch (error) {
    logger.error(`❌ Error processing mention: ${error}`);
    // Leave the mention in ANALYZING state for retry later
    // TODO mark it as UNPROCESSED.
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
  // getUnprocessedMention now also marks it as ANALYZING atomically
  const mention = await db.getUnprocessedMention();
  if (mention) {
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
    logger.error(`❌ Error checking and processing mentions: ${error}`);
  }
}
