import { describe, it, expect } from 'vitest';
import { formatNumber, generateProfileDescription } from '../../src/services/profile-updater.js';

describe('Profile Updater', () => {
  describe('formatNumber', () => {
    it('should format numbers with commas', () => {
      expect(formatNumber(0)).toBe('0');
      expect(formatNumber(1)).toBe('1');
      expect(formatNumber(123)).toBe('123');
      expect(formatNumber(1234)).toBe('1,234');
      expect(formatNumber(12345)).toBe('12,345');
      expect(formatNumber(123456)).toBe('123,456');
      expect(formatNumber(1234567)).toBe('1,234,567');
      expect(formatNumber(12345678)).toBe('12,345,678');
    });
  });

  describe('generateProfileDescription', () => {
    it('should generate correct profile description with formatted count', () => {
      const result = generateProfileDescription(1234567);
      const expected = `Tag me and I will respond telling you how much a profanity you (or the user you're replying to) has used in the last year (it may take me a few minutes to respond).

1,234,567 total profanities counted, you pottymouths!`;

      expect(result).toBe(expected);
    });

    it('should handle zero count', () => {
      const result = generateProfileDescription(0);
      const expected = `Tag me and I will respond telling you how much a profanity you (or the user you're replying to) has used in the last year (it may take me a few minutes to respond).

0 total profanities counted, you pottymouths!`;

      expect(result).toBe(expected);
    });

    it('should handle single digit count', () => {
      const result = generateProfileDescription(5);
      const expected = `Tag me and I will respond telling you how much a profanity you (or the user you're replying to) has used in the last year (it may take me a few minutes to respond).

5 total profanities counted, you pottymouths!`;

      expect(result).toBe(expected);
    });

    it('should handle large numbers', () => {
      const result = generateProfileDescription(999999999);
      const expected = `Tag me and I will respond telling you how much a profanity you (or the user you're replying to) has used in the last year (it may take me a few minutes to respond).

999,999,999 total profanities counted, you pottymouths!`;

      expect(result).toBe(expected);
    });
  });
});