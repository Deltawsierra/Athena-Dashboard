// A person's browser in a process of its own, so a dashboard whose event loop
// is held cannot hold it too: it sends what it is told, and times by its own
// clock (Date.now()) when it sent it and when the whole answer had come.
//
// One JSON command a line on stdin: {id, method, url, cookie}. One JSON line
// on stdout for each answer: {id, sentAt, answeredAt, status, body}; or
// {id, sentAt, error} when none came. {ready: true} once it listens.
const http = require("http");

function press({ id, method, url, cookie }) {
  const target = new URL(url);
  const sentAt = Date.now();
  const req = http.request({
    hostname: target.hostname, port: target.port, path: target.pathname + target.search, method,
    headers: { cookie, "content-length": "0" }, agent: false,
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
  req.end();
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim()) press(JSON.parse(line));
  }
});
process.stdout.write(JSON.stringify({ ready: true }) + "\n");
