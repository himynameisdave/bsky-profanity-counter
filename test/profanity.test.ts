import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  analyzePosts,
  analyzeProfanity,
  generateResponseMessage,
  renderWord,
  type ProfanityAnalysis,
} from '../src/services/profanity.js';
import { parsePronouns, THEY } from '../src/services/pronouns.js';
import type { AppBskyFeedDefs } from '@atproto/api';
import BAD_WORDS from '../src/data/badWords.js';
import UNQUOTABLE_WORDS from '../src/data/unquotableWords.js';

// Mock data
const createMockPost = (text: string): AppBskyFeedDefs.PostView =>
  ({
    uri: 'at://fake-uri',
    cid: 'fake-cid',
    record: {
      text,
      $type: 'app.bsky.feed.post',
      createdAt: new Date().toISOString(),
    },
    author: {
      did: 'did:fake',
      handle: 'test.bsky.social',
    },
    indexedAt: new Date().toISOString(),
    viewer: {},
  }) as AppBskyFeedDefs.PostView;

// A post written at noon UTC on `day`
const postOn = (day: string, text: string) =>
  ({
    uri: `at://fake/${day}`,
    cid: 'fake-cid',
    author: { did: 'did:fake', handle: 'test.bsky.social' },
    indexedAt: `${day}T12:00:00.000Z`,
    record: { text, createdAt: `${day}T12:00:00.000Z` },
  }) as AppBskyFeedDefs.PostView;

// Counted the way Bluesky counts a post's length
const graphemes = (text: string) => [...new Intl.Segmenter().segment(text)].length;

