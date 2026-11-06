// test-sync.mjs — pruebas de ajustes persistentes, registro con rotación y sincronización automática del vault:
//   node test-sync.mjs
// Usa carpetas temporales (vault sintético de test-vault.mjs y DATA_DIR propio); arranca servidores en puertos
// aleatorios altos y nunca toca data/ ni el puerto 4747.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { makeVault } from './test-vault.mjs';

const root = mkdtempSync(join(tmpdir(), 'sync test '));
const DATA = join(root, 'data');
process.env.DATA_DIR = DATA; delete process.env.VAULT; delete process.env.PORT;
let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000, step = 100) => { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() > end) return null; await sleep(step); } };

// ---------- settings.mjs ----------
const S = await import('./settings.mjs');
t('settings: valores por defecto sin archivo', S.readSettings().overdueAlerts === true && !existsSync(S.SETTINGS_FILE));
S.saveSettings({ vault: 'C:\\x\\Claude-Memoria', port: 5055 });
t('settings: guarda y vuelve a leer (mezcla con lo que había)', existsSync(S.SETTINGS_FILE) && S.readSettings().vault === 'C:\\x\\Claude-Memoria' && S.readSettings().port === 5055 && S.readSettings().overdueAlerts === true);
S.saveSettings({ overdueAlerts: false });
t('settings: cambiar una clave no borra las demás', S.readSettings().overdueAlerts === false && S.readSettings().port === 5055);
S.saveSettings({ port: null });
t('settings: null borra la clave', !('port' in S.readSettings()));
writeFileSync(S.SETTINGS_FILE, '\uFEFF' + JSON.stringify({ vault: '/con/bom', overdueAlerts: true }));
t('settings: tolera BOM (PowerShell 5.1)', S.readSettings().vault === '/con/bom');
writeFileSync(S.SETTINGS_FILE, '{roto');
t('settings: archivo roto → valores por defecto sin lanzar', S.readSettings().overdueAlerts === true && S.readSettings().vault === undefined);
S.saveSettings({ vault: '/desde/settings' });
t('resolveVault: settings.json cuando no hay variable', S.resolveVault().path === '/desde/settings' && S.resolveVault().source === 'settings');
process.env.VAULT = '/desde/env';
t('resolveVault: la variable VAULT manda', S.resolveVault().path === '/desde/env' && S.resolveVault().source === 'env');
delete process.env.VAULT; S.saveSettings({ vault: null });
t('resolveVault: sin nada → null (no existe ~/Claude-Memoria aquí) o el defecto', S.resolveVault().path === null || /Claude-Memoria$/.test(S.resolveVault().path));
S.saveSettings({ port: 5077 });
t('resolvePort: settings.json; PORT manda; puertos inválidos se ignoran', S.resolvePort() === 5077 && (process.env.PORT = '6001', S.resolvePort() === 6001) && (process.env.PORT = '80', S.resolvePort() === 5077) && (delete process.env.PORT, S.saveSettings({ port: 'x' }), S.resolvePort() === 4747));
S.saveSettings({ port: null });

// ---------- log.mjs: rotación ----------
const L = await import('./log.mjs');
const lf = join(root, 'logs', 'server.log');
const lg = L.createFileLog(lf, { maxBytes: 600 });
for (let i = 0; i < 40; i++) lg.write('INFO', [`línea ${i} ${'x'.repeat(30)}`]);
t('log: crea la carpeta y el archivo', existsSync(lf));
t('log: rota al pasar de maxBytes y conserva una copia (.1)', existsSync(lf + '.1') && statSync(lf).size <= 600 && statSync(lf + '.1').size <= 600 && !existsSync(lf + '.2'), { a: statSync(lf).size, b: existsSync(lf + '.1') && statSync(lf + '.1').size });
t('log: la última línea está en el archivo actual, con fecha y nivel', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO línea 39 /m.test(readFileSync(lf, 'utf8')));
const lf2 = join(root, 'logs', 'tee.log');
const tee = L.installFileLog(lf2, { maxBytes: 10000 });
console.log('hola %s', 'mundo'); console.error(new Error('boom').message); console.warn('ojo');
tee.restore();
console.log('no va al archivo');
const teeTxt = readFileSync(lf2, 'utf8');
t('log: console.log/error/warn quedan en el archivo con nivel; restore lo desconecta', /INFO hola mundo/.test(teeTxt) && /ERROR boom/.test(teeTxt) && /WARN ojo/.test(teeTxt) && !/no va al archivo/.test(teeTxt), teeTxt);

