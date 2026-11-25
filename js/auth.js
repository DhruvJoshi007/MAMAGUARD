// One-time device login. The first launch sets up a health-worker profile (display name + PIN); after that the
// device stays signed in until the worker taps "Sign out". Everything is local to this browser: there is no server
// account, so this keeps casual users out of the records but is not a substitute for device-level security.
const KEY = 'mamaguard.auth';
const ITER = 120000;
let mem = null, fails = 0, lockUntil = 0;
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return mem; } };
const write = v => { mem = v; try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* blocked storage: session only */ } };
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

async function hash(pin, saltHex) {
  const enc = new TextEncoder();
  if (crypto?.subtle) {
    const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(saltHex), iterations: ITER }, key, 256);
    return 'p' + hex(bits);
  }
  let h = 2166136261;                                  // non-secure fallback for plain-http pages (no WebCrypto)
  for (const c of saltHex + pin) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return 'f' + h.toString(16);
}
export const profile = () => read();
export const isSetUp = () => !!read()?.hash;
export const isLoggedIn = () => !!read()?.loggedIn;
export const workerName = () => read()?.name || '';

export async function setup(name, pin) {
  if (!/^\d{4,6}$/.test(pin)) throw new Error('PIN must be 4 to 6 digits.');
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  write({ name: name.trim().slice(0, 40), salt, hash: await hash(pin, salt), loggedIn: true, since: new Date().toISOString() });
}
export async function signIn(pin) {
  if (Date.now() < lockUntil) throw new Error(`Too many attempts. Try again in ${Math.ceil((lockUntil - Date.now()) / 1000)} s.`);
  const p = read();
  if (p && (await hash(pin, p.salt)) === p.hash) { fails = 0; write({ ...p, loggedIn: true }); return; }
  if (++fails >= 5) { lockUntil = Date.now() + 30000; fails = 0; }
  throw new Error('Wrong PIN.');
}
export function signOut() { const p = read(); if (p) write({ ...p, loggedIn: false }); }
export function resetProfile() { mem = null; try { localStorage.removeItem(KEY); } catch {} }
