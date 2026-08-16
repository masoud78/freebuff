/**
 * Conservative destination-name normalization. Only meaning-preserving
 * transformations: Arabic yeh/kaf → Persian forms, case folding for Latin
 * aliases, and whitespace cleanup. Never changes the meaning of the name.
 */
export function normalizeDestinationName(input: string): string {
  return input
    .trim()
    .replace(/\u064A/g, '\u06CC') // Arabic yeh (ي) → Persian yeh (ی)
    .replace(/\u0643/g, '\u06A9') // Arabic kaf (ك) → Persian kaf (ک)
    .replace(/\u0649/g, '\u06CC') // Arabic alef maksura (ى) → Persian yeh
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .toLocaleLowerCase('fa-IR');
}