// ---------- import-vault: collectAsync == collect y el CLI toma el vault de settings.json ----------
const VAULT = join(root, 'Google drive', 'Obsidian', 'Claude-Memoria');
const n = makeVault(VAULT);
const IV = await import('./import-vault.mjs');
const norm = (a) => JSON.stringify(a.map((i) => ({ ...i, tags: i.tags || [] })).sort((x, y) => (x.source.ref + x.title).localeCompare(y.source.ref + y.title)));
const syncItems = IV.collect(VAULT), asyncItems = await IV.collectAsync(VAULT);
t(`collectAsync: mismos ${n.areas + n.projects + n.chats} items que collect (fs asíncrono)`, asyncItems.length === syncItems.length && norm(asyncItems) === norm(syncItems), [asyncItems.length, syncItems.length]);
t('collectAsync: source.ref relativo al vault que se pasa (no al de la variable)', asyncItems.every((i) => i.source.kind !== 'vault' || !i.source.ref.startsWith('/')) && asyncItems.some((i) => /^30 Conversaciones\//.test(i.source.ref)));
t('collectAsync: vault inexistente → lista vacía sin lanzar', (await IV.collectAsync(join(root, 'no-existe'))).length === 0);
const cliData = join(root, 'data-cli'); mkdirSync(cliData, { recursive: true });
writeFileSync(join(cliData, 'settings.json'), '\uFEFF' + JSON.stringify({ vault: VAULT }));
const env = { ...process.env, DATA_DIR: cliData }; delete env.VAULT;
const cliOut = execFileSync(process.execPath, ['import-vault.mjs'], { cwd: import.meta.dirname, env }).toString();
t('CLI import-vault.mjs usa el vault de data/settings.json (sin variable VAULT)', new RegExp(`^${n.areas + n.projects + n.chats - 0} nuevos|^\\d+ nuevos`).test(cliOut) && cliOut.includes(VAULT) && existsSync(join(cliData, 'items.json')), cliOut);

// ---------- servidor: sincronización automática ----------
const basePort = 5200 + Math.floor(Math.random() * 300);
async function startServer(dataDir, extraEnv, port) {
  const e = { ...process.env, PORT: String(port), DATA_DIR: dataDir, NOTIFY_OFF: '1', NO_QR: '1', OPEN_BROWSER: '0', HOST: '127.0.0.1', ...extraEnv };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const p = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => (p.log += d)); p.stderr.on('data', (d) => (p.log += d));
  p.url = `http://127.0.0.1:${port}`;
  const ok = await until(async () => (await fetch(p.url + '/api/meta')).ok, 8000, 50);
  if (!ok) throw new Error('el servidor no arrancó: ' + p.log);
  return p;
}
const stop = (p) => new Promise((r) => { p.on('exit', r); p.kill(); setTimeout(r, 2000); });
const get = (p, path) => fetch(p.url + path).then((r) => r.json());
const post = (p, path, body) => fetch(p.url + path, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });

