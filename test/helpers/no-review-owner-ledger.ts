import { ledgerReviewOwnerCessation } from '../../src/runtime/registry.js';

/** A service-registry fixture that keeps no review-owner ledger (#464):
 * recording a cessation fails (and is logged), and nothing reads as
 * durably ceased. */
export const NO_REVIEW_OWNER_LEDGER = ledgerReviewOwnerCessation(() => {
  throw new Error('this fixture keeps no review-owner ledger');
});
