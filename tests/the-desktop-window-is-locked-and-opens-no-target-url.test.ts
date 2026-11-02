/**
 * The desktop window's lock, pinned (D-RF N5): what electron-main.cjs gives the
 * renderer that shows target-derived text, read from the file the packaged app
 * runs, with the `electron` module stood in.
 *
 *   - The window: no Node in the renderer, an isolated context, the sandbox, web
 *     security, no insecure content.
 *   - The Content-Security-Policy set on every response: object-src, base-uri and
 *     frame-ancestors 'none'; nothing loads from file:; no script but the app's own.
 *   - The window-open handler denies every URL and hands none to the system
 *     browser. It used to pass any http(s) URL to shell.openExternal, so a link
 *     the target planted in a finding opened outside the app on one click; a
 *     target URL is now text with a copy button (client/src/components/TargetUrl.tsx).
 *   - Navigation stays on the app's own origins, compared as origins: the
 *     "http://127.0.0.1:5000@<host>/" a prefix comparison let through is refused.
 *   - Permissions are denied, every one, asked or checked, before the page
 *     loads: Electron grants a request no handler answers. The one allowed is
 *     the clipboard write the app's copy buttons use (a target URL's, a
 *     receipt's, the failsafe's bytes to sign), and only to the app's own origins.
 *
 * The file is run as the packaged app runs it (app.isPackaged true): no dev
 * server is spawned, and the server bundle it requires is stood in for.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(__dirname, "..");
const MAIN = path.join(ROOT, "electron-main.cjs");
const ORIGIN = "http://127.0.0.1:5000";
const OUTSIDE = "outside-host.example";

type Handler = (...args: unknown[]) => unknown;

/** electron-main.cjs, run to its window with `electron` stood in; what it set up, and the shell's spies. */
async function openTheWindow() {
  const shell = { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() };
  const opened: {
    options?: Record<string, unknown>; windowOpen?: Handler; headers?: Handler; loaded?: string;
    permissionRequest?: Handler; permissionCheck?: Handler; order: string[];
  } = { order: [] };
  const events = new Map<string, Handler>();
  class BrowserWindow {
    webContents = {
      session: {
        webRequest: { onHeadersReceived: (handler: Handler) => { opened.headers = handler; } },
        setPermissionRequestHandler: (handler: Handler) => { opened.permissionRequest = handler; opened.order.push("permission-request"); },
        setPermissionCheckHandler: (handler: Handler) => { opened.permissionCheck = handler; opened.order.push("permission-check"); },
      },
      setWindowOpenHandler: (handler: Handler) => { opened.windowOpen = handler; },
      on: (event: string, handler: Handler) => { events.set(event, handler); },
      openDevTools: () => {}, toggleDevTools: () => {},
    };
    constructor(options: Record<string, unknown>) { opened.options = options; }
    loadURL(url: string) { opened.loaded = url; opened.order.push("load"); }
    once() {}
    on() {}
    show() {}
    reload() {}
  }
  let ready: (() => Promise<void>) | undefined;
  const electron = {
    app: {
      isPackaged: true,
      getPath: () => path.join(ROOT, "no-such-user-data"), getVersion: () => "0.0.0",
      whenReady: () => ({ then: (callback: () => Promise<void>) => { ready = callback; } }),
      on: () => {}, quit: () => {}, exit: vi.fn(),
    },
    BrowserWindow,
    Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} },
    shell,
    net: { fetch: async () => ({ ok: true }) },
    dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
  };
  const standIns: Record<string, unknown> = {
    electron,
    path,
    // Nothing is written: the packaged path makes its user-data directory and checks for the server bundle.
    fs: { mkdirSync: () => undefined, existsSync: () => true },
  };
  const fakeRequire = (id: string) => {
    if (id in standIns) return standIns[id];
    if (id.endsWith("server-electron.cjs")) return {};
    throw new Error(`electron-main.cjs required ${id}, which this test does not stand in for`);
  };
  const fakeProcess = { env: {} as Record<string, string>, platform: "win32" };
  const source = fs.readFileSync(MAIN, "utf8");
  const run = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname, process) {${source}\n})`, { filename: MAIN });
  const module = { exports: {} };
  run(module.exports, fakeRequire, module, MAIN, ROOT, fakeProcess);
  expect(ready, "the app waits for Electron to be ready").toBeTypeOf("function");
  await ready!();
  expect(electron.app.exit, "the app started").not.toHaveBeenCalled();
  return { opened, events, shell };
}

/** The CSP the window sets on a response, as directive -> sources. */
async function cspOf() {
  const { opened } = await openTheWindow();
  let answered: { responseHeaders: Record<string, string[]> } | undefined;
  opened.headers!({ responseHeaders: { "X-Served": ["yes"] } }, (answer: typeof answered) => { answered = answer; });
  expect(answered!.responseHeaders["X-Served"], "the served headers are kept").toEqual(["yes"]);
  const policy = answered!.responseHeaders["Content-Security-Policy"];
  expect(policy).toHaveLength(1);
  return {
    policy: policy[0],
    directives: new Map(policy[0].split(";").map((one) => one.trim().split(/\s+/)).filter((one) => one[0]).map(([name, ...sources]) => [name, sources])),
  };
}

describe("the desktop window", () => {
  it("runs the renderer with no Node, an isolated context, the sandbox and web security", async () => {
    const { opened } = await openTheWindow();
    const preferences = opened.options!.webPreferences as Record<string, unknown>;
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.sandbox).toBe(true);
    expect(preferences.webSecurity).toBe(true);
    expect(preferences.allowRunningInsecureContent).toBe(false);
    // Nothing turns any of it back on by another name.
    for (const key of ["nodeIntegrationInWorker", "nodeIntegrationInSubFrames", "webviewTag", "experimentalFeatures", "enableBlinkFeatures"]) {
      expect(preferences[key], key).toBeUndefined();
    }
    expect(preferences.preload).toBe(path.join(ROOT, "electron-preload.cjs"));
    expect(opened.loaded).toBe(`${ORIGIN}/`);
  });
});

describe("the Content-Security-Policy on every response", () => {
  it("loads no object, sets no base, and lets no page frame the app", async () => {
    const { directives } = await cspOf();
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("loads nothing from file:, and runs no script but the app's own", async () => {
    const { policy, directives } = await cspOf();
    expect(policy).not.toMatch(/file:/i);
    expect(directives.get("default-src")).toEqual(["'self'", ORIGIN]);
    expect(directives.get("script-src")).toEqual(["'self'", ORIGIN]);
    for (const [name, sources] of directives) {
      expect(sources, `${name} allows any host`).not.toContain("*");
    }
  });
});

describe("the window-open handler", () => {
  const URLS = [
    `http://${OUTSIDE}/collect?from=finding`,
    `https://${OUTSIDE}/`,
    `HTTPS://${OUTSIDE.toUpperCase()}/`,
    `javascript:fetch('http://${OUTSIDE}/x')`,
    "file:///C:/Windows/System32/calc.exe",
    "data:text/html,<script>alert(1)</script>",
    "mailto:someone@outside-host.example",
    `${ORIGIN}@${OUTSIDE}/`,
    `${ORIGIN}/api/scans/t1/backend-pdf`,
    `http://localhost:5000/findings`,
    "",
  ];

  it.each(URLS)("denies %j and hands it to nothing outside the app", async (url) => {
    const { opened, shell } = await openTheWindow();
    for (const disposition of ["foreground-tab", "background-tab", "new-window", "other"]) {
      expect(opened.windowOpen!({ url, disposition, frameName: "", features: "", referrer: { url: ORIGIN, policy: "default" } })).toEqual({ action: "deny" });
    }
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });
});

