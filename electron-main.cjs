// SAFETY defense-in-depth (must precede any libuv threadpool use, so before
// Electron loads): raise UV_THREADPOOL_SIZE above its default of 4 so a
// sign-in flood's scrypt jobs cannot starve the getaddrinfo a Stop needs. The
// packaged app requires the server in-process, so this process runs scrypt.
// The real guarantee is the pinned DNS cache (server/dns-cache.ts).
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16';
}

const { app, BrowserWindow, Menu, shell, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// `app.isPackaged` is the only reliable signal: an installed app never sets
// NODE_ENV, so the old `NODE_ENV !== 'production'` check made every shipped
// build run in development mode.
const isDev = !app.isPackaged;

const SERVER_PORT = process.env.PORT || '5000';
const SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
// The renderer loads from the bundled server, so page and API share an
// origin. Serving the page from a custom app:// scheme made every API call
// cross-site: the session cookie could not travel, the Content-Security-Policy
// had to name a second host, and the scheme needed its own file handler.
const APP_ORIGIN = SERVER_ORIGIN;

let mainWindow;
let devServerProcess;

/**
 * Report a fatal startup problem and exit.
 *
 * showErrorBox blocks until the user dismisses it, so calling app.quit() after
 * it meant the quit never ran on an unattended machine: the process stayed
 * resident with no window and no way to tell what had happened. app.exit ends
 * it regardless.
 */
function fail(title, message) {
  console.error(`[electron] ${title}: ${message}`);
  try {
    dialog.showErrorBox(title, message);
  } catch {
    // No display, or too early for a dialog. The log line above still stands.
  }
  app.exit(1);
}

/**
 * Starts the API. In a packaged app the bundled CommonJS server is required
 * in-process; in development we spawn `npm run dev` for hot reload.
 */
async function startExpressServer() {
  if (!isDev) {
    // The database and the session secret live in the per-user data directory,
    // not next to the executable (which is read-only on most installs).
    const userData = app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });
    process.env.ATHENA_USER_DATA = userData;
    process.env.NODE_ENV = 'production';
    process.env.PORT = SERVER_PORT;
    process.env.HOST = '127.0.0.1';

    const serverPath = path.join(__dirname, 'dist', 'server-electron.cjs');
    if (!fs.existsSync(serverPath)) {
      const message =
        'The application server bundle is missing.\n\n' +
        'Build it with:\n  npm run build\n\n' +
        `Expected at:\n${serverPath}`;
      fail('Athena AI cannot start', message);
      throw new Error(message);
    }

    try {
      require(serverPath);
    } catch (err) {
      fail('Athena AI cannot start', `The server failed to start:\n${err.message}`);
      throw err;
    }
  } else {
    const { spawn } = require('child_process');
    devServerProcess = spawn('npm', ['run', 'dev'], {
      shell: true,
      env: { ...process.env, NODE_ENV: 'development' },
      stdio: 'inherit',
    });
  }

  await waitForServer();
}

/** Polls the health endpoint instead of guessing with a fixed delay. */
async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await net.fetch(`${SERVER_ORIGIN}/health`);
      if (res.ok) return;
    } catch (err) {
      // Not listening yet. Log the reason once so a poll that can never
      // succeed is distinguishable from one that is merely early: a missing
      // module here failed silently every time and looked like a dead server.
      if (!waitForServer.reported) {
        waitForServer.reported = true;
        console.log(`[electron] waiting for the server: ${err.message}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The application server did not respond at ${SERVER_ORIGIN} within ${timeoutMs}ms`);
}

function buildMenu() {
  const fileSubmenu = [
    { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
  ];
  if (isDev) {
    fileSubmenu.push({
      label: 'Toggle Developer Tools',
      accelerator: 'CmdOrCtrl+Shift+I',
      click: () => mainWindow && mainWindow.webContents.toggleDevTools(),
    });
  }
  fileSubmenu.push({ type: 'separator' }, { role: 'quit' });

  const template = [
    { label: 'File', submenu: fileSubmenu },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Athena AI',
          click: () =>
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Athena AI',
              message: 'Athena AI - Cybersecurity Intelligence Platform',
              detail: `Version ${app.getVersion()}`,
              buttons: ['OK'],
            }),
        },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({ role: 'appMenu' });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'electron-preload.cjs'),
      webSecurity: true,
      sandbox: true,
      allowRunningInsecureContent: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0a',
    show: false,
  });

  buildMenu();

  // Content Security Policy. `file:` is deliberately absent: everything the
  // renderer needs is served over app:// or from the local API.
  const pageOrigin = `'self' ${SERVER_ORIGIN}`;
  const cspPolicy = [
    `default-src ${pageOrigin}`,
    `script-src ${pageOrigin}`,
    `style-src ${pageOrigin} 'unsafe-inline'`,
    `font-src ${pageOrigin} data:`,
    `img-src ${pageOrigin} data: blob:`,
    // Host-source matching is textual, so this has to name exactly what the
    // client fetches. It listed only 127.0.0.1 while the client called
    // localhost, which would have blocked every API call in the packaged app.
    `connect-src 'self' ${SERVER_ORIGIN} http://localhost:${SERVER_PORT} ws://127.0.0.1:${SERVER_PORT} ws://localhost:${SERVER_PORT}`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `frame-ancestors 'none'`,
  ].join('; ');

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [cspPolicy] },
    });
  });

  // Open external links in the real browser, never in an app window.
  // (`new-window` was removed in Electron 22; this is its replacement.)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Block in-page navigation away from the app's own origins.
  // Block in-page navigation away from the app's own origins. Comparing string
  // prefixes let "http://127.0.0.1:5000@evil.com/" through, because the part
  // that looks like the allowed origin is userinfo, not the host.
  const allowedOrigins = [SERVER_ORIGIN, `http://localhost:${SERVER_PORT}`];

  const blockForeignNavigation = (event, url) => {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      event.preventDefault();
      return;
    }
    if (!allowedOrigins.includes(origin)) {
      event.preventDefault();
    }
  };

  mainWindow.webContents.on('will-navigate', blockForeignNavigation);
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    blockForeignNavigation(event, event.url);
  });
  mainWindow.webContents.on('will-redirect', blockForeignNavigation);

  // Load the root, not /index.html: the client router matches on the pathname,
  // and "/index.html" matched no route, which is why the packaged app opened
  // on the 404 screen.
  mainWindow.loadURL(`${SERVER_ORIGIN}/`);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Serves the built client over app://, confined to dist/public, with an
 * index.html fallback so client-side routes resolve.
 */
app.whenReady().then(async () => {
  try {
    await startExpressServer();
  } catch (err) {
    fail('Athena AI cannot start', `The application server did not come up:\n${err.message}`);
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', () => {
  if (devServerProcess) {
    devServerProcess.kill();
  }
});
