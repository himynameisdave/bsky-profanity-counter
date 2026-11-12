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

/**
 * Picks the pronouns to use for someone from their profile's free-text
 * `pronouns` field.
 *
 * Only switches from "they" when every word in it belongs to exactly one set we
 * know (ie: `she/her`, `He / Him 🇨🇦`, just `she`). Emoji and punctuation are
 * ignored. Anything else falls back to "they", which is always in a mixed set
 * like `he/they`, and never wrong: `they/she`, `xe` on its own (we can't tell
 * which possessive), `she/her (ask)`, `any/all`, or nothing at all.
 */
export const parsePronouns = (raw: string | undefined): Pronouns => {
  const words = (raw ?? '')
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);

  if (words.length === 0) {
    return THEY;
  }

  const matches = PRONOUN_SETS.filter((pronounSet) =>
    words.every((word) => pronounSet.words.has(word)),
  );

  if (matches.length !== 1) {
    return THEY;
  }

  const [{ subjectHas, possessive }] = matches;
  return { subjectHas, possessive };
};
