const { app, BrowserWindow, Menu, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

protocol.registerSchemesAsPrivileged([{
  scheme: 'worldforge',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2'
};

let pythonBackendProcess = null;

/**
 * Launch the Python reinforcement learning and REST backend server.
 */
function startPythonBackend() {
  const root = path.resolve(app.getAppPath());
  const serverScript = path.join(root, 'backend', 'server.py');
  try {
    pythonBackendProcess = spawn('python', [serverScript, '--port', '5050'], {
      cwd: root,
      stdio: 'pipe',
      windowsHide: true,
    });

    pythonBackendProcess.stdout?.on('data', (data) => {
      console.log(`[Python Backend] ${data.toString().trim()}`);
    });

    pythonBackendProcess.stderr?.on('data', (data) => {
      console.error(`[Python Backend Error] ${data.toString().trim()}`);
    });

    pythonBackendProcess.on('exit', (code) => {
      console.log(`Python Backend exited with code ${code}`);
      pythonBackendProcess = null;
    });
  } catch (err) {
    console.warn('Could not launch Python backend automatically:', err.message);
  }
}

/**
 * Terminate the Python backend process cleanly.
 */
function stopPythonBackend() {
  if (pythonBackendProcess) {
    try {
      pythonBackendProcess.kill();
    } catch {
      // Process already terminated
    }
    pythonBackendProcess = null;
  }
}

function registerAppProtocol() {
  const root = path.resolve(app.getAppPath());
  protocol.handle('worldforge', async (request) => {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, '');

    // Proxy API requests to the Python backend to avoid CORS and Private Network Access limitations
    if (pathname.startsWith('api/')) {
      const targetUrl = `http://127.0.0.1:5050/${pathname}`;
      const method = request.method;
      let bodyData;
      if (method !== 'GET' && method !== 'HEAD') {
        bodyData = await request.text();
      }

      // Retry up to 4 times with short backoff in case Python backend is still booting
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const apiRes = await fetch(targetUrl, {
            method,
            headers: {
              'Content-Type': request.headers.get('Content-Type') || 'application/json',
            },
            body: bodyData,
          });

          const respBody = await apiRes.arrayBuffer();
          return new Response(respBody, {
            status: apiRes.status,
            headers: {
              'Content-Type': apiRes.headers.get('Content-Type') || 'application/json; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
            },
          });
        } catch (err) {
          if (attempt === 3) {
            return new Response(JSON.stringify({ error: `Backend unavailable: ${err.message}` }), {
              status: 502,
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
            });
          }
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    }

    const filePath = path.resolve(root, pathname);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const contents = await fs.readFile(filePath);
      return new Response(contents, {
        headers: { 'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream' }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 650,
    title: 'The-ReaL-Exit',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`The-ReaL-Exit failed to load (${code}): ${description} — ${url}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('The-ReaL-Exit renderer stopped:', details.reason, details.exitCode);
  });

  window.loadURL('worldforge://app/index.html');

  // Keep links from opening an unexpected window inside the game.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  return window;
}

function installMenu() {
  const template = [
    {
      label: 'The-ReaL-Exit',
      submenu: [
        { label: 'About The-ReaL-Exit', role: 'about' },
        { type: 'separator' },
        { label: 'Quit', role: 'quit' }
      ]
    },
    {
      label: 'Game',
      submenu: [
        { label: 'Restart Run', click: () => BrowserWindow.getFocusedWindow()?.webContents.executeJavaScript("document.getElementById('restartBtn').click()") },
        { label: 'Play Mode', click: () => BrowserWindow.getFocusedWindow()?.webContents.executeJavaScript("document.getElementById('playBtn').click()") },
        { label: 'Build Mode', click: () => BrowserWindow.getFocusedWindow()?.webContents.executeJavaScript("document.getElementById('editBtn').click()") }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  app.setName('The-ReaL-Exit');
  app.setAppUserModelId('com.worldforge.game');
  startPythonBackend();
  registerAppProtocol();
  installMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  stopPythonBackend();
});

app.on('window-all-closed', () => {
  stopPythonBackend();
  if (process.platform !== 'darwin') app.quit();
});
