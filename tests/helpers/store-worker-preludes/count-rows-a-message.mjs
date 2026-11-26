// In the store's worker thread: how many rows each message to the event loop
// carries, said on the channel named in workerData.countRows ({rows}), for
// every message that carries any.
import { parentPort, workerData, BroadcastChannel } from "worker_threads";

const channel = new BroadcastChannel(workerData.countRows);
channel.unref();
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message, ...rest) => {
  const rows = Array.isArray(message?.rows) ? message.rows.length
    : Array.isArray(message?.result) ? message.result.length
      : Array.isArray(message?.result?.rows) ? message.result.rows.length : 0;
  if (rows > 0) channel.postMessage({ rows });
  return post(message, ...rest);
};
