import crypto from "crypto";
import { promisify } from "util";

/**
 * Password hashing for Athena.
 *
 * Current format:  scrypt$<hex salt>$<hex hash>
 * Legacy format:   64 hex chars (unsalted SHA-256) — accepted on login and
 *                  transparently re-hashed, so existing databases keep working.
 */

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const LEGACY_SHA256 = /^[0-9a-f]{64}$/i;
/** A stored hash must be exactly the salt and digest hashPassword produces. */
const STORED_SALT = new RegExp(`^[0-9a-f]{${SALT_BYTES * 2}}$`, "i");
const STORED_HASH = new RegExp(`^[0-9a-f]{${KEY_LENGTH * 2}}$`, "i");

/**
 * The same derivation as scryptSync (same cost parameters: N=16384, r=8, p=1,
 * the crypto module's defaults on either function), off the event loop.
 *
 * scryptSync ran on the loop: about 35 ms each, so 20 concurrent failed
 * sign-ins -- one bad password sent at once from twenty places, say -- queued
 * behind one another and held every other request, a scan's Stop included,
 * for the sum of their hashes: worst measured here, several hundred
 * milliseconds. libuv's threadpool runs this version off the loop, so the
 * loop answers a Stop the moment it arrives, whatever the sign-in flood is
 * doing. (Node's threadpool has four workers by default: with more than four
 * hashes in flight, later ones queue for a worker rather than the loop, which
 * costs those sign-ins latency, never the loop.)
 */
const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike, salt: crypto.BinaryLike, keylen: number,
) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
  const hash = (await scryptAsync(password, salt, KEY_LENGTH)).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export interface VerifyResult {
  ok: boolean;
  /** True when the stored hash uses the legacy scheme and should be replaced. */
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: unknown): Promise<VerifyResult> {
  // A BLOB in this column comes back as a Buffer, and calling startsWith on it
  // threw, so every sign-in for that account answered 500 and the account was
  // unrecoverable through the app. The JSON columns were hardened against the
  // same class of corruption; this one was not.
  if (typeof stored !== "string" || !stored) return { ok: false, needsRehash: false };

  if (stored.startsWith("scrypt$")) {
    const parts = stored.split("$");
    if (parts.length !== 3) return { ok: false, needsRehash: false };
    const [, salt, hex] = parts;

    // The stored value has to be a well-formed hash before it is compared.
    // Deriving the key length from it instead meant a truncated or corrupted
    // column authenticated anything: "scrypt$abcd$" decodes to zero bytes,
    // scrypt with a length of 0 returns zero bytes, and timingSafeEqual says
    // two empty buffers are equal. A partially mangled hex digest was worse
    // than useless in the same way, shortening the comparison to whatever
    // prefix still parsed.
    if (!STORED_SALT.test(salt) || !STORED_HASH.test(hex)) {
      return { ok: false, needsRehash: false };
    }

    const expected = Buffer.from(hex, "hex");
    const candidate = await scryptAsync(password, salt, KEY_LENGTH);
    const ok = candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
    return { ok, needsRehash: false };
  }

  if (LEGACY_SHA256.test(stored)) {
    const expected = Buffer.from(stored, "hex");
    const candidate = crypto.createHash("sha256").update(password).digest();
    const ok = crypto.timingSafeEqual(candidate, expected);
    return { ok, needsRehash: ok };
  }

  return { ok: false, needsRehash: false };
}

export function isHashedPassword(value: string): boolean {
  return value.startsWith("scrypt$") || LEGACY_SHA256.test(value);
}

/**
 * Spend the same work as a real verification when there is no user to verify.
 *
 * Returning early for an unknown username made login timing a clean username
 * oracle: a real account took ~35 ms of key derivation, a nonexistent one ~1.5 ms.
 */
export async function dummyVerify(password: string): Promise<void> {
  try {
    await scryptAsync(password, "0".repeat(SALT_BYTES * 2), KEY_LENGTH);
  } catch {
    // A pathological password length is not worth failing a login attempt over.
  }
}
