import dotenv from 'dotenv';
import type { ProfanityAnalysis } from './profanity.js';

dotenv.config();

// Cache duration in milliseconds (24 hours)
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000;

// Type for cache entries
type CacheEntry = {
  timestamp: number;
  data: ProfanityAnalysis;
};

// Simple in-memory cache
class Cache {
  private cache = new Map<string, CacheEntry>();

  // Get an item from the cache
  get(key: string): ProfanityAnalysis | null {
    const entry = this.cache.get(key);

    // If entry doesn't exist or is expired, return null
    if (!entry || Date.now() - entry.timestamp > CACHE_DURATION_MS) {
      return null;
    }

    // Ensure backward compatibility with cached entries that don't have postCount
    if (entry.data && entry.data.postCount === undefined) {
      entry.data.postCount = 100; // Default to 100 for old cached entries
    }

    return entry.data;
  }

  // Set an item in the cache
  set(key: string, data: ProfanityAnalysis): void {
    this.cache.set(key, {
      timestamp: Date.now(),
      data,
    });
  }

  // Clear expired entries from the cache
  cleanup(): void {
    const now = Date.now();

    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > CACHE_DURATION_MS) {
        this.cache.delete(key);
      }
    }
  }
}

// Export a singleton instance
export const profanityCache = new Cache();