// a) vault presente: importa al arrancar, cada intervalo y al detectar cambios; conserva el status editado
const d1 = join(root, 'data-srv1');
const s1 = await startServer(d1, { VAULT, VAULT_SYNC_MINUTES: '0.03', VAULT_WATCH_DEBOUNCE_MS: '200' }, basePort);
let meta = await until(async () => { const m = await get(s1, '/api/meta'); return m.vault && m.vault.lastSync ? m : null; });
const expected = n.areas + n.projects + n.chats;
t('meta: version, uptime, pid, log y estado del vault', meta && meta.version === meta.build && typeof meta.uptime === 'number' && typeof meta.pid === 'number' && /server\.log$/.test(meta.log || '') && meta.vault.configured && meta.vault.exists && meta.vault.path === VAULT && meta.vault.source === 'env', meta && meta.vault);
t(`sincroniza al arrancar: ${expected} items (origen "inicio")`, meta && meta.vault.lastSync.ok && meta.vault.lastSync.total === expected && meta.vault.lastSync.created === expected && meta.vault.lastSync.trigger === 'inicio', meta && meta.vault.lastSync);
t('meta: próxima sincronización programada e intervalo', meta && meta.vault.nextSync && meta.vault.intervalMinutes === 0.03);
let items = await get(s1, '/api/items');
t('GET /api/items ya tiene lo importado', items.length === expected, items.length);
// editar estado en el tablero
const landing = items.find((i) => i.title === 'Landing cliente Y');
const pr = await fetch(s1.url + '/api/items/' + landing.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }) });
t('PATCH status en el tablero', pr.status === 200 && (await pr.json()).status === 'done');
// sincronización manual
const manual = await post(s1, '/api/vault/sync');
const mj = await manual.json();
t('POST /api/vault/sync: 200 con el resultado (0 nuevos, todo actualizado, origen "manual")', manual.status === 200 && mj.lastSync.ok && mj.lastSync.trigger === 'manual' && mj.lastSync.created === 0 && mj.lastSync.updated === expected, mj.lastSync);
t('GET /api/vault: mismo estado', (await get(s1, '/api/vault')).lastSync.trigger === 'manual');
t('métodos no permitidos en /api/vault: 405', (await fetch(s1.url + '/api/vault/sync')).status === 405 && (await fetch(s1.url + '/api/vault', { method: 'DELETE' })).status === 405 && (await fetch(s1.url + '/api/vault/otro', { method: 'POST' })).status === 405);
items = await get(s1, '/api/items');
t('reimportar (manual) conserva el status editado en el tablero', items.find((i) => i.id === landing.id).status === 'done' && items.length === expected);
// nueva nota en el vault → aparece sola (fs.watch o intervalo de 1,8 s)
writeFileSync(join(VAULT, '20 Proyectos', 'Nota nueva.md'), '---\ntitle: Nota nueva\nstatus: todo\narea: Casa\ndue: 2026-12-01\n---\nLlegó después de arrancar.\n');
const t0 = Date.now();
const appeared = await until(async () => (await get(s1, '/api/items')).find((i) => i.title === 'Nota nueva'), 10000, 150);
t('una nota nueva en el vault aparece sola en el tablero', !!appeared && appeared.status === 'todo' && appeared.due === '2026-12-01', { ms: Date.now() - t0, log: s1.log.slice(-400) });
meta = await get(s1, '/api/meta');
t('la sincronización automática la hizo el intervalo o el watcher (no "manual")', ['intervalo', 'cambio'].includes(meta.vault.lastSync.trigger) && meta.vault.lastSync.total === expected + 1, meta.vault.lastSync);
// editar la nota ya editada en el tablero → el status del tablero sigue mandando
appendFileSync(join(VAULT, '10 Memoria', 'areas', 'Landing cliente Y.md'), '\n- [stated] viñeta agregada después\n');
const resynced = await until(async () => { const it = (await get(s1, '/api/items')).find((i) => i.id === landing.id); return it && /viñeta agregada después/.test(it.notes || '') ? it : null; }, 10000, 150);
t('al cambiar la nota se actualizan las notas pero el status editado (done) se conserva', !!resynced && resynced.status === 'done', resynced && { status: resynced.status, notes: (resynced.notes || '').slice(-60) });
t('el watcher está activo en esta plataforma (informativo)', meta.vault.watching === true || process.platform === 'linux', meta.vault.watching);
// registro
const logFile = join(d1, 'server.log');
t('data/server.log existe y registra arranque y sincronizaciones', existsSync(logFile) && /INFO Tablero en http/.test(readFileSync(logFile, 'utf8')) && /\[vault\] sincronizado \(inicio\)/.test(readFileSync(logFile, 'utf8')), readFileSync(logFile, 'utf8').slice(0, 300));
// un error dentro de una petición no tumba el servidor y queda registrado
const bad = await fetch(s1.url + '/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"todo"}' });
t('petición inválida: 400 y el servidor sigue', bad.status === 400 && (await fetch(s1.url + '/api/meta')).ok);
await stop(s1);
// En Windows child.kill() termina el proceso a la fuerza (TerminateProcess): no llega SIGTERM y el manejador no corre.
if (process.platform === 'win32') console.log('  (omitida en Windows: kill() no entrega SIGTERM) al terminar deja constancia en el registro');
else t('al terminar (SIGTERM) deja constancia en el registro', /Servidor detenido/.test(readFileSync(logFile, 'utf8')));