describe('Profanity Service', () => {
  describe(analyzePosts, () => {
    it('should track the top 3 profanities correctly', () => {
      // Create posts with different profanities
      const posts = [
        createMockPost('This is a damn good post'),
        createMockPost('Hell yeah it is'),
        createMockPost('This damn thing is damn good'),
        createMockPost('Hell no, this shit is not good'),
        createMockPost('What the hell is going on?'),
        createMockPost('Oh shit, I forgot'),
        createMockPost('I hate this crap'),
      ];

      const result = analyzePosts(posts);

      // Expected: "damn" (3), "hell" (3), "shit" (2)
      expect(result.totalCount).toBeGreaterThan(0);
      expect(result.topThree).toHaveLength(3);

      // Verify ranks are assigned correctly
      expect(result.topThree.map((item) => item.rank)).toStrictEqual([1, 2, 3]);

      // "damn" and "hell" both appear 3 times, so they take the top two in either order
      const topTwoWords = new Set([result.topThree[0].word, result.topThree[1].word]);
      expect(topTwoWords.has('damn')).toBe(true);
      expect(topTwoWords.has('hell')).toBe(true);

      // "shit" appears twice, putting it third
      expect(result.topThree[2].word).toBe('shit');
    });

    describe('adding to earlier counts', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it('adds new posts to the earlier days, without changing them', () => {
        vi.useFakeTimers({ now: new Date('2026-07-15T00:00:00Z') });
        const earlier = { '2026-07-01': { posts: 2, wordCounts: { shit: 1 } } };

        const result = analyzePosts(
          [postOn('2026-07-01', 'oh shit'), postOn('2026-07-14', 'damn')],
          earlier,
        );

        expect(result.postCount).toBe(4);
        expect(result.wordCounts).toStrictEqual({ shit: 2, damn: 1 });
        expect(result.days).toStrictEqual({
          '2026-07-01': { posts: 3, wordCounts: { shit: 2 } },
          '2026-07-14': { posts: 1, wordCounts: { damn: 1 } },
        });
        expect(earlier).toStrictEqual({ '2026-07-01': { posts: 2, wordCounts: { shit: 1 } } });
      });

      it('drops days as they fall out of the one year window', () => {
        vi.useFakeTimers({ now: new Date('2026-07-15T08:00:00Z') });
        const earlier = analyzePosts([
          postOn('2025-07-15', 'shit'),
          postOn('2025-08-01', 'damn'),
          postOn('2026-01-01', 'hell'),
        ]).days;

        expect(analyzePosts([], earlier).wordCounts).toStrictEqual({
          shit: 1,
          damn: 1,
          hell: 1,
        });

        vi.setSystemTime(new Date('2026-07-16T08:00:00Z'));
        const result = analyzePosts([], earlier);
        expect(result.postCount).toBe(2);
        expect(result.wordCounts).toStrictEqual({ damn: 1, hell: 1 });

        vi.setSystemTime(new Date('2027-01-01T08:00:00Z'));
        expect(analyzePosts([], earlier).wordCounts).toStrictEqual({ hell: 1 });
      });
    });

    it('should handle posts with no profanity', () => {
      const posts = [
        createMockPost('This is a good post'),
        createMockPost('I really like this content'),
      ];

      const result = analyzePosts(posts);
      expect(result.totalCount).toBe(0);
      expect(result.topThree).toHaveLength(0);
    });
  });

  describe(analyzeProfanity, () => {
    // List entries used to be dropped into a regex unescaped (see #8)
    it.each([
      ['s.o.b.', 'that s.o.b. again', 'sxoxbx'],
      ['bi+ch', 'what a bi+ch', 'biiich'],
      ['sh!+', 'sh!+ happens', 'shhh'],
    ])('matches %s literally', (word, matching, notMatching) => {
      expect(analyzeProfanity(matching)).toStrictEqual({ [word]: 1 });
      expect(analyzeProfanity(notMatching)).toStrictEqual({});
    });

    it("doesn't count part of a word", () => {
      // The old `masterbat*` entry matched this
      expect(analyzeProfanity('masterba')).toStrictEqual({});
      expect(analyzeProfanity('hello shell, class assessment')).toStrictEqual({});
    });

    it('counts a word at the start of a post', () => {
      // The list used to have " shits", with a leading space
      expect(analyzeProfanity('shits happen')).toStrictEqual({ shits: 1 });
    });

    it('counts a word followed by punctuation', () => {
      expect(analyzeProfanity('what the fuck! oh shit!! damn, ok. hell?')).toStrictEqual({
        fuck: 1,
        shit: 1,
        damn: 1,
        hell: 1,
      });
    });

    it('counts a phrase once, not once more for each word in it', () => {
      expect(analyzeProfanity('what a piece of shit')).toStrictEqual({ 'piece of shit': 1 });
      expect(analyzeProfanity('god damn it, shit-head')).toStrictEqual({
        'god damn': 1,
        'shit-head': 1,
      });
    });

    it('counts the longest of overlapping matches, even when a shorter one starts first', () => {
      expect(analyzeProfanity('black cock-sucker')).toStrictEqual({ 'cock-sucker': 1 });
    });

    it('counts a decomposed accent the same as a precomposed one', () => {
      // "shi" + a combining diaeresis + "t" looks identical to "shït"
      expect(analyzeProfanity('shït')).toStrictEqual(analyzeProfanity('shït'));
      expect(analyzeProfanity('shït')).toStrictEqual({ shit: 1 });
    });

    it('sees through look-alike characters and case', () => {
      expect(analyzeProfanity('SHIT, shït and ＦＵＣＫ')).toStrictEqual({
        shit: 2,
        fuck: 1,
      });
    });

    it('doesn\'t collapse repeated letters, which would make `butt` match "but"', () => {
      expect(analyzeProfanity('but why')).toStrictEqual({});
    });
  });

  describe(generateResponseMessage, () => {
    it('should generate message with medal emojis for top 3 profanities', () => {
      const analysis: ProfanityAnalysis = {
        totalCount: 10,
        wordCounts: {
          damn: 4,
          hell: 3,
          shit: 2,
          crap: 1,
        },
        topThree: [
          { word: 'damn', count: 4, rank: 1 },
          { word: 'hell', count: 3, rank: 2 },
          { word: 'shit', count: 2, rank: 3 },
        ],
        postCount: 20,
      };

      const username = 'testuser';
      const message = generateResponseMessage(analysis, username, 20, THEY);

      // Check if message contains the medal emojis
      expect(message).toContain('🥇');
      expect(message).toContain('🥈');
      expect(message).toContain('🥉');

      // Check if the message contains the top words
      expect(message).toContain('"damn"');
      expect(message).toContain('"hell"');
      expect(message).toContain('"shit"');

      // Check if the message doesn't contain the pin emoji anymore
      expect(message).not.toContain('📌');
    });

    it('should handle users with no profanity', () => {
      const analysis: ProfanityAnalysis = {
        totalCount: 0,
        wordCounts: {},
        topThree: [],
        postCount: 20,
      };

      const username = 'gooduser';
      const message = generateResponseMessage(analysis, username, 20, THEY);

      expect(message).toContain('good citizen');
      expect(message).not.toContain('🥇');
      expect(message).not.toContain('🥈');
      expect(message).not.toContain('🥉');
    });

    // See #9. This list is on purpose separate from `UNQUOTABLE_WORDS`: a word
    // dropped from the set would otherwise drop its own test case too
    it.each([
      'ass-pirate',
      'asspirate',
      'assbandit',
      'butt-pirate',
      'beaner',
      'chink',
      'coon',
      'dyke',
      'faggot',
      'fudge packer',
      'gook',
      'kike',
      'nigger',
      'paki',
      'pedophile',
      'puto',
      'rape',
      'retard',
      'spic',
      'tranny',
      'wetback',
    ])("doesn't repeat %s verbatim", (word) => {
      expect(UNQUOTABLE_WORDS.has(word)).toBe(true);

      const analysis: ProfanityAnalysis = {
        totalCount: 3,
        wordCounts: { [word]: 3 },
        topThree: [{ word, count: 3, rank: 1 }],
        postCount: 20,
      };

      const message = generateResponseMessage(analysis, 'testuser', 20, THEY);

      expect(message).not.toContain(word);
      expect(message).toContain(`🥇 "${renderWord(word)}" (3 times)`);
    });

    it("doesn't repeat any word on the list verbatim", () => {
      for (const word of UNQUOTABLE_WORDS) {
        const analysis: ProfanityAnalysis = {
          totalCount: 3,
          wordCounts: { [word]: 3 },
          topThree: [{ word, count: 3, rank: 1 }],
          postCount: 20,
        };

        expect(generateResponseMessage(analysis, 'testuser', 20, THEY)).not.toContain(word);
      }
    });

    it("doesn't call someone a good citizen when there were no posts to check", () => {
      const analysis: ProfanityAnalysis = {
        totalCount: 0,
        wordCounts: {},
        topThree: [],
        postCount: 0,
      };

      const message = generateResponseMessage(analysis, 'quiet.bsky.social', 0, THEY);

      expect(message).toBe(
        'No original posts found for @quiet.bsky.social in the last year to analyze.',
      );
    });

    describe('length', () => {
      // 250 characters, near the 253 a handle can be
      const LONG_HANDLE = `${`${'a'.repeat(60)}.`.repeat(3)}${'b'.repeat(55)}.bsky.social`;

      const swears: ProfanityAnalysis = {
        totalCount: 1_234_567,
        wordCounts: {},
        topThree: [
          { word: 'motherfucker', count: 1_000_000, rank: 1 },
          { word: 'shit', count: 200_000, rank: 2 },
          { word: 'damn', count: 34_567, rank: 3 },
        ],
        postCount: 25_000,
      };

      it('builds the synthetic handle we meant to', () => {
        expect(LONG_HANDLE).toHaveLength(250);
      });

      it("doesn't leave trailing whitespace after the medals", () => {
        const message = generateResponseMessage(swears, 'testuser', 25_000, THEY);

        expect(message).toBe(message.trimEnd());
        expect(message.endsWith('🥉 "damn" (34,567 times)')).toBe(true);
      });

      it('keeps every medal when they fit', () => {
        expect(generateResponseMessage(swears, 'testuser', 25_000, THEY)).toBe(
          `@testuser has swears! They've used 1,234,567 profanities in their last 25,000 posts.\n\n` +
            `🥇 "motherfucker" (1,000,000 times)\n🥈 "shit" (200,000 times)\n🥉 "damn" (34,567 times)`,
        );
      });

      it('drops medals from the bottom up before touching the lede', () => {
        // Long enough that only the gold medal still fits
        const handle = `${`${'a'.repeat(60)}.`.repeat(2)}${'b'.repeat(50)}.bsky.social`;
        const message = generateResponseMessage(swears, handle, 25_000, THEY);

        expect(message).toContain(`@${handle} has swears!`);
        expect(message).toContain('🥇');
        expect(message).not.toContain('🥈');
        expect(message).not.toContain('🥉');
        expect(graphemes(message)).toBeLessThanOrEqual(300);
      });

      it.each([
        ['swears', swears, 25_000, '1,234,567'],
        ['a good citizen', { ...swears, totalCount: 0, topThree: [] }, 25_000, '25,000'],
        [
          'no posts',
          { ...swears, totalCount: 0, topThree: [], postCount: 0 },
          0,
          'no original posts',
        ],
      ])(
        'fits a 250 character handle with %s into one post',
        (_name, analysis, postCount, count) => {
          const message = generateResponseMessage(analysis, LONG_HANDLE, postCount, THEY);

          expect(graphemes(message)).toBeLessThanOrEqual(300);
          expect(message).toContain(`@${LONG_HANDLE}`);
          expect(message).toContain(count);
        },
      );

      it('still fits the longest handle allowed, 253 characters', () => {
        const handle = `${`${'a'.repeat(63)}.`.repeat(3)}${'b'.repeat(54)}.social`;
        expect(handle).toHaveLength(253);

        const message = generateResponseMessage(swears, handle, 25_000, THEY);

        expect(graphemes(message)).toBeLessThanOrEqual(300);
        expect(message).toBe(`@${handle}: 1,234,567 profanities in 25,000 posts.`);
      });

      it('falls back to just the number for a handle no post could hold', () => {
        const message = generateResponseMessage(swears, 'a'.repeat(400), 25_000, THEY);

        expect(message).toBe('1,234,567 profanities in their last 25,000 posts.');
      });
    });

    describe('pronouns', () => {
      const swears: ProfanityAnalysis = {
        totalCount: 42,
        wordCounts: { damn: 42 },
        topThree: [{ word: 'damn', count: 42, rank: 1 }],
        postCount: 1000,
      };
      const clean: ProfanityAnalysis = {
        totalCount: 0,
        wordCounts: {},
        topThree: [],
        postCount: 1000,
      };

      it.each([
        [undefined, "They've used 42 profanities in their last 1,000 posts."],
        ['she/her', "She's used 42 profanities in her last 1,000 posts."],
        ['he/him', "He's used 42 profanities in his last 1,000 posts."],
        ['it/its', "It's used 42 profanities in its last 1,000 posts."],
        ['xe/xem', "Xe's used 42 profanities in xyr last 1,000 posts."],
        ['ze/zir', "Ze's used 42 profanities in zir last 1,000 posts."],
      ])('uses %s pronouns when someone swears', (raw, expected) => {
        expect(
          generateResponseMessage(swears, 'someone.bsky.social', 1000, parsePronouns(raw)),
        ).toContain(`@someone.bsky.social has swears! ${expected}`);
      });

      it.each([
        [undefined, 'their'],
        ['she/her', 'her'],
        ['he/him', 'his'],
        ['xe/xir', 'xir'],
      ])('uses %s pronouns for a good citizen', (raw, possessive) => {
        expect(
          generateResponseMessage(clean, 'someone.bsky.social', 1000, parsePronouns(raw)),
        ).toBe(
          `@someone.bsky.social has been a good citizen!\nNo profanity found in ${possessive} last 1,000 posts.`,
        );
      });
    });
  });

  describe(renderWord, () => {
    it("masks all but the first and last letter of a word we won't repeat", () => {
      expect(renderWord('retard')).toBe('r****d');
      expect(renderWord('tard')).toBe('t**d');
      expect(renderWord('jap')).toBe('j*p');
    });

    it('masks each word of a phrase', () => {
      expect(renderWord('white power')).toBe('w***e p***r');
    });

    it('leaves ordinary profanity alone', () => {
      expect(renderWord('fuck')).toBe('fuck');
      expect(renderWord('piece of shit')).toBe('piece of shit');
    });

    it('only masks words that are actually on the list', () => {
      for (const word of UNQUOTABLE_WORDS) {
        expect(BAD_WORDS.has(word)).toBe(true);
      }
    });
  });
});
