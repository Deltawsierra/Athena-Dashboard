// The next derivation of one password, held in the store's worker thread (the
// sign-in's rehash runs there: SqliteStorage.validateUser) until the test lets
// it go. Armed by the shared cell; says so on the channel as it starts to wait
// ({entered}), and goes on once told ({release}). Run before the server's
// modules load, so the password module's scrypt is this one.
import { workerData, BroadcastChannel } from "worker_threads";
import crypto from "crypto";

const { channel: name, password, armed: shared } = workerData.rehash;
const armed = new Int32Array(shared);
const channel = new BroadcastChannel(name);
channel.unref();

const scrypt = crypto.scrypt;
crypto.scrypt = function (secret, ...rest) {
  if (String(secret) === password && Atomics.compareExchange(armed, 0, 1, 0) === 1) {
    const go = (event) => {
      if (!event.data?.release) return;
      channel.removeEventListener("message", go);
      scrypt.call(crypto, secret, ...rest);
    };
    channel.addEventListener("message", go);
    channel.postMessage({ entered: true });
    return undefined;
  }
  return scrypt.call(this, secret, ...rest);
};
