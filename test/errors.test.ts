import { describe, it, expect } from 'vitest';
import { XRPCError } from '@atproto/api';
import { isTerminalMentionError, TerminalMentionError, describeError } from '../src/errors.js';

describe(describeError, () => {
  it('includes every cause in the chain, outermost first', () => {
    const error = new Error('Gave up fetching posts chunk #3', {
      cause: new Error('The server gave an invalid response and may be out of date.', {
        cause: new Error('Output/feed/13/post/embed/record/embeds/0/alt is too long'),
      }),
    });

    expect(describeError(error)).toBe(
      'Gave up fetching posts chunk #3' +
        ' ← caused by: The server gave an invalid response and may be out of date.' +
        ' ← caused by: Output/feed/13/post/embed/record/embeds/0/alt is too long',
    );
  });

  it('describes an error without a cause as just its message', () => {
    expect(describeError(new Error('Internal Server Error'))).toBe('Internal Server Error');
  });

  it('copes with things thrown that are not errors', () => {
    expect(describeError('a bare string')).toBe('a bare string');
    expect(describeError(new Error('wrapped', { cause: 42 }))).toBe('wrapped ← caused by: 42');
    expect(describeError(null)).toBe('unknown error');
  });

  it('stops following a cause chain that loops back on itself', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;

    expect(describeError(first).split(' ← caused by: ')).toHaveLength(5);
  });
});

describe('terminal mention errors', () => {
  it('recognises terminal account errors through a feed retry wrapper', () => {
    const failure = new XRPCError(400, 'BlockedActor', 'Blocked');
    const wrapped = new Error('Feed failed', { cause: failure });
    expect(isTerminalMentionError(wrapped)).toBe(true);
    expect(isTerminalMentionError(new TerminalMentionError('Reply too long'))).toBe(true);
  });

  it.each([
    new Error('Network failure'),
    new XRPCError(429, 'BlockedActor', 'Rate limited'),
    new XRPCError(503, 'ActorNotFound', 'Temporary outage'),
    new XRPCError(400, 'InvalidRequest', 'Unknown problem'),
    new XRPCError(401, 'ExpiredToken', 'Login expired'),
    new Error('Invalid response from server', { cause: new Error('Feed post too long') }),
  ])('keeps temporary and unknown failures retryable: %s', (failure) => {
    expect(isTerminalMentionError(failure)).toBe(false);
  });
});
