import type { BskyAgent } from '@atproto/api';
import type { Mention } from '@prisma/client';
import { replyToMention } from './reply.js';
import type { ReplyOutcome } from './reply.js';
import * as logger from './logger.js';

/**
 * Whimsical responses for when the bot is targeted by itself.
 * Persona: nerdy accountant type who takes their job seriously but has a sense of humor.
 */
export const WHIMSICAL_RESPONSES = [
  'Nice try, buddy! 😏',
  "Hey now, that's not how this works! 🙃",
  "Trying to break me? I'm unbreakable! 💪",
  "I don't analyze myself, I'm perfect! ✨",
  "Plot twist: I'm squeaky clean! 🧼",
  'Error 404: Self-audit not found! 🤓',
  'My books are balanced, thank you very much! 📚⚖️',
  "I've already reconciled my accounts - they're spotless! 🧮✨",
  'Attempting to audit the auditor? Frig off buddy!',
  'My profanity ledger shows zero entries for this account! 📋✅',
];

function getRandomResponse() {
  return WHIMSICAL_RESPONSES[Math.floor(Math.random() * WHIMSICAL_RESPONSES.length)];
}

/**
 * Handles mentions where the bot is targeting itself.
 * Should only be called when we've already confirmed this is a self-targeting attempt.
 */
export async function handleSelfTargeting(
  agent: BskyAgent,
  mention: Mention,
): Promise<ReplyOutcome> {
  logger.info(`🤖 Bot was targeted by itself, responding with whimsical message`);

  const outcome = await replyToMention(agent, mention, getRandomResponse());
  logger.success(`✅ Handled self-targeting mention with whimsical response`);
  return outcome;
}
