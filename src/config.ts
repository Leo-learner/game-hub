import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/** Shared Clerk login (clerk.dkz12345.com). Only public values: no secret key. */
export interface ClerkConfig { publishableKey: string; jwtKey: string; ownerUserId: string | null }
export interface Config {
  host: string; port: number; publicOrigin: string; allowedOrigins: string[];
  dataDir: string; publicDir: string; sdkDir: string; cookieSecure: boolean; cookieName: string;
  trustProxy: boolean; sessionTtlMs: number; saveMaxBytes: number; saveMaxSlots: number;
  uploadMaxBytes: number; extractMaxBytes: number; uploadMaxFiles: number;
  allowRegistration: boolean; apiDocs: boolean; spaFallback: boolean; xAccelRedirect: boolean;
  logger: boolean; logLevel: string; now: () => number;
  clerk: ClerkConfig | null;
}
function clerkFromEnv(env: NodeJS.ProcessEnv): ClerkConfig | null {
  const publishableKey = env.CLERK_PUBLISHABLE_KEY;
  const jwtKey = env.CLERK_JWT_KEY_FILE ? readFileSync(env.CLERK_JWT_KEY_FILE, 'utf8') : env.CLERK_JWT_KEY?.replace(/\\n/g, '\n');
  if (!publishableKey && !jwtKey) return null;
  if (!publishableKey || !jwtKey) throw new Error('CLERK_PUBLISHABLE_KEY and CLERK_JWT_KEY(_FILE) must be set together');
  const ownerUserId = env.OWNER_CLERK_USER_ID || null;
  if (ownerUserId && !ownerUserId.startsWith('user_')) throw new Error('Invalid OWNER_CLERK_USER_ID');
  return { publishableKey, jwtKey, ownerUserId };
}
export function loadEnv(): void {
  const file = path.resolve('.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
export function createConfig(overrides: Partial<Config> = {}, env = process.env): Config {
  const num = (key: string, fallback: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid positive integer: ' + key);
    return value;
  };
  const bool = (key: string, fallback: boolean) => {
    if (env[key] === undefined) return fallback;
    if (!['true', 'false'].includes(env[key]!)) throw new Error('Invalid boolean: ' + key);
    return env[key] === 'true';
  };
  const publicOrigin = env.PUBLIC_ORIGIN ?? 'http://localhost:3220';
  const cookieSecure = bool('COOKIE_SECURE', false);
  const config: Config = {
    host: env.HOST ?? '127.0.0.1', port: num('PORT', 3220), publicOrigin,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean),
    dataDir: path.resolve(env.DATA_DIR ?? 'data'), publicDir: path.resolve(env.PUBLIC_DIR ?? 'public'),
    sdkDir: path.resolve('public/sdk'), cookieSecure, cookieName: cookieSecure ? '__Host-gamehub_sid' : 'gamehub_sid',
    trustProxy: bool('TRUST_PROXY', false), sessionTtlMs: num('SESSION_TTL_DAYS', 30) * 86400000,
    saveMaxBytes: num('SAVE_MAX_BYTES', 1048576), saveMaxSlots: num('SAVE_MAX_SLOTS', 10),
    uploadMaxBytes: num('UPLOAD_MAX_BYTES', 52428800), extractMaxBytes: num('EXTRACT_MAX_BYTES', 209715200),
    uploadMaxFiles: num('UPLOAD_MAX_FILES', 10000), allowRegistration: bool('ALLOW_REGISTRATION', true),
    apiDocs: bool('API_DOCS', true), spaFallback: bool('SPA_FALLBACK', false), xAccelRedirect: bool('X_ACCEL_REDIRECT', false),
    logger: true, logLevel: env.LOG_LEVEL ?? 'info', now: Date.now, clerk: clerkFromEnv(env), ...overrides,
  };
  config.publicOrigin = new URL(config.publicOrigin).origin;
  config.allowedOrigins = [...new Set([config.publicOrigin, ...config.allowedOrigins.map(x => new URL(x).origin)])];
  config.cookieName = config.cookieSecure ? '__Host-gamehub_sid' : 'gamehub_sid';
  if (process.env.NODE_ENV === 'production' && (!config.cookieSecure || !config.publicOrigin.startsWith('https://'))) {
    throw new Error('Production requires HTTPS and COOKIE_SECURE=true');
  }
  if (process.env.NODE_ENV === 'production' && !config.clerk) throw new Error('Production requires CLERK_PUBLISHABLE_KEY and CLERK_JWT_KEY_FILE');
  return config;
}