// b) vault configurado pero inexistente: lo dice, no se cae, y el sync manual devuelve el error
const d2 = join(root, 'data-srv2');
const s2 = await startServer(d2, { VAULT: join(root, 'no', 'existe'), VAULT_SYNC_MINUTES: '0.02' }, basePort + 1);
meta = await until(async () => { const m = await get(s2, '/api/meta'); return m.vault.lastSync ? m : null; });
t('vault inexistente: configured, !exists y error claro', meta && meta.vault.configured && meta.vault.exists === false && meta.vault.lastSync.ok === false && /no existe/.test(meta.vault.lastSync.error), meta && meta.vault);
const r2 = await (await post(s2, '/api/vault/sync')).json();
t('vault inexistente: POST /api/vault/sync responde 200 con ok:false y el servidor sigue', r2.lastSync.ok === false && r2.lastSync.trigger === 'manual' && (await get(s2, '/api/items')).length === 0);
await sleep(1500);
t('vault inexistente: el intervalo sigue intentando sin tumbar el servidor', (await fetch(s2.url + '/api/meta')).ok && s2.exitCode === null);
// aparece la carpeta después (Drive terminó de sincronizar) → se importa sola
mkdirSync(join(root, 'no', 'existe', '20 Proyectos'), { recursive: true });
writeFileSync(join(root, 'no', 'existe', '20 Proyectos', 'Tarde.md'), '---\ntitle: Tarde\nstatus: doing\n---\nx\n');
const late = await until(async () => (await get(s2, '/api/items')).find((i) => i.title === 'Tarde'), 8000, 150);
t('cuando la carpeta aparece, el siguiente intervalo la importa', !!late, s2.log.slice(-300));
await stop(s2);

// c) sin vault: ni variable ni settings ni ~/Claude-Memoria → configured:false, el resto funciona
const d3 = join(root, 'data-srv3'); const fakeHome = join(root, 'home'); mkdirSync(fakeHome, { recursive: true });
const s3 = await startServer(d3, { VAULT: undefined, HOME: fakeHome, USERPROFILE: fakeHome }, basePort + 2);
meta = await get(s3, '/api/meta');
t('sin vault: configured:false, path:null y sin lastSync', meta.vault.configured === false && meta.vault.path === null && !meta.vault.lastSync, meta.vault);
t('sin vault: POST /api/vault/sync responde con "sin vault configurado"', /sin vault/.test((await (await post(s3, '/api/vault/sync')).json()).lastSync.error));
await stop(s3);

// d) el puerto se toma de data/settings.json (lo escribe setup.ps1) y la rotación del registro funciona en vivo
const d4 = join(root, 'data-srv4'); mkdirSync(d4, { recursive: true });
writeFileSync(join(d4, 'settings.json'), JSON.stringify({ port: basePort + 3, vault: VAULT }));
const s4 = await startServer(d4, { PORT: undefined, VAULT: undefined, LOG_MAX_BYTES: '2500', VAULT_SYNC_OFF: '1' }, basePort + 3);
meta = await get(s4, '/api/meta');
t('el servidor escucha en el puerto de settings.json y toma el vault de ahí', meta.port === basePort + 3 && meta.vault.source === 'settings' && meta.vault.path === VAULT, [meta.port, meta.vault]);
// cada rechazo por Host ajeno deja una línea en el registro (fetch no deja fijar Host: se usa http.request)
const { request } = await import('node:http');
const evil = () => new Promise((res) => { const r = request({ host: '127.0.0.1', port: basePort + 3, path: '/api/items', headers: { Host: 'evil.com' } }, (resp) => { resp.resume(); resp.on('end', () => res(resp.statusCode)); }); r.on('error', () => res(0)); r.end(); });
let codes = []; for (let i = 0; i < 40; i++) codes.push(await evil());
t('Host ajeno: 403 y registrado', codes.every((c) => c === 403) && /\[acceso\] 403/.test(readFileSync(join(d4, 'server.log'), 'utf8') + readFileSync(join(d4, 'server.log.1'), 'utf8')), codes.slice(0, 3));
t('server.log rota en vivo (LOG_MAX_BYTES) y conserva solo una copia', existsSync(join(d4, 'server.log.1')) && statSync(join(d4, 'server.log')).size <= 2500 && !existsSync(join(d4, 'server.log.2')), { size: statSync(join(d4, 'server.log')).size });
await stop(s4);

rmSync(root, { recursive: true, force: true });
console.log(`${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
