import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { BskyAgent } from '@atproto/api';
import type { Mention } from '@prisma/client';
import * as bsky from '../src/services/bluesky.js';
import { handleSelfTargeting } from '../src/services/self-targeting.js';

vi.mock(import('../src/services/database.js'), () => ({
  markMentionAsDone: vi.fn<() => void>(),
}));

vi.mock(import('../src/services/bluesky.js'), () => ({
  getPost: vi.fn<() => void>(),
  replyToPost: vi.fn<() => void>(),
}));

vi.mock(import('../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));

// The mocked module hands back plain mock functions
const getPostMock = bsky.getPost as unknown as Mock;
const replyToPostMock = bsky.replyToPost as unknown as Mock;

// A mention of the bot which lives partway down someone else's thread
const MENTION_POST = {
  uri: 'at://did:plc:bot/app.bsky.feed.post/mention',
  cid: 'bafy-mention',
  value: {
    text: '@profanity.accountant analyse yourself',
    createdAt: '2025-01-01T00:00:00.000Z',
    reply: {
      root: {
        uri: 'at://did:plc:original/app.bsky.feed.post/root',
        cid: 'bafy-root',
      },
      parent: {
        uri: 'at://did:plc:someone/app.bsky.feed.post/parent',
        cid: 'bafy-parent',
      },
    },
  },
};

// What our own reply comes back as once posted
const OUR_REPLY = {
  uri: 'at://did:plc:bot/app.bsky.feed.post/ourreply',
  cid: 'bafy-ourreply',
};

const mention = {
  id: 'mention-id',
  userHandle: 'profanity.accountant',
  postUrl: MENTION_POST.uri,
} as Mention;

describe('Self-targeting replies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPostMock.mockResolvedValue(MENTION_POST);
    replyToPostMock.mockResolvedValue(OUR_REPLY);
  });

  it('should pass the whole mention post through to replyToPost', async () => {
    await handleSelfTargeting({} as BskyAgent, mention);

    expect(replyToPostMock).toHaveBeenCalledOnce();

    // The record has to come along for the ride, otherwise replyToPost cannot
    // work out the thread root and our reply forks the conversation
    const [[, replyTo]] = replyToPostMock.mock.calls;
    expect(replyTo).toStrictEqual(MENTION_POST);
  });
});
