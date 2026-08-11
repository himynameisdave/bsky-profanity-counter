import type { AppBskyFeedDefs } from '@atproto/api';
import BAD_WORDS from '../data/badWords.js';

// Type for profanity analysis results
export type ProfanityAnalysis = {
  totalCount: number;
  wordCounts: Record<string, number>;
  topThree: {
    word: string;
    count: number;
    rank: number; // 1, 2, or 3
  }[];
  postCount: number; // Number of posts analyzed
};

// Analyze text for profanities
export const analyzeProfanity = (text: string): Record<string, number> => {
  const wordCounts: Record<string, number> = {};

  // Convert text to lowercase for case-insensitive matching
  const lowerText = text.toLowerCase();

  // Check for each profanity in the text
  for (const word of BAD_WORDS) {
    // Create a regex that matches the word as a whole word
    const regex = new RegExp(`\\b${word}\\b`, 'gu');
    const matches = lowerText.match(regex);

    if (matches) {
      wordCounts[word] = matches.length;
    }
  }

  return wordCounts;
};

// Analyze a collection of posts for profanities
export const analyzePosts = (posts: AppBskyFeedDefs.PostView[]): ProfanityAnalysis => {
  const totalWordCounts: Record<string, number> = {};

  // Process each post
  for (const post of posts) {
    // The record property is loosely typed, so narrow it before reading `text`
    const record = post.record as { text?: unknown } | undefined;
    const text = typeof record?.text === 'string' ? record.text : '';

    if (text) {
      const postCounts = analyzeProfanity(text);

      // Add counts to the total
      for (const [word, count] of Object.entries(postCounts)) {
        totalWordCounts[word] = (totalWordCounts[word] || 0) + count;
      }
    }
  }

  // Calculate total count
  const totalCount = Object.values(totalWordCounts).reduce((sum, count) => sum + count, 0);

  // Sort all word counts in descending order, take only the top 3
  const sortedEntries = Object.entries(totalWordCounts)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 3);

  // Create the top three array with ranks
  const topThree = sortedEntries.map(([word, count], index) => ({
    word,
    count,
    rank: index + 1, // Rank 1, 2, or 3
  }));

  return {
    totalCount,
    wordCounts: totalWordCounts,
    topThree,
    postCount: posts.length, // Add the number of posts that were analyzed
  };
};

const MEDALS: Record<number, string> = {
  1: '🥇',
  2: '🥈',
  3: '🥉',
};

// Generate a response message based on the analysis
export const generateResponseMessage = (
  analysis: ProfanityAnalysis,
  username: string,
  postCount: number,
): string => {
  if (analysis.totalCount === 0) {
    return `@${username} has been a good citizen!\nNo profanity found in their last ${postCount.toLocaleString('en-CA')} posts.`;
  }

  let message = `@${username} has swears! They've used ${analysis.totalCount.toLocaleString('en-CA')} profanities in their last ${postCount.toLocaleString('en-CA')} posts.`;

  // Add top three profanities with medal emojis if available
  if (analysis.topThree.length > 0) {
    message += '\n\n';

    for (const item of analysis.topThree) {
      const medal = MEDALS[item.rank] ?? '';
      message += `${medal} "${item.word}" (${item.count.toLocaleString('en-CA')} times)\n`;
    }
  }

  return message;
};
