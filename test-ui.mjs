// test-ui.mjs — abre la interfaz en Chrome (Playwright) con el vault sintético y comprueba que nunca queda en blanco:
//   node test-ui.mjs            (necesita `playwright` instalado local o globalmente y Chrome/Chromium; si no, se salta)
// Escenarios: datos reales del vault (0 errores de página), API caída (aviso y navegación intacta), servidor de otra
// versión (aviso), datos basura del API (se pintan con valores seguros), service worker con el servidor apagado y
// recuperación automática al volver a arrancarlo.
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { makeVault } from './test-vault.mjs';

const require = createRequire(import.meta.url);
function findPlaywright() {
  const paths = [process.cwd(), import.meta.dirname];
  try { paths.push(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch {}
  try { return require.resolve('playwright', { paths }); } catch { return null; }
}
const pw = findPlaywright();
if (!pw) { console.log('test-ui: playwright no está instalado (npm i -g playwright); se omite.'); process.exit(0); }
const pwMod = await import(pathToFileURL(pw).href);
const chromium = pwMod.chromium || (pwMod.default && pwMod.default.chromium);
async function launch() {
  const opts = { args: ['--no-sandbox'] };
  try { return await chromium.launch(opts); } catch {}
  for (const exe of [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean)) {
    if (existsSync(exe)) { try { return await chromium.launch({ ...opts, executablePath: exe }); } catch {} }
  }
  return null;
}
const browser = await launch();
if (!browser) { console.log('test-ui: no hay Chrome/Chromium (npx playwright install chromium); se omite.'); process.exit(0); }

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- datos: vault sintético importado a una carpeta temporal ----------
const root = mkdtempSync(join(tmpdir(), 'ui test '));
const VAULT = join(root, 'Google drive', 'Obsidian', 'Claude-Memoria'), DATA = join(root, 'data');
makeVault(VAULT);
execSync(`"${process.execPath}" import-vault.mjs`, { cwd: import.meta.dirname, env: { ...process.env, VAULT, DATA_DIR: DATA }, stdio: 'ignore' });

// ---------- servidor ----------
const PORT = 4900 + Math.floor(Math.random() * 100), URL = `http://127.0.0.1:${PORT}/`;
let srv = null, srvLog = '';
async function startServer(extraEnv = {}) {
  srv = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, NOTIFY_OFF: '1', NO_QR: '1', OPEN_BROWSER: '0', HOST: '127.0.0.1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + 'api/meta')).ok) return; } catch {} await sleep(50); }
  throw new Error('el servidor no arrancó: ' + srvLog);
}
async function stopServer() { if (!srv) return; const p = srv; srv = null; p.kill(); await new Promise((r) => { p.on('exit', r); setTimeout(r, 2000); }); for (let i = 0; i < 40; i++) { try { await fetch(URL + 'api/meta'); await sleep(50); } catch { return; } } }
await startServer();

// ---------- página ----------
// Sin service worker en los escenarios 1-6 (page.route no intercepta lo que pide el SW); el SW se prueba aparte en el 7.
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark', serviceWorkers: 'block' });
let page = await ctx.newPage();
const errs = [], cons = [];
const watch = (p) => { p.on('pageerror', (e) => errs.push(String(e.message || e))); p.on('console', (m) => { if (m.type() === 'error') cons.push(m.text()); }); };
watch(page);
const state = () => page.evaluate(() => ({
  nav: document.querySelectorAll('#nav button').length, date: document.getElementById('date').textContent, lede: document.getElementById('lede').textContent,
  tabs: document.querySelectorAll('#tabs button').length, kpis: document.querySelectorAll('.kpi').length, view: document.getElementById('view').children.length,
  areas: document.querySelectorAll('#areas button').length, recents: document.querySelectorAll('#recents button').length, rows: document.querySelectorAll('tr.r, .trow').length,
  banner: document.getElementById('banner').hidden ? '' : document.getElementById('banner-tx').textContent, secErr: [...document.querySelectorAll('.sec-err')].map((e) => e.textContent),
}));
const clickNav = (label) => page.evaluate((l) => { const b = [...document.querySelectorAll('#nav button, #wa-nav button')].find((b) => (b.textContent || '').trim().replace(/\d+$/, '').trim() === l); if (b) b.click(); return !!b; }, label);
const clickTab = (i) => page.evaluate((i) => { const b = document.querySelectorAll('#tabs button')[i]; if (b) b.click(); return !!b; }, i);

// 1. Datos reales del vault
await page.goto(URL, { waitUntil: 'networkidle' }); await sleep(500);
let s = await state();
t('vault: resumen completo (nav, fecha, pestañas, KPIs, áreas, recientes)', s.nav === 7 && s.date && s.lede && s.tabs === 4 && s.kpis === 4 && s.areas === 8 && s.recents === 4 && !s.banner && !s.secErr.length, s);
t('vault: muestra "cosas en curso" con los proyectos importados', /en curso/.test(s.lede), s.lede);
for (const [label, subtabs] of [['Proyectos', 3], ['Trabajos', 3], ['Tareas', 3], ['Estudio', 3], ['Automatizaciones', 3], ['Chats', 1], ['Contactos', 3]]) {
  t(`nav ${label}`, await clickNav(label)); await sleep(100);
  for (let i = 0; i < subtabs; i++) { await clickTab(i); await sleep(60); }
  s = await state(); t(`${label}: vista pintada sin errores de sección`, s.view > 0 && !s.secErr.length && !s.banner, s);
}
await clickNav('Proyectos'); await clickTab(2); await sleep(100); s = await state();
t('Proyectos/Todos: filas con los 25 proyectos (24 áreas + 2 de 20 Proyectos − 1 que es trabajo)', s.rows === 25, s.rows);
await page.evaluate(() => document.querySelector('td.name button').click()); await sleep(100);
t('expandir un proyecto muestra el detalle con notas y fuente', await page.evaluate(() => !!document.querySelector('.detail form') && /Fuente: /.test(document.querySelector('.detail .src').textContent)));
await page.evaluate(() => { const sw = document.querySelector('.setrow .sw'); if (sw) sw.click(); }); await sleep(150); s = await state();
t('agrupar por área: una tabla por área (incluye áreas "constructor" y "__proto__")', await page.evaluate(() => { const caps = [...document.querySelectorAll('.tcard .cap')].map((c) => c.textContent); return caps.includes('constructor') && caps.includes('__proto__') && caps.length > 10; }) && !s.secErr.length, s);
await page.evaluate(() => { const sw = document.querySelector('.setrow .sw'); if (sw) sw.click(); });
await clickNav('Chats'); await sleep(100); s = await state();
t('Chats: 212 conversaciones', s.rows === 212 && /212 conversaciones/.test(s.lede), [s.rows, s.lede]);
await clickNav('Resumen'); await clickTab(3); await sleep(400); s = await state();
t('Estadísticas: 5 gráficos sin errores', await page.evaluate(() => document.querySelectorAll('.charts .card').length === 5 && document.querySelectorAll('svg.ch').length >= 2) && !s.secErr.length, s);
await clickTab(0);
await page.fill('#q', 'ñ'); await sleep(300); s = await state();
t('búsqueda "ñ": resultados sin errores', s.view === 1 && s.rows > 0 && !s.secErr.length, s);
await page.fill('#q', ''); await sleep(300);
await page.evaluate(() => document.getElementById('settings-btn').click()); await sleep(600);
t('Ajustes: muestra versión del servidor y carpeta de datos', await page.evaluate(() => /Servidor: versión \S+ · datos en /.test(document.getElementById('view').textContent)), await page.evaluate(() => document.getElementById('view').textContent.slice(0, 300)));
t('vault: 0 errores de página', errs.length === 0, errs);
t('vault: 0 errores de consola', cons.length === 0, cons);

// 2. API caída (bloqueada): aviso claro, navegación y vistas siguen
await page.route('**/api/**', (r) => r.abort());
await page.goto(URL, { waitUntil: 'load' }); await sleep(600); s = await state();
t('API caída: la carcasa se pinta igual (nav, fecha, pestañas) y hay aviso de servidor', s.nav === 7 && s.date && s.tabs === 4 && /No se puede conectar con el servidor del tablero/.test(s.banner) && /start-dashboard\.cmd/.test(s.banner), s);
t('API caída: el botón dice Reintentar', await page.evaluate(() => document.getElementById('banner-btn').textContent === 'Reintentar'));
await clickNav('Tareas'); await sleep(100); s = await state();
t('API caída: cambiar de vista no rompe nada', s.view > 0 && !s.secErr.length, s);
await page.unroute('**/api/**');
await sleep(5500); s = await state();
t('API vuelve: reintento automático (5 s) carga los datos y quita el aviso', !s.banner && s.areas === 8, s);

// 3. API con error HTTP (500) → aviso con el mensaje del servidor
await page.route('**/api/items', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'items.json corrupto' }) }));
await page.goto(URL, { waitUntil: 'load' }); await sleep(500); s = await state();
t('API 500: aviso con status y mensaje del servidor; la carcasa sigue', /HTTP 500: items\.json corrupto/.test(s.banner) && s.nav === 7, s);
await page.unroute('**/api/items');

