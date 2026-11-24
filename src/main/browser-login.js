'use strict';

// Sign-in through a real installed browser (Chrome, Edge or Brave).
//
// Google refuses sign-in inside embedded browsers such as Electron windows,
// but accepts it in a regular Chrome/Edge. So Vela starts the user's browser
// with a separate profile that belongs to Vela, lets the user sign in there,
// and reads that profile's cookies through the browser's own DevTools
// protocol. The browser decrypts its cookies itself, which also sidesteps
// Chrome's app-bound cookie encryption on Windows.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('./log');

function candidates() {
  if (process.env.VELA_LOGIN_BROWSER) return [{ name: 'Navegador', path: process.env.VELA_LOGIN_BROWSER }];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [
      { name: 'Google Chrome', path: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Google Chrome', path: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Google Chrome', path: path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Microsoft Edge', path: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Microsoft Edge', path: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Brave', path: path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
      { name: 'Brave', path: path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') }
    ];
  }
  if (process.platform === 'darwin') {
    return [
      { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { name: 'Brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' }
    ];
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']
    .flatMap(bin => ['/usr/bin/', '/usr/local/bin/', '/snap/bin/'].map(dir => ({ name: bin, path: dir + bin })));
}

function findBrowser() {
  return candidates().find(c => {
    try { return fs.statSync(c.path).isFile(); } catch { return false; }
  }) || null;
}

// ---------------------------------------------------------------------------
// Minimal DevTools protocol client over the browser's WebSocket endpoint

class Cdp {
  static connect(url, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('timeout')); }, timeout);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(new Cdp(ws)); });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('connect failed')); });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    this.onClose = null;
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('closed'));
      this.pending.clear();
      if (this.onClose) this.onClose();
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('closed'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// The browser writes its DevTools port and endpoint into the profile folder.
function readEndpoint(profileDir) {
  try {
    const [port, wsPath] = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
    if (!port || !wsPath) return null;
    return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
  } catch {
    return null;
  }
}

async function waitForEndpoint(profileDir, child, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const url = readEndpoint(profileDir);
    if (url) {
      try { return await Cdp.connect(url, 2000); } catch { /* not ready yet */ }
    }
    if (child && child.exitCode !== null && child.exitCode !== 0) break;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

// CDP cookie -> the shape auth.js writes to cookies.txt
const toCookie = c => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  hostOnly: !String(c.domain).startsWith('.'),
  path: c.path || '/',
  secure: !!c.secure,
  httpOnly: !!c.httpOnly,
  session: !!c.session || !(c.expires > 0),
  expirationDate: c.expires > 0 ? c.expires : undefined
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Is a browser currently running with this profile? Chrome holds a lock in
// the profile folder while it runs.
function profileInUse(profileDir) {
  if (process.platform === 'win32') {
    const lock = path.join(profileDir, 'lockfile');
    if (!fs.existsSync(lock)) return false;
    try {
      fs.closeSync(fs.openSync(lock, 'r+'));
      return false;
    } catch (err) {
      return err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES';
    }
  }
  // Elsewhere the lock is a symlink to "<host>-<pid>" that can outlive the
  // browser, so check that the process still exists.
  let target;
  try { target = fs.readlinkSync(path.join(profileDir, 'SingletonLock')); } catch { return false; }
  const pid = Number(String(target).split('-').pop());
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Runs a command and resolves when it ends; failures are ignored.
function runQuiet(cmd, args) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' }); } catch { resolve(); return; }
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
}

// Windows: run a PowerShell snippet over every process whose command line
// mentions Vela's login profile ($_ is a Win32_Process).
function forEachProfileProcess(profileDir, action) {
  const dir = profileDir.replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir}') } | ForEach-Object { ${action} }`;
  return runQuiet('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

// Ask every browser process using the profile to close normally, so the
// browser writes its cookies to disk.
async function askToClose(child, profileDir) {
  if (process.platform === 'win32') {
    if (child && child.exitCode === null) await runQuiet('taskkill', ['/pid', String(child.pid), '/T']);
    // Also reaches a browser that kept running after its window closed
    await forEachProfileProcess(profileDir, '$p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }');
  } else {
    if (child && child.exitCode === null) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } }
    await runQuiet('pkill', ['-TERM', '-f', '--', `--user-data-dir=${profileDir}`]);
  }
}

// Last resort when the browser ignores the request to close.
async function forceClose(child, profileDir) {
  if (process.platform === 'win32') {
    if (child && child.exitCode === null) await runQuiet('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    await forEachProfileProcess(profileDir, 'Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue');
  } else {
    if (child && child.exitCode === null) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }
    await runQuiet('pkill', ['-KILL', '-f', '--', `--user-data-dir=${profileDir}`]);
  }
}

async function waitUntilFree(profileDir, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!profileInUse(profileDir)) return true;
    await sleep(300);
  }
  return !profileInUse(profileDir);
}

