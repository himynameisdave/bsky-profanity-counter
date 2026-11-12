import { describe, it, expect } from 'vitest';
import { parsePronouns, THEY } from '../src/services/pronouns.js';

const HE = { subjectHas: "He's", possessive: 'his' };
const SHE = { subjectHas: "She's", possessive: 'her' };
const IT = { subjectHas: "It's", possessive: 'its' };

// Most of these are real, from a sample of public Bluesky profiles
describe(parsePronouns, () => {
  it.each([
    ['she/her', SHE],
    ['she', SHE],
    ['She/Her', SHE],
    ['she / her', SHE],
    ['she, her, hers', SHE],
    ['(she/her)', SHE],
    ['he/him', HE],
    ['he', HE],
    ['HE/HIM', HE],
    ['he/him/his', HE],
    ['it/its', IT],
  ])('uses %j', (raw, expected) => {
    expect(parsePronouns(raw)).toStrictEqual(expected);
  });

  it.each([
    ['she and her', SHE],
    ['she/her 🏳️‍⚧️', SHE],
    ['she/her please.', SHE],
    ['she/her (usually)', SHE],
    ['She/Her/Boss', SHE],
    ['Intersex, She/Her', SHE],
    ['she/her/ella', SHE],
    ['elle/her', SHE],
    ['il/lui (he/him)', HE],
    ['Ele/Dele He/Him', HE],
    ['he/him | pup/puppy', HE],
    ['he/him with spice', HE],
  ])('skips the words it doesn’t know in %j', (raw, expected) => {
    expect(parsePronouns(raw)).toStrictEqual(expected);
  });

  it.each([
    ['she/it', SHE],
    ['it/she', IT],
    ['he/it', HE],
    ['he/she', HE],
    ['she/he', SHE],
    ['she/her, it/its', SHE],
    ['She/Her + He/Him', SHE],
    ['he/any', HE],
  ])('uses the first one listed in %j', (raw, expected) => {
    expect(parsePronouns(raw)).toStrictEqual(expected);
  });

  it.each([
    ['xe/xem', "Xe's", 'xyr'],
    ['xe/xem/xyr', "Xe's", 'xyr'],
    ['Xem/Xem/Fae/Faen', "Xe's", 'xyr'],
    ['xe/xir', "Xe's", 'xir'],
    ['xe/xir/xirs', "Xe's", 'xir'],
    ['ze/hir', "Ze's", 'hir'],
    ['ze/zir', "Ze's", 'zir'],
  ])('tells the %j spelling apart by its other forms', (raw, subjectHas, possessive) => {
    expect(parsePronouns(raw)).toStrictEqual({ subjectHas, possessive });
  });

  it.each([
    // Not set, or nothing we know
    undefined,
    '',
    '   ',
    '🏳️‍🌈',
    'any/all',
    'any pronouns',
    'fae/faer',
    'ey/em',
    'Taylor Swift',
    // They listed "they", so it's one of theirs
    'they/them',
    'they',
    'she/they',
    'he/they',
    'they/she',
    'they/he/she',
    'she/her they/them',
    'he/him (sing. they)',
    // A negation changes what the rest means
    'any except he/him',
    'Any Except He',
    "don't call me she",
    'not he',
    // Can't tell which possessive they use
    'xe',
    'ze',
    'xe/xyr/xir',
    'ze/hir/zir',
    // Words that only look like a pronoun
    'hehe',
    'shelby',
    'xenon',
    "it's complicated",
  ])('falls back to they for %j', (raw) => {
    expect(parsePronouns(raw)).toBe(THEY);
  });
});