// 4. Servidor de otra versión / otro programa
await page.route('**/api/meta', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ app: 'life-dashboard', types: [] }) }));
await page.goto(URL, { waitUntil: 'networkidle' }); await sleep(500); s = await state();
t('servidor viejo (meta sin build): aviso "versión anterior" y los datos se muestran igual', /versión anterior del tablero/.test(s.banner) && s.kpis === 4, s);
await page.unroute('**/api/meta');
await page.route('**/api/meta', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"hello":"world"}' }));
await page.goto(URL, { waitUntil: 'networkidle' }); await sleep(500); s = await state();
t('otro programa en el puerto: aviso', /otro programa/.test(s.banner), s);
await page.unroute('**/api/meta');

// 5. Datos basura del API: nada rompe, todo se normaliza
const junk = [null, 1, 'x', [], {}, { id: 'a', type: 'trabajo', title: 'Alias trabajo', status: 'hecho', due: 'Oct 13 – Dec 2, 2026', area: 42, tags: 'no-lista', contact: 'x', source: 'y' },
  { id: 'b', type: 'raro', title: '', status: 'cosa', due: '2026-02-30', date: null, priority: 'urgent', notes: ['a'], updatedAt: 5 },
  { id: 'c', type: 'todo', title: 'Vence mal', status: 'todo', due: '2026-13-45', createdAt: 'no-fecha' },
  { id: 'c', type: 'todo', title: 'Duplicado de id' }, { id: 'd', type: 'todo', title: 'Atrasada', status: 'todo', due: '2020-01-01', priority: 'high', contact: { name: 'Ana', phone: '+573001234567' } },
  { id: 'e', type: 'chat', title: 'Chat sin fecha', url: 'javascript:alert(1)' }, { id: 'f', type: 'project', title: 'Proto', area: '__proto__', status: 'doing' }, { id: 'g', type: 'project', title: 'Ctor', area: 'constructor', status: 'doing' }];
