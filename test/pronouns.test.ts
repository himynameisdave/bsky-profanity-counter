import { describe, it, expect } from 'vitest';
import { parsePronouns, THEY } from '../src/services/pronouns.js';

const HE = { subjectHas: "He's", possessive: 'his' };
const SHE = { subjectHas: "She's", possessive: 'her' };
const IT = { subjectHas: "It's", possessive: 'its' };

describe(parsePronouns, () => {
  it.each([
    ['she/her', SHE],
    ['she', SHE],
    ['She/Her', SHE],
    ['she / her', SHE],
    ['she, her, hers', SHE],
    ['she/her 🏳️‍⚧️', SHE],
    ['(she/her)', SHE],
    ['he/him', HE],
    ['he', HE],
    ['HE/HIM 🇨🇦', HE],
    ['he/him/his', HE],
    ['him/he', HE],
    ['it/its', IT],
  ])('uses the one set %j belongs to', (raw, expected) => {
    expect(parsePronouns(raw)).toStrictEqual(expected);
  });

  it.each([
    ['xe/xem', "Xe's", 'xyr'],
    ['xe/xem/xyr', "Xe's", 'xyr'],
    ['xe/xir', "Xe's", 'xir'],
    ['xe/xir/xirs', "Xe's", 'xir'],
    ['ze/hir', "Ze's", 'hir'],
    ['ze/zir', "Ze's", 'zir'],
  ])('tells the %j spelling apart by its other forms', (raw, subjectHas, possessive) => {
    expect(parsePronouns(raw)).toStrictEqual({ subjectHas, possessive });
  });

  it.each([
    // Not set, or nothing but symbols
    undefined,
    '',
    '   ',
    '🏳️‍🌈',
    'they/them',
    // Mixed sets: "they" is always one they've listed, so it's never wrong
    'he/they',
    'she/they',
    'they/she',
    'she/he',
    // Can't tell which possessive they use
    'xe',
    'ze',
    'xe/xyr/xir',
    'ze/hir/zir',
    // Sets we don't know
    'fae/faer',
    'ey/em',
    'any/all',
    'ask me',
    'elle/her',
    // Extra words
    'she/her (ask)',
    'he/him, any',
    // Words that only start like a pronoun
    'hehe',
    'shelby',
    'xenon',
  ])('falls back to they for %j', (raw) => {
    expect(parsePronouns(raw)).toBe(THEY);
  });
});
