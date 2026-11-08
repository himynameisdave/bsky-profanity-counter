import { describe, it, expect } from 'vitest';
import {
  analyzePosts,
  analyzeProfanity,
  generateResponseMessage,
  type ProfanityAnalysis,
} from '../src/services/profanity.js';
import type { AppBskyFeedDefs } from '@atproto/api';

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
      const message = generateResponseMessage(analysis, username, 20);

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
      const message = generateResponseMessage(analysis, username, 20);

      expect(message).toContain('good citizen');
      expect(message).not.toContain('🥇');
      expect(message).not.toContain('🥈');
      expect(message).not.toContain('🥉');
    });
  });
});