await page.route('**/api/items', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(junk) }));
await page.goto(URL, { waitUntil: 'networkidle' }); await sleep(500); s = await state();
t('datos basura: resumen sin errores, con KPIs y la tarea atrasada', s.kpis === 4 && !s.secErr.length && !s.banner && /atrasada/.test(s.lede), s);
for (const label of ['Proyectos', 'Trabajos', 'Tareas', 'Chats', 'Contactos']) { await clickNav(label); await sleep(80); s = await state(); t(`datos basura: ${label} sin errores`, !s.secErr.length, s); }
await clickNav('Trabajos'); await clickTab(2); await sleep(80);
t('datos basura: "trabajo"/"hecho" → Trabajos/Hecho, due inválido no se muestra', await page.evaluate(() => { const r = [...document.querySelectorAll('tr.r')].find((r) => /Alias trabajo/.test(r.textContent)); return !!r && /Hecho/.test(r.textContent) && /—/.test(r.textContent); }));
await clickNav('Resumen'); await clickTab(3); await sleep(400); s = await state();
t('datos basura: estadísticas sin errores', !s.secErr.length, s);
await page.unroute('**/api/items');
t('datos basura: 0 errores de página', errs.length === 0, errs);
await page.route('**/api/items', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"error":"no es lista"}' }));
await page.goto(URL, { waitUntil: 'networkidle' }); await sleep(500); s = await state();
t('API devuelve un objeto en vez de lista: aviso, sin pantalla en blanco', s.nav === 7 && /no devolvió una lista/.test(s.banner), s);
await page.unroute('**/api/items');

// 6. Un error dentro de una sección no tumba el resto (se fuerza un fallo en el gráfico semanal)
await page.goto(URL, { waitUntil: 'networkidle' }); await sleep(300);
await page.evaluate(() => { window.ResizeObserver = undefined; }); // no hace falta; el fallo se fuerza vía datos
await page.route('**/api/items', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'z', type: 'todo', title: 'ok', status: 'todo', updatedAt: { bad: true } }]) }));
await page.evaluate(() => document.getElementById('refresh').click()); await sleep(500); s = await state();
t('item con updatedAt objeto: se normaliza y nada falla', !s.secErr.length && s.kpis === 4, s);
await page.unroute('**/api/items');

// 7. Service worker: con el servidor apagado la carcasa cacheada muestra el aviso; al volver, se recupera sola
const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' });
page = await ctx2.newPage(); watch(page);
await page.goto(URL, { waitUntil: 'networkidle' });
const swReady = await page.evaluate(() => navigator.serviceWorker.ready.then(() => true).catch(() => false));
t('service worker registrado', swReady);
await page.reload({ waitUntil: 'networkidle' }); await sleep(300);
t('service worker controla la página', await page.evaluate(() => !!navigator.serviceWorker.controller));
t('solo existe la caché tablero-v3', JSON.stringify(await page.evaluate(() => caches.keys())) === '["tablero-v3"]', await page.evaluate(() => caches.keys()));
await stopServer();
await page.reload({ waitUntil: 'load' }); await sleep(800); s = await state();
t('servidor apagado + SW: carcasa y última lista desde caché, nav completo y aviso de servidor caído (no pantalla en blanco)', s.nav === 7 && s.date && s.kpis === 4 && /No se puede conectar con el servidor/.test(s.banner) && /última copia guardada/.test(s.banner), s);
t('servidor apagado: 0 errores de página', errs.length === 0, errs);
await startServer();
await sleep(6000); s = await state();
t('servidor vuelve: reintento automático carga los datos y quita el aviso', !s.banner && s.kpis === 4 && s.areas === 8, s);
await page.reload({ waitUntil: 'networkidle' }); await sleep(300);
t('con red, la navegación llega al servidor (no a la caché vieja): /api/meta responde el build de la página', await page.evaluate(() => fetch('/api/meta').then((r) => r.json()).then((m) => m.build === document.documentElement.getAttribute('data-build'))));

await stopServer();
await browser.close();
rmSync(root, { recursive: true, force: true });
console.log(`${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