describe("in-page navigation", () => {
  const ALLOWED = [`${ORIGIN}/`, `${ORIGIN}/athena?test=t1`, `${ORIGIN}/findings#top`, "http://localhost:5000/assurance"];
  const REFUSED = [
    // The case the file's own comment names: the allowed origin is userinfo here, the host is the outside one.
    `${ORIGIN}@${OUTSIDE}/`,
    `${ORIGIN}0/`,
    `${ORIGIN}.${OUTSIDE}/`,
    "https://127.0.0.1:5000/",
    `http://${OUTSIDE}/`,
    "http://localhost:5001/",
    `javascript:fetch('http://${OUTSIDE}/x')`,
    "file:///C:/Windows/System32/drivers/etc/hosts",
    "data:text/html,<p>hi</p>",
    "not a url",
  ];

  /** Whether each guard let `url` through, and that none of them sent it out of the app. */
  async function guarded(url: string) {
    const { events, shell } = await openTheWindow();
    const outcome: Record<string, boolean> = {};
    for (const name of ["will-navigate", "will-redirect"]) {
      const event = { preventDefault: vi.fn() };
      events.get(name)!(event, url);
      outcome[name] = event.preventDefault.mock.calls.length === 0;
    }
    const frame = { url, preventDefault: vi.fn() };
    events.get("will-frame-navigate")!(frame);
    outcome["will-frame-navigate"] = frame.preventDefault.mock.calls.length === 0;
    expect(shell.openExternal).not.toHaveBeenCalled();
    return outcome;
  }

  it.each(ALLOWED)("goes on to %j, the app's own origin", async (url) => {
    expect(await guarded(url)).toEqual({ "will-navigate": true, "will-redirect": true, "will-frame-navigate": true });
  });

  it.each(REFUSED)("is refused for %j", async (url) => {
    expect(await guarded(url)).toEqual({ "will-navigate": false, "will-redirect": false, "will-frame-navigate": false });
  });
});

