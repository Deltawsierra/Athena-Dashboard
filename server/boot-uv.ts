/**
 * SAFETY defense-in-depth: raise libuv's threadpool above its default of 4.
 *
 * Password verification runs `crypto.scrypt` on the threadpool, and so does
 * the `getaddrinfo` a cold outbound connection does for a hostname. A flood of
 * concurrent failed sign-ins can fill four workers with scrypt jobs and starve
 * that getaddrinfo -- delaying a Stop. The real guarantee against this is the
 * pinned DNS cache (server/dns-cache.ts), which keeps a Stop off the
 * threadpool entirely; this larger pool is a further backstop, for a
 * distributed flood that the per-address sign-in cap does not bound.
 *
 * UV_THREADPOOL_SIZE is read once, when the pool is first initialised, so this
 * must run before any threadpool use -- it is imported first at each process
 * entry (server/index.ts, server/index-electron.ts; electron-main.cjs sets it
 * itself, before Electron starts). An operator's own value is left untouched.
 */
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = "16";
}

export {};
