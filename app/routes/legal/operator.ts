/**
 * The operator's legal identity, as data.
 *
 * WHY THIS IS NOT IN THE TRANSLATION BUNDLE
 *   Everything here is an IDENTIFIER, not prose. A company name, a street, a
 *   register number and a VAT id mean the same thing in every language and must
 *   be byte-identical in all of them. A German Impressum that names a subtly
 *   different company than the English one is worse than having only one.
 *
 *   Keeping these values out of `app/locales/*` makes that structural rather
 *   than something a test has to catch: there is one copy, so the two renders
 *   cannot disagree, and no translation model ever sees them and "helpfully"
 *   localises a street name.
 *
 * DO NOT "FIX" THE ADDRESS
 *   "Straße 73" is a real street name in 13125 Berlin and "49" is the house
 *   number. It is not a typo and it is not reversed.
 *
 * WHERE THESE VALUES COME FROM
 *   Reproduced verbatim from the already-shipped, operator-verified imprints in
 *   `openplate/app/routes/legal/operator.ts` and
 *   `nicotinepouch-org/app/routes/legal/imprint.tsx`. Nothing here was derived,
 *   inferred or invented for this repo. The operator still has to confirm that
 *   this legal person is the one that operates translate.altan.fyi; if it is
 *   not, this file is the single place that changes.
 */
export const OPERATOR = {
  /** The legal person. Not "translate.altan.fyi", which is a product name. */
  legalName: 'SPARQ VENTURES UG (haftungsbeschränkt)',
  street: 'Straße 73 49',
  postalCode: '13125',
  city: 'Berlin',
  /** In German in both locales: it is part of a postal address, not a sentence. */
  country: 'Deutschland',
  managingDirector: 'Altan Sarisin',
  registerNumber: 'HRB 174062 B',
  registerCourt: 'Amtsgericht Charlottenburg',
  vatId: 'DE312546809',
  imprintEmail: 'info@sprqvntrs.com',
  privacyEmail: 'partners@sportsight.de',
} as const;
