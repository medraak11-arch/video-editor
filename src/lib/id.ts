/* ---------------------------------------------------------------------------
   id.ts — PLAN §2.2. Never derive an id from an index or a path.
--------------------------------------------------------------------------- */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
const SIZE = 12;

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < n; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export function nanoid(size = SIZE): string {
  const bytes = randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i += 1) out += ALPHABET[bytes[i] & 63];
  return out;
}

export function newId(prefix: 'm' | 'c' | 't' | 'k'): string {
  return `${prefix}_${nanoid()}`;
}
