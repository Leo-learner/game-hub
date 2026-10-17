// Shared browser helper for the dkz12345.com sites (vendored; edit the copy in
// ~/Desktop/01-项目/clerk-gate/browser and re-sync).
//
// Loads clerk-js from our Frontend API at a pinned version, keeps this site's
// __session cookie fresh, and sends signed-out visitors to the account portal.
// It never mounts Clerk UI, so pages only need these CSP additions:
//   script-src https://clerk.dkz12345.com; connect-src https://clerk.dkz12345.com
const FRONTEND_API = 'https://clerk.dkz12345.com';
const CLERK_JS_VERSION = '6.37.0';
const PUBLISHABLE_KEY = 'pk_live_Y2xlcmsuZGt6MTIzNDUuY29tJA';
const RELOAD_GUARD = 'clerk-boot:reloaded';

export const ACCOUNTS_URL = 'https://accounts.dkz12345.com';
export const HOME_URL = 'https://dkz12345.com/';

let clerkPromise;

/**
 * Resolves with the loaded Clerk instance (window.Clerk). Rejects after
 * `timeoutMs` so a stalled network never blocks a page from booting as a guest;
 * the load itself keeps going and later calls can still pick it up.
 */
export function loadClerk(timeoutMs = 10000) {
  const loading = startLoading();
  if (!timeoutMs) return loading;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('clerk-js timed out')), timeoutMs); });
  return Promise.race([loading, timeout]).finally(() => clearTimeout(timer));
}

function startLoading() {
  if (!clerkPromise) {
    clerkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${FRONTEND_API}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.dataset.clerkPublishableKey = PUBLISHABLE_KEY;
      script.onload = () => (window.Clerk ? resolve(window.Clerk) : reject(new Error('clerk-js loaded without window.Clerk')));
      script.onerror = () => reject(new Error('clerk-js failed to load'));
      document.head.appendChild(script);
    }).then(async (clerk) => {
      await clerk.load();
      return clerk;
    });
    clerkPromise.catch(() => {
      clerkPromise = undefined; // allow a retry after a network error
    });
  }
  return clerkPromise;
}

/** The signed-in Clerk user, or null. */
export async function currentUser() {
  const clerk = await loadClerk();
  return clerk.user ?? null;
}

/** Sends signed-out visitors to the account portal; resolves only when signed in. */
export async function requireSignIn(returnTo = location.href) {
  const clerk = await loadClerk();
  if (clerk.user) return clerk;
  await clerk.redirectToSignIn({ signInForceRedirectUrl: returnTo, signUpForceRedirectUrl: returnTo });
  return new Promise(() => {}); // the page is navigating away
}

/** A fresh session token for `Authorization: Bearer`, or null when signed out. */
export async function getToken() {
  const clerk = await loadClerk();
  return clerk.session ? clerk.session.getToken() : null;
}

/** Signs out of every dkz12345.com site at once. */
export async function signOut(redirectUrl = HOME_URL) {
  const clerk = await loadClerk();
  await clerk.signOut({ redirectUrl });
}

export function accountPageUrl() {
  return `${ACCOUNTS_URL}/user`;
}

/**
 * For server-rendered pages that answered 401 because the short-lived
 * __session cookie had expired: refresh it once and reload, or go sign in.
 * A sessionStorage guard stops a reload loop if the server still says no.
 */
export async function refreshAndReload(returnTo = location.href) {
  const clerk = await loadClerk();
  if (!clerk.session) return requireSignIn(returnTo);
  let guard = null;
  try { guard = sessionStorage.getItem(RELOAD_GUARD); } catch { /* storage blocked */ }
  if (guard === returnTo) {
    try { sessionStorage.removeItem(RELOAD_GUARD); } catch { /* storage blocked */ }
    return requireSignIn(returnTo);
  }
  await clerk.session.getToken({ skipCache: true });
  try { sessionStorage.setItem(RELOAD_GUARD, returnTo); } catch { /* storage blocked */ }
  location.replace(returnTo);
  return new Promise(() => {});
}

/** Call once a page has loaded successfully, so a later 401 may refresh again. */
export function clearReloadGuard() {
  try { sessionStorage.removeItem(RELOAD_GUARD); } catch { /* storage blocked */ }
}
