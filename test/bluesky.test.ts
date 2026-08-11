import { describe, it, expect, vi } from 'vitest';
import type { BskyAgent } from '@atproto/api';
import { getReplyRefs, replyToPost } from '../src/services/bluesky.js';

// bluesky.js throws at import time when credentials are missing, and hoisted
// callbacks run before any import, so this is the spot to make sure it has some
vi.hoisted(() => {
  process.env.BLUESKY_IDENTIFIER ??= 'test.bot';
  process.env.BLUESKY_PASSWORD ??= 'test-password';
});

vi.mock(import('../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));

// The post which mentions the bot, ie. the one we reply to
const MENTION = {
  uri: 'at://did:plc:mentioner/app.bsky.feed.post/mention',
  cid: 'bafy-mention',
};

// The post which started the thread the mention lives in
const THREAD_ROOT = {
  uri: 'at://did:plc:original/app.bsky.feed.post/root',
  cid: 'bafy-root',
};

// The post the mention is directly replying to, somewhere below the root
const THREAD_PARENT = {
  uri: 'at://did:plc:someone/app.bsky.feed.post/parent',
  cid: 'bafy-parent',
};

// What getPost() hands back for a mention nested inside a thread
const nestedMentionPost = () => ({
  ...MENTION,
  value: {
    text: '@profanity.accountant how bad is this person?',
    createdAt: '2025-01-01T00:00:00.000Z',
    reply: {
      root: THREAD_ROOT,
      parent: THREAD_PARENT,
    },
  },
});

// What getPost() hands back for a mention which is itself a top-level post
const topLevelMentionPost = () => ({
  ...MENTION,
  value: {
    text: '@profanity.accountant how bad am I?',
    createdAt: '2025-01-01T00:00:00.000Z',
  },
});

const createFakeAgent = () => ({
  post: vi.fn<() => void>(),
  resolveHandle: vi.fn<() => void>(),
});

describe('Reply ref derivation', () => {
  it('should use the thread root from the record when the post is itself a reply', () => {
    const refs = getReplyRefs(nestedMentionPost());

    expect(refs.parent).toStrictEqual(MENTION);
    expect(refs.root).toStrictEqual(THREAD_ROOT);
  });

  it('should not mistake the post being replied to for the thread root', () => {
    const refs = getReplyRefs(nestedMentionPost());

    expect(refs.root).not.toStrictEqual(THREAD_PARENT);
    expect(refs.root).not.toStrictEqual(MENTION);
  });

  it('should use the post itself as the root when it is a top-level post', () => {
    const refs = getReplyRefs(topLevelMentionPost());

    expect(refs.parent).toStrictEqual(MENTION);
    expect(refs.root).toStrictEqual(MENTION);
  });

  it('should use the post itself as the root when there is no record', () => {
    const refs = getReplyRefs(MENTION);

    expect(refs.parent).toStrictEqual(MENTION);
    expect(refs.root).toStrictEqual(MENTION);
  });

  it('should use the post itself as the root when the root ref is incomplete', () => {
    const refs = getReplyRefs({
      ...MENTION,
      value: {
        reply: {
          root: { uri: THREAD_ROOT.uri },
          parent: THREAD_PARENT,
        },
      },
    });

    expect(refs.root).toStrictEqual(MENTION);
  });
});

describe('Replying to a mention', () => {
  it('should thread the reply under the original conversation root', async () => {
    const agent = createFakeAgent();

    await replyToPost(agent as unknown as BskyAgent, nestedMentionPost(), 'Beep boop.');

    expect(agent.post).toHaveBeenCalledWith({
      text: 'Beep boop.',
      facets: undefined,
      reply: {
        parent: MENTION,
        root: THREAD_ROOT,
      },
    });
  });

  it('should use the mention as the root when it is a top-level post', async () => {
    const agent = createFakeAgent();

    await replyToPost(agent as unknown as BskyAgent, topLevelMentionPost(), 'Beep boop.');

    expect(agent.post).toHaveBeenCalledWith({
      text: 'Beep boop.',
      facets: undefined,
      reply: {
        parent: MENTION,
        root: MENTION,
      },
    });
  });
});
