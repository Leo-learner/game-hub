// Which of the owner's Clerk sessions the owner-only sites accept.
//
// requireOwner() has already checked that the token is valid, unexpired, minted
// for this site, and that claims.sub is the owner's user id. This function only
// decides whether that session is strong and fresh enough.
import type { ClerkSessionClaims } from './clerk-gate.js';

export type OwnerSite = 'nbd' | 'clawdrop' | 'plos' | 'unfortunately';

/**
 * Return true to let this owner session in, false to answer 403 "stale-session"
 * (the site then sends the owner to accounts.dkz12345.com to sign in again).
 *
 * claims.fva is [minutesSinceFirstFactor, minutesSinceSecondFactor]:
 *   - first factor  = password, email code, GitHub/Google, or passkey
 *   - second factor = authenticator app or backup code; -1 means no second
 *     factor was verified in this session (for example MFA is not set up)
 *   - fva can be missing if Clerk ever stops sending it; treat that as unknown.
 * Clerk ends any session after 7 days idle / 30 days total regardless.
 *
 * Throwing is treated as "deny" (403 policy-error), so an unfinished policy
 * fails closed.
 */
export function ownerSessionAcceptable(claims: ClerkSessionClaims, site: OwnerSite): boolean {
  // TODO(Leo): write the rule (5-10 lines). Things to decide:
  //   1. Require a second factor (claims.fva[1] !== -1) on every owner site, or only some?
  //   2. How old may the first-factor sign-in be (in minutes) before you must sign in again?
  //   3. Should nbd (private journal) be stricter than plos or clawdrop?
  void claims;
  void site;
  throw new Error('ownerSessionAcceptable() is not written yet');
}
