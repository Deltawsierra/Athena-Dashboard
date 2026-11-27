// A person's browser in a process of its own, so a dashboard whose event loop
// is held cannot hold it too: it sends what it is told, and times by its own
// clock (Date.now()) when it sent it and when the whole answer had come.
//
// One JSON command a line on stdin: {id, method, url, cookie, body?, extra?,
// afterMs?}, `body` sent as JSON when given (the kill switch's
// {killSwitchEnabled: true}), else nothing; `cookie` left out when null;
// `extra` more headers (an API key's); sent `afterMs` after the line came, by
// this process's own clock, when given. One JSON line on stdout for each
// answer: {id, sentAt, answeredAt, status, body}; or {id, sentAt, error} when
// none came. {ready: true} once it listens.
const http = require("http");

function press({ id, method, url, cookie, body: sent, extra }) {
  const target = new URL(url);
  const payload = sent === undefined ? "" : JSON.stringify(sent);
  const headers = { ...(cookie === null ? {} : { cookie }), ...(extra ?? {}), "content-length": String(Buffer.byteLength(payload)) };
  if (sent !== undefined) headers["content-type"] = "application/json";
  const sentAt = Date.now();
  const req = http.request({
    hostname: target.hostname, port: target.port, path: target.pathname + target.search, method,
    headers, agent: false,
  }, (res) => {
    let raw = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { raw += chunk; });
    res.on("end", () => {
      const answeredAt = Date.now();
      let body = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // Said as it came.
      }
      process.stdout.write(JSON.stringify({ id, sentAt, answeredAt, status: res.statusCode, body }) + "\n");
    });
  });
  req.on("error", (cause) => process.stdout.write(JSON.stringify({ id, sentAt, error: cause.message }) + "\n"));
  req.end(payload);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const one = JSON.parse(line);
    if (one.afterMs > 0) setTimeout(() => press(one), one.afterMs);
    else press(one);
  }
});
process.stdout.write(JSON.stringify({ ready: true }) + "\n");
