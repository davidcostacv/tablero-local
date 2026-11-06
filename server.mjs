// server.mjs — servidor HTTP local + API REST (solo node:http)
// Por defecto escucha en 127.0.0.1. Con HOST=0.0.0.0 (o --lan) se abre a la red local y exige un token.
import { createServer } from 'node:http';
import { createReadStream, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { load, upsertMany, patch, remove, TYPES, STATUSES, PRIORITIES, SOURCE_KINDS, DATA_DIR } from './store.mjs';
import { ask } from './agent.mjs';
import { importWhatsApp } from './whatsapp.mjs';
import * as notify from './notify.mjs';
import { matrix as qrMatrix, svg as qrSvg, ascii as qrAscii } from './qr.mjs';
import { resolvePort } from './settings.mjs';
import { createVaultSync } from './vault-sync.mjs';
import { installFileLog } from './log.mjs';
import * as agenda from './agenda.mjs';

// Registro en data/server.log (rota a 1 MB, conserva server.log.1): imprescindible cuando corre oculto como tarea.
const LOG = process.env.LOG_OFF === '1' ? null : installFileLog(process.env.LOG_FILE || join(DATA_DIR, 'server.log'), { maxBytes: Number(process.env.LOG_MAX_BYTES) || 1024 * 1024 });
// Un fallo inesperado se registra y el servidor sigue (corre sin ventana: morir en silencio sería peor).
process.on('uncaughtException', (e, origin) => { console.error(`[fatal] ${origin}: ${(e && e.stack) || e}`); if (e && e.code === 'EADDRINUSE') process.exit(1); });
process.on('unhandledRejection', (r) => { console.error(`[promesa] rechazo sin capturar: ${(r && r.stack) || r}`); });

const PORT = resolvePort();
const STARTED = Date.now();
const APP_ID = 'life-dashboard'; // lo devuelve /api/meta: sirve para reconocer un tablero ya abierto en el puerto
const HOST = process.env.HOST || (process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1');
const LAN = !['127.0.0.1', 'localhost', '::1'].includes(HOST);
const PUBLIC = resolve(import.meta.dirname, 'public');
// Versión de la interfaz (data-build en public/index.html) leída al arrancar: la página la compara con /api/meta y avisa
// si el proceso que escucha es de una versión anterior (arrancado antes de un git pull).
const BUILD = (() => { try { const m = readFileSync(join(PUBLIC, 'index.html'), 'utf8').match(/<html[^>]*\sdata-build="([^"]+)"/); return m ? m[1] : ''; } catch { return ''; } })();
// La página no usa eval ni scripts externos: la CSP lo deja escrito para que el navegador lo haga cumplir.
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const MAX_BODY = 5 * 1024 * 1024;
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const PRIVATE = /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/;

// ---------- token (solo en modo red local) ----------
function loadToken() {
  if (process.env.DASH_TOKEN) return process.env.DASH_TOKEN.trim();
  const f = join(DATA_DIR, 'token.txt');
  try { const t = readFileSync(f, 'utf8').trim(); if (/^[a-f0-9]{32,}$/i.test(t)) return t; } catch {}
  const t = randomBytes(16).toString('hex');
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(f, t + '\n');
  return t;
}
const TOKEN = LAN ? loadToken() : null;
const sha = (s) => createHash('sha256').update(String(s)).digest();
const tokenOk = (t) => typeof t === 'string' && t.length > 0 && timingSafeEqual(sha(t), sha(TOKEN));
const fails = new Map(); // ip -> { n, until }
const LIMIT = 5, WINDOW = 15 * 60000;
function limited(ip) { const f = fails.get(ip); if (!f) return false; if (f.until && f.until > Date.now()) return true; if (f.until) fails.delete(ip); return false; }
function fail(ip) { const f = fails.get(ip) || { n: 0, until: 0 }; f.n++; if (f.n >= LIMIT) { f.until = Date.now() + WINDOW; f.n = 0; } fails.set(ip, f); }
const isLoopback = (req) => /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '');
const cookieToken = (req) => { const m = (req.headers.cookie || '').match(/(?:^|;\s*)dash=([A-Za-z0-9]+)/); return m ? m[1] : null; };
const bearer = (req) => { const m = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i); return m ? m[1] : null; };
const authed = (req) => !LAN || isLoopback(req) || tokenOk(cookieToken(req)) || tokenOk(bearer(req));

const hostOf = (v) => { if (!v) return ''; try { return new URL(v.includes('://') ? v : `http://${v}`).host.replace(/:\d+$/, ''); } catch { return ''; } };
const lanIps = (() => { let at = 0, ips = []; return () => { if (Date.now() - at > 60000) { ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address); at = Date.now(); } return ips; }; })();
// En modo red local se aceptan: nombres locales, las IP propias de la máquina, rangos privados/Tailscale y *.ts.net.
const hostAllowed = (h) => LOCAL.has(h) || (LAN && (lanIps().includes(h) || PRIVATE.test(h) || /\.ts\.net$/i.test(h)));
const lanUrls = () => lanIps().map((ip) => `http://${ip}:${PORT}`);

function json(res, code, body, extra) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(extra || {}) }); res.end(JSON.stringify(body)); }
function html(res, code, body, extra) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, ...(extra || {}) }); res.end(body); }
// Motivo de un rechazo en la consola del servidor: así se ve por qué el navegador recibe 401/403/429.
const deny = (req, code, why) => { console.error(`[acceso] ${code} ${req.method} ${req.url} desde ${req.socket.remoteAddress || '?'} (Host: ${req.headers.host || '-'}${req.headers.origin ? ', Origin: ' + req.headers.origin : ''}): ${why}`); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function readJson(req) {
  return new Promise((ok, fail) => {
    const err = (code, msg) => Object.assign(new Error(msg), { code });
    if (Number(req.headers['content-length']) > MAX_BODY) { req.resume(); return fail(err(413, 'body demasiado grande')); }
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) chunks.length = 0; else chunks.push(c); });
    req.on('end', () => { if (size > MAX_BODY) return fail(err(413, 'body demasiado grande')); try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''))); } catch { fail(err(400, 'JSON inválido')); } });
    req.on('error', fail);
  });
}
const wantsJson = (req) => /^application\/json\b/i.test(req.headers['content-type'] || '');
// Cuerpo binario (subida de imágenes de la agenda), con límite propio.
const MAX_IMG = 8 * 1024 * 1024;
function readRaw(req, max = MAX_IMG) {
  return new Promise((ok, fail) => {
    if (Number(req.headers['content-length']) > max) { req.resume(); return fail(Object.assign(new Error('imagen demasiado grande (máx. 8 MB)'), { code: 413 })); }
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on('end', () => (size > max ? fail(Object.assign(new Error('imagen demasiado grande (máx. 8 MB)'), { code: 413 })) : ok(Buffer.concat(chunks))));
    req.on('error', fail);
  });
}

