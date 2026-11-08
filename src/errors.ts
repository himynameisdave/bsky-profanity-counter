// Deep enough for any real chain, and stops us looping on a cyclic `cause`
const MAX_CAUSE_DEPTH = 5;

/**
 * Describes an error along with everything in its `cause` chain.
 *
 * `@atproto/api` puts the useful detail in the cause: a response that fails
 * lexicon validation surfaces as "The server gave an invalid response and may
 * be out of date", and only its cause says which field was wrong. Logging just
 * the message hides that.
 */
export const describeError = (error: unknown): string => {
  const messages: string[] = [];
  let current: unknown = error;

  while (current !== undefined && current !== null && messages.length < MAX_CAUSE_DEPTH) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }

  return messages.length > 0 ? messages.join(' ← caused by: ') : 'unknown error';
};
