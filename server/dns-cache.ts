/**
 * A small address cache in front of getaddrinfo, for the two stop-path HTTP
 * clients (server/engine.ts and server/failsafe.ts).
 *
 * SAFETY: no flood may EVER delay a stop. `crypto.scrypt` (password
 * verification, on every sign-in) runs on libuv's threadpool, and so does
 * `getaddrinfo` -- the DNS resolution a cold outbound connection does when the
 * target is a HOSTNAME. A flood of concurrent failed sign-ins fills the four
 * threadpool workers, so a Stop's getaddrinfo queued behind them and the Stop
 * was delayed proportionally to the flood (localhost engine, cold socket:
 * 20-flood ~0.4-0.6 s, 48-flood ~1.3 s here; a distributed flood, unbounded by
 * the per-address sign-in cap, scaled to seconds). An IP-literal target never
 * resolves, so it was never affected.
 *
 * The fix: resolve each host ONCE, off the stop path (warm-up at start-up and
 * a background refresh), and serve the stop path's `lookup` from this cache --
 * so a Stop never runs a live threadpool getaddrinfo. A cached (even stale)
 * address is returned at once and never blocks; a stale entry only kicks a
 * background refresh. This does NOT weaken address validation or TLS: the
 * cache holds exactly the address getaddrinfo returned, the hostname is
 * unchanged on the request (so TLS SNI and certificate validation still use
 * it), and an IP literal is passed straight through with no resolution.
 */

import dns from "node:dns";
import net, { type LookupFunction } from "node:net";

/** How long a cached address is fresh; past it, it is still served at once while a background refresh runs. */
export const TTL_MS = 30_000;

type Family = 0 | 4 | 6;

interface Entry {
  address: string;
  family: 4 | 6;
  storedAt: number;
}

const cache = new Map<string, Entry>();
/** Hosts a refresh/prime is already in flight for, so a burst does not fan out into many getaddrinfo calls. */
const inFlight = new Set<string>();

const realLookup = dns.lookup;

function keyOf(hostname: string, family: Family): string {
  return `${hostname}|${family}`;
}

function familyOf(options: dns.LookupOptions): Family {
  const f = options.family;
  return (f === 4 || f === 6 ? f : 0);
}

/**
 * Resolve a hostname once and cache it, OFF the stop path (start-up warm-up,
 * or a background refresh). Never rejects: a resolution that fails leaves any
 * address already in hand untouched, and the next call tries again. An IP
 * literal is a no-op (nothing to resolve).
 */
export function prime(hostname: string, family: Family = 0): Promise<void> {
  if (net.isIP(hostname) !== 0) return Promise.resolve();
  const k = keyOf(hostname, family);
  if (inFlight.has(k)) return Promise.resolve();
  inFlight.add(k);
  return new Promise<void>((resolve) => {
    realLookup(hostname, { family, verbatim: true }, (err, address, fam) => {
      inFlight.delete(k);
      if (!err && typeof address === "string" && (fam === 4 || fam === 6)) {
        cache.set(k, { address, family: fam, storedAt: Date.now() });
      }
      resolve();
    });
  });
}

/**
 * A `lookup` for net/http/https, served from the cache so a Stop's connection
 * never runs a live threadpool getaddrinfo for a host that has already been
 * resolved. It honours the `all` and `family` options net passes.
 *
 *   - An IP literal is returned as-is (no resolution, no threadpool) -- the
 *     fast path an IP-configured engine already had.
 *   - A cached address (fresh or stale) is returned at once; a stale one also
 *     kicks a background refresh, but the stop is never made to wait on it.
 *   - A host never yet primed (a cold start-up race) falls back to a real
 *     lookup this once and primes the cache for next time. Warm-up makes this
 *     rare; UV_THREADPOOL_SIZE is raised at the process entry as a further
 *     backstop for it.
 */
export const lookup: LookupFunction = (hostname, options, callback): void => {
  const family = familyOf(options);
  const all = options.all === true;

  const ipVersion = net.isIP(hostname);
  if (ipVersion !== 0) {
    const rec = { address: hostname, family: ipVersion as 4 | 6 };
    process.nextTick(() => (all ? callback(null, [rec]) : callback(null, rec.address, rec.family)));
    return;
  }

  const entry = cache.get(keyOf(hostname, family));
  if (entry) {
    if (Date.now() - entry.storedAt >= TTL_MS) void prime(hostname, family);
    process.nextTick(() => (all
      ? callback(null, [{ address: entry.address, family: entry.family }])
      : callback(null, entry.address, entry.family)));
    return;
  }

  // Cold, never primed: resolve this once with the real resolver (so any
  // option shape is answered correctly) and prime the cache for next time.
  void prime(hostname, family);
  realLookup(
    hostname,
    options,
    callback as (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family: number) => void,
  );
};

/** Test seam: forget every cached address. */
export function _resetForTests(): void {
  cache.clear();
  inFlight.clear();
}