// ---------- Agenda: /api/agenda[/:id[/images]] y /agenda-img/<archivo> ----------
async function handleAgenda(req, res, url, id, sub) {
  const err = (e) => json(res, e.code === 409 || e.code === 413 || e.code === 415 ? e.code : 400, { error: e.message });
  if (sub === 'images') {
    if (req.method === 'POST') {
      const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!agenda.IMG_TYPES[mime]) return json(res, 415, { error: 'se espera Content-Type image/png, image/jpeg, image/webp o image/gif' });
      let buf; try { buf = await readRaw(req); } catch (e) { return err(e); }
      if (!buf.length) return json(res, 400, { error: 'imagen vacía' });
      try { const t = agenda.addImage(id, buf, mime); return t ? json(res, 200, t) : json(res, 404, { error: 'no existe' }); } catch (e) { return err(e); }
    }
    if (req.method === 'DELETE') { const t = agenda.removeImage(id, url.searchParams.get('f')); return t ? json(res, 200, t) : json(res, 404, { error: 'no existe' }); }
    return json(res, 405, { error: 'method not allowed' });
  }
  if (req.method === 'GET' && !id) { agenda.attachLooseImages(); return json(res, 200, { today: agenda.today(), tz: agenda.timezone(), tasks: agenda.load() }); }
  if (req.method === 'POST' || req.method === 'PATCH') {
    if (!wantsJson(req)) return json(res, 415, { error: 'se requiere Content-Type: application/json' });
    let body; try { body = await readJson(req); } catch (e) { return json(res, e.code || 400, { error: e.message }); }
    try {
      if (req.method === 'POST' && !id) return json(res, 200, agenda.add(body));
      if (req.method === 'PATCH' && id) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'se espera un objeto' });
        const t = agenda.patch(id, body); return t ? json(res, 200, t) : json(res, 404, { error: 'no existe' });
      }
    } catch (e) { return err(e); }
  }
  if (req.method === 'DELETE' && id) return agenda.remove(id) ? json(res, 200, { ok: true, id }) : json(res, 404, { error: 'no existe' });
  return json(res, 405, { error: 'method not allowed' });
}
function serveAgendaImage(req, res, name) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  if (!/^[\w.-]{1,120}\.(png|jpe?g|webp|gif)$/i.test(name)) return json(res, 404, { error: 'not found' });
  const file = join(agenda.IMG_DIR(), name);
  let st; try { st = statSync(file); } catch { return json(res, 404, { error: 'not found' }); }
  const ext = extname(name).toLowerCase();
  res.writeHead(200, { 'Content-Type': { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext], 'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = resolve(PUBLIC, '.' + rel);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return json(res, 403, { error: 'forbidden' });
  let st; try { st = statSync(file); } catch { return json(res, 404, { error: 'not found' }); }
  if (!st.isFile()) return json(res, 404, { error: 'not found' });
  const ext = extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache', ...(ext === '.html' ? { 'Content-Security-Policy': CSP } : {}), ...(ext === '.js' && rel === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

const PAGE = (title, body) => `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px system-ui,sans-serif;margin:0;padding:32px 20px;max-width:720px;margin:auto;color:#1a1b1f}h1{font-size:22px}a{color:#3b6ef6}code{background:#f0f0f2;padding:2px 6px;border-radius:4px}svg{max-width:100%;height:auto}.card{border:1px solid #e5e6ea;border-radius:14px;padding:20px;margin:16px 0}</style><body>${body}</body></html>`;

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const ip = req.socket.remoteAddress || '';
  if (!hostAllowed(hostOf(req.headers.host)) || (req.headers.origin && !hostAllowed(hostOf(req.headers.origin)))) { deny(req, 403, 'host/origin no permitido' + (LAN ? '' : ' (el servidor solo acepta localhost; para la red local arranca con HOST=0.0.0.0)')); return json(res, 403, { error: 'host/origin no permitido' }); }
  if (LAN && limited(ip)) { deny(req, 429, 'demasiados intentos'); return json(res, 429, { error: 'demasiados intentos; espera 15 minutos' }); }
  // Inicio de sesión por enlace con token (cookie HttpOnly), solo relevante en modo red local.
  if (url.pathname === '/login') {
    if (!LAN) { res.writeHead(302, { Location: '/' }); return res.end(); }
    const t = url.searchParams.get('token') || '';
    if (!tokenOk(t)) { fail(ip); return html(res, 403, PAGE('Enlace inválido', '<h1>Enlace inválido</h1><p>Escanea de nuevo el código QR que muestra el servidor en el PC.</p>')); }
    res.writeHead(302, { Location: '/', 'Set-Cookie': `dash=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` }); return res.end();
  }
  if (url.pathname === '/qr') {
    if (!isLoopback(req)) return html(res, 403, PAGE('Solo desde el PC', '<h1>Solo desde el PC</h1><p>Esta página muestra el enlace con el token: ábrela en el PC donde corre el servidor.</p>'));
    if (!LAN) return html(res, 200, PAGE('Modo red local apagado', '<h1>Modo red local apagado</h1><p>Para usar el tablero desde el teléfono inicia el servidor con <code>$env:HOST="0.0.0.0"; node server.mjs</code> (ver README, «Usarlo desde el teléfono»).</p>'));
    const urls = lanUrls().map((u) => `${u}/login?token=${TOKEN}`);
    return html(res, 200, PAGE('Conectar el teléfono', `<h1>Conectar el teléfono</h1><p>Con el teléfono en la misma Wi-Fi (o en Tailscale), escanea el código o abre el enlace. El enlace guarda una cookie en el teléfono; no lo compartas.</p>${urls.map((u) => `<div class="card">${qrSvg(qrMatrix(u, 'L'), 5)}<p><a href="${esc(u)}">${esc(u)}</a></p></div>`).join('') || '<p>No se encontró ninguna IP de red local.</p>'}`));
  }
  if (!authed(req)) {
    deny(req, 401, cookieToken(req) || bearer(req) ? 'token inválido' : 'sin token (solo se exige fuera del PC: usa el enlace del QR)');
    if (LAN && (cookieToken(req) || bearer(req))) fail(ip);
    if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'token requerido' });
    return html(res, 401, PAGE('Acceso', '<h1>Acceso</h1><p>Para entrar desde este dispositivo abre el enlace con token que muestra el servidor (escanea el QR en el PC: <code>http://localhost:' + PORT + '/qr</code>).</p>'));
  }
  const ag = url.pathname.match(/^\/api\/agenda(?:\/([\w-]+)(?:\/(images))?)?\/?$/);
  if (ag) return handleAgenda(req, res, url, ag[1], ag[2]);
  const ai = url.pathname.match(/^\/agenda-img\/([^/]+)$/);
  if (ai) return serveAgendaImage(req, res, decodeURIComponent(ai[1]));
  const m = url.pathname.match(/^\/api\/(items|meta|agent|import|notify|vault)(?:\/([\w-]+))?\/?$/);
  if (!m) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, url.pathname);
  }
  const [, resource, id] = m;
  if (resource === 'meta') return json(res, 200, { app: APP_ID, build: BUILD, version: BUILD, uptime: Math.round((Date.now() - STARTED) / 1000), pid: isLoopback(req) ? process.pid : undefined, types: TYPES, statuses: STATUSES, priorities: PRIORITIES, sourceKinds: SOURCE_KINDS, agent: { mode: 'local' }, lan: LAN, loopback: isLoopback(req), port: PORT, dataDir: isLoopback(req) ? DATA_DIR : undefined, vault: vaultStatus(req), log: isLoopback(req) && LOG ? LOG.file : undefined });
  if (resource === 'vault') {
    if (req.method === 'GET' && !id) return json(res, 200, vaultStatus(req));
    if (req.method === 'POST' && id === 'sync') { await vault.sync('manual'); return json(res, 200, vaultStatus(req)); }
    return json(res, 405, { error: 'method not allowed' });
  }
  if (resource === 'agent') {
    if (req.method === 'GET') return json(res, 200, { mode: 'local' });
    if (req.method !== 'POST' || id) return json(res, 405, { error: 'method not allowed' });
    if (!wantsJson(req)) return json(res, 415, { error: 'se requiere Content-Type: application/json' });
    let body; try { body = await readJson(req); } catch (e) { return json(res, e.code || 400, { error: e.message }); }
    const question = body && typeof body.question === 'string' ? body.question.trim().slice(0, 500) : '';
    if (!question) return json(res, 400, { error: 'se espera {question}' });
    try { return json(res, 200, await ask(question)); } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (resource === 'import') {
    if (req.method !== 'POST' || id !== 'whatsapp') return json(res, 404, { error: 'not found' });
    if (!wantsJson(req)) return json(res, 415, { error: 'se requiere Content-Type: application/json' });
    let body; try { body = await readJson(req); } catch (e) { return json(res, e.code || 400, { error: e.message }); }
    if (!body || typeof body.text !== 'string' || !body.text.trim()) return json(res, 400, { error: 'se espera {text} con el chat exportado' });
    const s = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : undefined);
    try { return json(res, 200, importWhatsApp(body.text, { chat: s(body.chat, 120) || 'WhatsApp', contact: s(body.contact, 80), phone: s(body.phone, 20), me: s(body.me, 80) })); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (resource === 'notify') {
    if (req.method === 'GET' && !id) return json(res, 200, notify.status());
    if (req.method === 'POST' && id === 'test') { const r = await notify.send({ title: 'Tablero: prueba', body: 'Las notificaciones funcionan.', priority: 'default', tags: ['white_check_mark'] }, (s) => console.error('[notify] ' + s)); return json(res, 200, r); }
    if (req.method === 'POST' && id === 'digest') return json(res, 200, await notify.sendDigest((s) => console.error('[notify] ' + s)));
    if (req.method === 'PATCH' && !id) {
      if (!wantsJson(req)) return json(res, 415, { error: 'se requiere Content-Type: application/json' });
      let body; try { body = await readJson(req); } catch (e) { return json(res, e.code || 400, { error: e.message }); }
      if (!body || typeof body.overdueAlerts !== 'boolean') return json(res, 400, { error: 'se espera {overdueAlerts: boolean}' });
      notify.saveSettings({ overdueAlerts: body.overdueAlerts }); return json(res, 200, notify.status());
    }
    return json(res, 405, { error: 'method not allowed' });
  }
  if (req.method === 'GET' && !id) return json(res, 200, load());
  if (req.method === 'POST' || req.method === 'PATCH') {
    if (!wantsJson(req)) return json(res, 415, { error: 'se requiere Content-Type: application/json' });
    let body; try { body = await readJson(req); } catch (e) { return json(res, e.code || 400, { error: e.message }); }
    try {
      if (req.method === 'POST' && !id) return json(res, 200, upsertMany(body));
      if (req.method === 'PATCH' && id) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'se espera un objeto' });
        const it = patch(id, body); return it ? json(res, 200, it) : json(res, 404, { error: 'no existe' });
      }
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (req.method === 'DELETE' && id) return remove(id) ? json(res, 200, { ok: true, id }) : json(res, 404, { error: 'no existe' });
  return json(res, 405, { error: 'method not allowed' });
}

