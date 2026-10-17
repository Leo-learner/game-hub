// Test helper: mints Clerk-shaped RS256 session tokens with a throwaway key,
// so sites can test their auth paths without a network or a real instance.
import { generateKeyPairSync, sign } from 'node:crypto';
import { CLERK_ISSUER, type ClerkSessionClaims } from './clerk-gate.js';

export const TEST_PUBLISHABLE_KEY = 'pk_test_Y2xlcmstZ2F0ZS50ZXN0JA';

export interface TestSigner {
  /** PEM public key to pass as jwtKey. */
  jwtKey: string;
  /** A signed token; `claims` override the defaults, `null` removes a claim. */
  token(claims?: Partial<Record<keyof ClerkSessionClaims, unknown>>, header?: Record<string, unknown>): string;
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

export function createTestSigner(defaults: Partial<ClerkSessionClaims> = {}): TestSigner {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwtKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  return {
    jwtKey,
    token(claims = {}, header = {}) {
      const now = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = {
        iss: CLERK_ISSUER,
        sub: 'user_test',
        sid: 'sess_test',
        azp: 'https://site.dkz12345.com',
        iat: now,
        nbf: now - 5,
        exp: now + 60,
        v: 2,
        fva: [0, -1],
        email: 'test@example.com',
        username: null,
        name: null,
        image: null,
        ...defaults,
        ...claims,
      };
      for (const key of Object.keys(payload)) if (payload[key] === null && key in claims) delete payload[key];
      const head = { alg: 'RS256', typ: 'JWT', kid: 'ins_test', ...header };
      const signingInput = `${base64url(JSON.stringify(head))}.${base64url(JSON.stringify(payload))}`;
      const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
      return `${signingInput}.${base64url(signature)}`;
    },
  };
}
