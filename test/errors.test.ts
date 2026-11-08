import { describe, it, expect } from 'vitest';
import { describeError } from '../src/errors.js';

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
