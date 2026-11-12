// The two forms a reply needs: how it starts ("They've used") and the
// possessive ("in their last 1,000 posts")
export type Pronouns = { subjectHas: string; possessive: string };

export const THEY: Pronouns = { subjectHas: "They've", possessive: 'their' };

type PronounSet = Pronouns & { words: ReadonlySet<string> };

const set = (subjectHas: string, possessive: string, words: string[]): PronounSet => ({
  subjectHas,
  possessive,
  words: new Set(words),
});

// xe and ze each come in two spellings, told apart by their other forms
// (ie: `xe/xem` is xyr, `xe/xir` is xir), so `xe` on its own matches both
const PRONOUN_SETS: PronounSet[] = [
  set("He's", 'his', ['he', 'him', 'his', 'himself']),
  set("She's", 'her', ['she', 'her', 'hers', 'herself']),
  set("It's", 'its', ['it', 'its', 'itself']),
  set("Xe's", 'xyr', ['xe', 'xem', 'xyr', 'xyrs', 'xemself']),
  set("Xe's", 'xir', ['xe', 'xir', 'xirs', 'xirself']),
  set("Ze's", 'hir', ['ze', 'hir', 'hirs', 'hirself']),
  set("Ze's", 'zir', ['ze', 'zir', 'zirs', 'zirself']),
];

const THEY_WORDS = new Set(['they', 'them', 'their', 'theirs', 'themself', 'themselves']);

// Words that flip the meaning of the pronouns around them (ie: `any except
// he/him`). Every other word we don't know is safe to skip.
const NEGATIONS = new Set(['except', 'not', 'no', 'never', 'avoid', "don't", 'dont']);

// Letters, keeping apostrophes inside a word, so `it's` and `don't` stay whole
const toWords = (raw: string) =>
  raw
    .toLowerCase()
    .replaceAll('’', "'")
    .split(/[^\p{L}']+/u)
    .map((word) => word.replaceAll(/^'+|'+$/gu, ''))
    .filter(Boolean);

/**
 * Picks the pronouns to use for someone from their profile's free-text
 * `pronouns` field. Always one they listed, or "they" if we can't tell.
 *
 * - Words we don't know are skipped: names, jokes, other languages, emoji
 *   (ie: `she/her/ella`, `He/Him/Boss` and `she and her` all count)
 * - If they listed "they" anywhere (ie: `she/they`, `they/he`), it's "they"
 * - Otherwise it's the first one they listed (ie: `it/she` is "it")
 * - A negation (ie: `any except he/him`) means "they", since we'd only be
 *   guessing at what's left
 * - xe and ze's spelling comes from their other words; if we can't tell which
 *   (ie: `xe` on its own), it's "they"
 */
export const parsePronouns = (raw: string | undefined): Pronouns => {
  const words = toWords(raw ?? '');

  if (words.some((word) => NEGATIONS.has(word) || THEY_WORDS.has(word))) {
    return THEY;
  }

  for (const word of words) {
    const sets = PRONOUN_SETS.filter((pronounSet) => pronounSet.words.has(word));
    if (sets.length > 0) {
      const matches =
        sets.length === 1
          ? sets
          : sets.filter((pronounSet) =>
              words.some((other) => other !== word && pronounSet.words.has(other)),
            );

      if (matches.length !== 1) {
        return THEY;
      }

      const [{ subjectHas, possessive }] = matches;
      return { subjectHas, possessive };
    }
  }

  return THEY;
};