// Close the login browser: politely first, by force after 10 seconds.
async function closeBrowser(child, profileDir) {
  await askToClose(child, profileDir);
  if (await waitUntilFree(profileDir, 10000)) return 'closed';
  log('login', 'O navegador não fechou em 10 s; encerrando à força');
  await forceClose(child, profileDir);
  return (await waitUntilFree(profileDir, 5000)) ? 'forced' : 'still-running';
}

// Starts the profile invisibly with a local DevTools port, reads every
// cookie, then shuts it down. No web page is loaded in this step.
async function readCookies(browser, profileDir) {
  // The profile must be free, or the headless browser would just hand over
  // to the running one
  if (profileInUse(profileDir) && !(await waitUntilFree(profileDir, 3000))) {
    log('login', 'O perfil ainda estava em uso antes da leitura; fechando o navegador');
    await closeBrowser(null, profileDir);
  }
  try { fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true }); } catch { /* ignore */ }
  const child = spawn(browser.path, [
    '--headless=new',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  const cdp = await waitForEndpoint(profileDir, child);
  if (!cdp) {
    try { child.kill(); } catch { /* ignore */ }
    throw new Error(`não foi possível abrir o ${browser.name} em segundo plano`);
  }
  try {
    return (await cdp.send('Storage.getCookies')).cookies.map(toCookie);
  } finally {
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
    for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(150);
    if (child.exitCode === null) { try { child.kill(); } catch { /* ignore */ } }
  }
}

// Sign-in in two steps, so Google never sees a browser under remote control:
//   1. open the login page in a completely normal browser window (Vela's own
//      profile, no DevTools port, no automation flags) and wait until the
//      user closes it, or calls finish();
//   2. read that profile's cookies with readCookies().
// Resolves { ok, connected, cookies } or { ok, canceled }.
function run({ browser, profileDir, url, isDone, onPhase = () => {} }) {
  let child = null;
  let canceled = false;
  let finishRequested = false;
  let wake = () => {};
  const userActed = new Promise(r => { wake = r; });

  const promise = (async () => {
    fs.mkdirSync(profileDir, { recursive: true });
    log('login', `Abrindo ${browser.name}: ${browser.path}`);

    // Close a login window left open by an earlier attempt
    if (profileInUse(profileDir)) {
      log('login', 'O perfil de login já estava em uso; fechando a janela anterior');
      const leftover = readEndpoint(profileDir);
      if (leftover) {
        try { const c = await Cdp.connect(leftover, 1500); await c.send('Browser.close').catch(() => {}); c.close(); } catch { /* not reachable */ }
      }
      if (!(await waitUntilFree(profileDir, 5000))) await closeBrowser(null, profileDir);
    }

    child = spawn(browser.path, [
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      url
    ], { stdio: 'ignore', windowsHide: false });
    child.on('error', err => log('login', 'Falha ao abrir o navegador', err.message));
    const launchedAt = Date.now();
    const exited = new Promise(r => child.on('exit', code => { log('login', `Processo do navegador terminou (código ${code})`); r(); }));
    onPhase('login');

    // Wait until the user closes the browser, or clicks "Concluir login" / "Cancelar"
    await Promise.race([exited, userActed]);
    if (!finishRequested && !canceled && Date.now() - launchedAt < 8000) {
      // The process we started ended right away: the browser handed the window
      // to another process. Give that one time to take the profile lock.
      log('login', 'O processo iniciado terminou logo; aguardando a janela do navegador');
      await Promise.race([sleep(4000), userActed]);
    }
    if (!finishRequested && !canceled) {
      // The window was closed; the browser may still be shutting down, or
      // keep running in the background. Wait for it, or for the user.
      while (profileInUse(profileDir) && !finishRequested && !canceled) {
        await Promise.race([sleep(500), userActed]);
      }
    }
    if (finishRequested || canceled) {
      onPhase('closing');
      const how = await closeBrowser(child, profileDir);
      log('login', `Navegador fechado: ${how}`);
      if (how === 'still-running') {
        return { ok: false, error: `Não foi possível fechar o ${browser.name}. Feche todas as janelas dele e tente de novo.` };
      }
    }
    if (canceled && !finishRequested) return { ok: true, connected: false, canceled: true };

    onPhase('reading');
    await sleep(500);
    const cookies = await readCookies(browser, profileDir);
    const byDomain = {};
    for (const c of cookies) {
      const d = String(c.domain).replace(/^\./, '');
      byDomain[d] = (byDomain[d] || 0) + 1;
    }
    const done = isDone(cookies);
    log('login', `Cookies lidos do perfil: ${cookies.length} (login encontrado: ${done ? 'sim' : 'não'})`, byDomain);
    return done ? { ok: true, connected: true, cookies } : { ok: true, connected: false, notFound: true };
  })().catch(err => {
    log('login', 'Erro no login pelo navegador', err.stack || err.message);
    return { ok: false, error: `Não foi possível ler o login do ${browser.name}: ${err.message}.` };
  });

  return {
    promise,
    // "Concluir login": close the browser and read what it saved
    finish: () => { finishRequested = true; wake(); },
    cancel: () => { canceled = true; wake(); }
  };
}

module.exports = { findBrowser, run, readCookies };