// Mensaje para EADDRINUSE con los comandos del shell de cada plataforma (en Windows el usuario está en PowerShell, no en bash).
export function portInUseMessage(port, platform = process.platform) {
  const alt = Number(port) === 5000 ? 5001 : 5000;
  const head = `El puerto ${port} ya está en uso (¿otro tablero abierto?).`;
  if (platform === 'win32') return [
    head,
    `Para liberarlo (PowerShell): Get-NetTCPConnection -LocalPort ${port} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`,
    `O usa otro puerto: $env:PORT="${alt}"; node server.mjs`,
  ].join('\n');
  return `${head} Cierra esa ventana o usa otro puerto: PORT=${alt} node server.mjs`;
}
const openBrowser = (url) => import('node:child_process').then(({ exec }) => exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`, () => {}));
// ¿Lo que escucha en el puerto es este mismo tablero? (GET /api/meta devuelve app: APP_ID)
async function dashboardAlreadyRunning(port) {
  try { const m = await (await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1500) })).json(); return m && m.app === APP_ID; } catch { return false; }
}

// Sincronización del vault (ver vault-sync.mjs). La ruta del vault solo se muestra desde el PC.
const vault = createVaultSync({ log: (s) => console.log('[vault] ' + s) });
const vaultStatus = (req) => { const s = vault.status(); return isLoopback(req) ? s : { ...s, path: undefined }; };

const server = createServer((req, res) => handle(req, res).catch((e) => { console.error(`[error] ${req.method} ${req.url}: ${e.stack || e.message}`); try { json(res, 500, { error: e.message }); } catch {} }));
server.on('clientError', (e, socket) => { if (e.code !== 'ECONNRESET' && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); else socket.destroy(); });
// Otro proceso ya sirve este tablero en ese puerto: no es un fallo, basta con abrirlo (y salir con 0: run-hidden.vbs no reintenta).
async function exitAlreadyOpen() {
  const url = `http://localhost:${PORT}`;
  console.log(`El tablero ya está abierto en ${url} (otro proceso lo sirve). No hace falta arrancarlo otra vez.`);
  if (process.env.OPEN_BROWSER === '1') { await openBrowser(url); await new Promise((r) => setTimeout(r, 300)); }
  process.exit(0);
}
server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') { console.error(`No se pudo iniciar el servidor: ${e.message}`); process.exit(1); }
  if (await dashboardAlreadyRunning(PORT)) return exitAlreadyOpen();
  console.error(portInUseMessage(PORT));
  process.exit(1);
});
// En Windows escuchar en 127.0.0.1:PUERTO NO da EADDRINUSE si otro tablero ya escucha en 0.0.0.0:PUERTO (modo red local),
// y quedarían dos servidores sobre los mismos datos. Por eso se pregunta antes (si no hay nada, la conexión se rechaza al instante).
if (await dashboardAlreadyRunning(PORT)) await exitAlreadyOpen();
server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Tablero en ${url}${LAN ? ' (modo red local)' : ''} · datos en ${join(DATA_DIR, 'items.json')}`);
  if (LAN) {
    const urls = lanUrls();
    if (!urls.length) console.log('No se encontró ninguna IP de red local.');
    urls.forEach((u) => console.log(`  Teléfono: ${u}/login?token=${TOKEN}`));
    if (urls.length && process.env.NO_QR !== '1') { console.log('\nEscanea con el teléfono (o abre ' + url + '/qr en el PC):\n'); console.log(qrAscii(qrMatrix(`${urls[0]}/login?token=${TOKEN}`, 'L'), { color: !!process.stdout.isTTY && !process.env.NO_COLOR })); }
    console.log(`\nEl token está en ${process.env.DASH_TOKEN ? 'DASH_TOKEN' : join(DATA_DIR, 'token.txt')}. No lo compartas.`);
  }
  if (process.env.NOTIFY_OFF !== '1') notify.start();
  // start-dashboard.cmd pone OPEN_BROWSER=1: el navegador se abre solo cuando el servidor ya escucha.
  if (process.env.OPEN_BROWSER === '1') openBrowser(url);
  // Vault: importa ahora y sigue sincronizando en segundo plano (VAULT_SYNC_OFF=1 lo apaga, p. ej. en pruebas).
  if (process.env.VAULT_SYNC_OFF !== '1') vault.start().catch((e) => console.error('[vault] ' + e.message));
});
const shutdown = (sig) => { console.log(`Servidor detenido (${sig}).`); vault.stop(); server.close(); process.exit(0); };
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
