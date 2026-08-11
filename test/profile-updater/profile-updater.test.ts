import { describe, it, expect } from 'vitest';
import { formatNumber, generateProfileDescription } from '../../src/services/profile-updater.js';

const expectedDescription = (formattedCount: string) =>
  `Tag me and I will respond telling you how much a profanity you (or the user you're replying to) has used in the last year (it may take me a few minutes to respond).

${formattedCount} total profanities counted, you pottymouths!`;

describe('Profile Updater', () => {
  describe(formatNumber, () => {
    it('should format numbers with commas', () => {
      expect(formatNumber(0)).toBe('0');
      expect(formatNumber(1)).toBe('1');
      expect(formatNumber(123)).toBe('123');
      expect(formatNumber(1234)).toBe('1,234');
      expect(formatNumber(12_345)).toBe('12,345');
      expect(formatNumber(123_456)).toBe('123,456');
      expect(formatNumber(1_234_567)).toBe('1,234,567');
      expect(formatNumber(12_345_678)).toBe('12,345,678');
    });
  });

  describe(generateProfileDescription, () => {
    it('should generate correct profile description with formatted count', () => {
      expect(generateProfileDescription(1_234_567)).toBe(expectedDescription('1,234,567'));
    });

    it('should handle zero count', () => {
      expect(generateProfileDescription(0)).toBe(expectedDescription('0'));
    });

    it('should handle single digit count', () => {
      expect(generateProfileDescription(5)).toBe(expectedDescription('5'));
    });

    it('should handle large numbers', () => {
      expect(generateProfileDescription(999_999_999)).toBe(expectedDescription('999,999,999'));
    });
  });
});
