import { RichText } from '@atproto/api';

// The limits app.bsky.feed.post puts on `text`. Bluesky's, not ours to tune.
export const MAX_GRAPHEMES = 300;
export const MAX_BYTES = 3000;

/**
 * Whether `text` fits in a post. Counted by the SDK's RichText, which counts
 * graphemes and UTF-8 bytes the same way the PDS does when it validates a post.
 */
export const fits = (text: string): boolean => {
  const rt = new RichText({ text });
  return rt.graphemeLength <= MAX_GRAPHEMES && rt.length <= MAX_BYTES;
};

/**
 * The first of `candidates` that fits in a post, or `fallback` if none do.
 * List them longest (and most informative) first.
 */
export const firstThatFits = (candidates: string[], fallback: string): string =>
  candidates.find((candidate) => fits(candidate)) ?? fallback;
