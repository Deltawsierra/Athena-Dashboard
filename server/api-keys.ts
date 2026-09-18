import crypto from "crypto";

/**
 * API-key secrets and how they are stored.
 *
 * A key is a high-entropy random string shown to its creator exactly once. What
 * the database holds is only a SHA-256 hash of it, so a leaked database yields
 * no working key and there is nothing sensitive to log. A short, non-secret
 * `prefix` (the head of the key) is kept alongside the hash so a list can tell
 * two keys apart without holding either secret.
 *
 * SHA-256 (not a slow password hash) is the right primitive here: the secret is
 * 256 bits of uniform randomness, so it is not brute-forceable and needs no
 * per-entry salt or work factor. The lookup is by exact hash equality, which is
 * a constant-time comparison of already-hashed values — the plaintext is never
 * compared directly.
 */

/** The visible marker every key carries, so a leaked key is recognisable. */
export const API_KEY_PREFIX = "athena_";

/** How many leading characters of a key are kept, non-secret, for display. */
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 6;

/** Mint a fresh secret: the marker plus 32 bytes of url-safe randomness. */
export function generateApiKey(): string {
  return API_KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
}

/** The SHA-256 hash (hex) that is stored and looked up. Never store the secret. */
export function hashApiKey(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

/** The non-secret head of a key, kept so a list can identify it. */
export function apiKeyPrefix(secret: string): string {
  return secret.slice(0, DISPLAY_PREFIX_LENGTH);
}