describe("permissions", () => {
  /** Every permission Electron names for the request and check handlers, and one it does not. */
  const DENIED = [
    "clipboard-read", "media", "display-capture", "geolocation", "notifications", "midi", "midiSysex", "pointerLock",
    "keyboardLock", "fullscreen", "openExternal", "mediaKeySystem", "idle-detection", "window-management",
    "speaker-selection", "storage-access", "top-level-storage-access", "fileSystem", "hid", "serial", "usb",
    "background-sync", "persistent-storage", "unknown", "a-permission-not-yet-named",
  ];
  const APP = [ORIGIN, "http://localhost:5000"];
  const ELSEWHERE = [`http://${OUTSIDE}`, `${ORIGIN}@${OUTSIDE}`, "https://127.0.0.1:5000", "file://", "null", "", "not a url"];

  /** The request handler's answer to `permission` asked from `url`. */
  function asked(handler: Handler, permission: string, url: string): unknown[] {
    const answers: unknown[] = [];
    handler({}, permission, (granted: unknown) => answers.push(granted), { requestingUrl: url, isMainFrame: true });
    return answers;
  }

  it("are answered by the window's own handlers, set before the page loads", async () => {
    const { opened } = await openTheWindow();
    expect(opened.permissionRequest).toBeTypeOf("function");
    expect(opened.permissionCheck).toBeTypeOf("function");
    expect(opened.order.indexOf("permission-request")).toBeLessThan(opened.order.indexOf("load"));
    expect(opened.order.indexOf("permission-check")).toBeLessThan(opened.order.indexOf("load"));
  });

  it.each(DENIED)("denies %j, asked or checked, even from the app's own origin", async (permission) => {
    const { opened } = await openTheWindow();
    for (const origin of [...APP, ...ELSEWHERE]) {
      expect(asked(opened.permissionRequest!, permission, `${origin}/athena`), `${permission} asked from ${origin}`).toEqual([false]);
      expect(opened.permissionCheck!({}, permission, origin, {}), `${permission} checked from ${origin}`).toBe(false);
    }
  });

  it("allows the clipboard write the copy buttons use to the app's own origins, and to nothing else", async () => {
    const { opened } = await openTheWindow();
    for (const origin of APP) {
      expect(asked(opened.permissionRequest!, "clipboard-sanitized-write", `${origin}/findings`), origin).toEqual([true]);
      expect(opened.permissionCheck!({}, "clipboard-sanitized-write", origin, {}), origin).toBe(true);
    }
    for (const origin of ELSEWHERE) {
      expect(asked(opened.permissionRequest!, "clipboard-sanitized-write", `${origin}/x`), origin).toEqual([false]);
      expect(opened.permissionCheck!({}, "clipboard-sanitized-write", origin, {}), origin).toBe(false);
    }
    // A request with no details names no origin, so it is the app's to nobody.
    const answers: unknown[] = [];
    opened.permissionRequest!({}, "clipboard-sanitized-write", (granted: unknown) => answers.push(granted));
    expect(answers).toEqual([false]);
  });
});
