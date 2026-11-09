import { XRPCError } from '@atproto/api';

// Deep enough for any real chain, and stops us looping on a cyclic `cause`
const MAX_CAUSE_DEPTH = 5;

const TERMINAL_MENTION_ERROR_CODES = new Set([
  'BlockedActor',
  'BlockedByActor',
  'ActorNotFound',
  'RepoNotFound',
  'AccountNotFound',
  'AccountDeactivated',
  'AccountTakedown',
  'InvalidRecord',
]);

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

/** A local invariant or outgoing record that cannot succeed unchanged. */
export class TerminalMentionError extends Error {
  override name = 'TerminalMentionError';
}

/** Only known account/block/record failures are terminal. Unknown errors retry. */
export const isTerminalMentionError = (error: unknown): boolean => {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    if (current instanceof TerminalMentionError) {
      return true;
    }
    if (current instanceof XRPCError) {
      // Never turn an outage or rate limit into a permanent failure, even if
      // a server attaches an otherwise-terminal error code.
      if (Number(current.status) === 408 || current.status === 429 || current.status >= 500) {
        return false;
      }
      if (
        TERMINAL_MENTION_ERROR_CODES.has(current.error) ||
        (current.error === 'InvalidRequest' &&
          /^(?:Could not find (?:repo|profile)|Profile not found)/u.test(current.message))
      ) {
        return true;
      }
    }
    current = current.cause;
  }
  return false;
};
