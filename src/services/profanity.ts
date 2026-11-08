import type { AppBskyFeedDefs } from '@atproto/api';
import {
  RegExpMatcher,
  assignIncrementingIds,
  parseRawPattern,
  resolveConfusablesTransformer,
  toAsciiLowerCaseTransformer,
} from 'obscenity';
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

// Each entry's id is its index in this array
const WORDS = [...BAD_WORDS];

// Characters with a meaning in obscenity's pattern syntax
const escapePattern = (text: string) => text.replaceAll(/[\\[\]?|]/gu, String.raw`\$&`);

/**
 * Turns a list entry into a whole-word obscenity pattern.
 *
 * obscenity's `|` is a regex `\b`, which only works next to a letter or digit.
 * An entry that starts or ends with punctuation (ie: `sh!+`, `s.o.b.`) gets no
 * `|` on that side, otherwise it could never match.
 */
const toPattern = (word: string) => {
  const start = /^\w/u.test(word) ? '|' : '';
  const end = /\w$/u.test(word) ? '|' : '';
  return parseRawPattern(`${start}${escapePattern(word)}${end}`);
};

const matcher = new RegExpMatcher({
  blacklistedTerms: assignIncrementingIds(WORDS.map((word) => toPattern(word))),
  // Only part of obscenity's English preset. Its leetspeak step turns `!` into
  // `i`, so "fuck!" became "fucki" and stopped counting. Its repeated-letter
  // step turns our `butt` into `but` and `xx` into `x`.
  blacklistMatcherTransformers: [resolveConfusablesTransformer(), toAsciiLowerCaseTransformer()],
});

// Analyze text for profanities
export const analyzeProfanity = (text: string): Record<string, number> => {
  const wordCounts: Record<string, number> = {};

  // Where matches overlap, only the longest counts, wherever it starts (ie:
  // "black cock-sucker" counts `cock-sucker`, not `black cock`). Equal lengths
  // go to the earlier one. NFC first, so a decomposed "shït" reads the
  // same as "shït"; obscenity only knows the precomposed characters.
  const matches = matcher
    .getAllMatches(text.normalize('NFC'))
    .toSorted((a, b) => b.matchLength - a.matchLength || a.startIndex - b.startIndex);

  const counted: { startIndex: number; endIndex: number }[] = [];
  for (const { startIndex, endIndex, termId } of matches) {
    const overlaps = counted.some(
      (match) => startIndex <= match.endIndex && match.startIndex <= endIndex,
    );
    if (!overlaps) {
      counted.push({ startIndex, endIndex });
      const word = WORDS[termId];
      wordCounts[word] = (wordCounts[word] ?? 0) + 1;
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
  // Zero posts isn't proof they never swear, so don't call them a good citizen
  if (postCount === 0) {
    return `No original posts found for @${username} in the last year to analyze.`;
  }

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
