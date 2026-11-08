import { describe, it, expect, vi } from 'vitest';
import { XRPCError, type BskyAgent } from '@atproto/api';

vi.mock(import('../../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));

// The bluesky service throws at import time without credentials
process.env.BLUESKY_IDENTIFIER ||= 'test.bot';
process.env.BLUESKY_PASSWORD ||= 'test-password';

const { getPost } = await import('../../src/services/bluesky.js');

const URI = 'at://did:plc:someone/app.bsky.feed.post/abc';

const agentWhoseGetPost = (fetchPost: () => Promise<unknown>) =>
  ({ getPost: fetchPost }) as unknown as BskyAgent;

describe(getPost, () => {
  it('returns the post', async () => {
    const post = { uri: URI, cid: 'bafy', value: { text: 'hi' } };
    const agent = agentWhoseGetPost(async () => post);

    await expect(getPost(agent, URI)).resolves.toStrictEqual(post);
  });

  // The two errors the live API gives for a post that's gone
  it.each([
    [
      'the post was deleted',
      new XRPCError(400, 'RecordNotFound', `Could not locate record: ${URI}`),
    ],
    [
      "the post's account is gone",
      new XRPCError(400, 'InvalidRequest', 'Could not find repo: did:plc:someone'),
    ],
  ])('returns null when %s', async (_reason, error) => {
    const agent = agentWhoseGetPost(async () => {
      throw error;
    });

    await expect(getPost(agent, URI)).resolves.toBeNull();
  });

  it.each([
    ['a server error', new XRPCError(500, 'InternalServerError', 'Internal Server Error')],
    ['a different bad request', new XRPCError(400, 'InvalidRequest', 'Something else')],
    ['a network error', new TypeError('fetch failed')],
  ])('throws on %s, so the mention is retried instead of dropped', async (_reason, error) => {
    const agent = agentWhoseGetPost(async () => {
      throw error;
    });

    await expect(getPost(agent, URI)).rejects.toBe(error);
  });
});
