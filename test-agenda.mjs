// test-agenda.mjs — Agenda: fechas, regla de las diarias, API REST, imágenes y CLI. node test-agenda.mjs
// Usa un DATA_DIR temporal y un puerto aleatorio: no toca tus datos ni el tablero que esté corriendo.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } };
const dir = mkdtempSync(join(tmpdir(), 'agenda-test-'));
process.env.DATA_DIR = dir; process.env.AGENDA_TODAY = '2026-11-05'; // jueves
const A = await import('./agenda.mjs');

console.log('== fechas ==');
t('hoy / manana / mañana / pasado', A.parseDate('hoy') === '2026-11-05' && A.parseDate('manana') === '2026-11-06' && A.parseDate('mañana') === '2026-11-06' && A.parseDate('pasado') === '2026-11-07');
t('viernes (jueves 5) → 6; jueves → el de la semana que viene (12); Miércoles → 11', A.parseDate('viernes') === '2026-11-06' && A.parseDate('jueves') === '2026-11-12' && A.parseDate('Miércoles') === '2026-11-11');
t('YYYY-MM-DD válido; 2026-02-30 no; "sin" → null', A.parseDate('2026-12-24') === '2026-12-24' && A.parseDate('sin') === null && (() => { try { A.parseDate('2026-02-30'); return false; } catch { return true; } })());
t('burós: TU,eq,Experian → orden canónico', JSON.stringify(A.parseBureaus('EX,tu,Equifax')) === '["TransUnion","Equifax","Experian"]');
t('buró desconocido → error', (() => { try { A.parseBureaus('XX'); return false; } catch { return true; } })());
t('zona por defecto: la del PC', (delete process.env.AGENDA_TZ, A.timezone() === (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')));
t('"hoy" en Nueva York ≠ UTC a las 23:30 NY', A.dayIn('America/New_York', new Date('2026-11-05T04:30:00Z')) === '2026-11-04');

console.log('== modelo y reglas ==');
const d = A.add({ title: 'Estudiar', daily: true, category: 'estudio', id: 'estudiar' });
t('diaria: date null, done false, lastDone null', d.date === null && d.done === false && d.lastDone === null && d.daily === true);
A.patch('estudiar', { done: true });
t('diaria marcada hoy: lastDone = hoy, cuenta como hecha hoy', A.load()[0].lastDone === '2026-11-05' && A.isDone(A.load()[0], '2026-11-05'));
t('diaria: mañana vuelve a estar pendiente', !A.isDone(A.load()[0], '2026-11-06'));
A.add({ title: 'Viejo', date: '2026-11-01', id: 'viejo' });
A.add({ title: 'Hoy cosa', date: 'hoy', client: 'Ana', bureaus: 'EQ', id: 'hoy-cosa' });
A.add({ title: 'Pronto', date: '2026-11-07', id: 'pronto' });
A.add({ title: 'Lejos', date: '2026-11-20', id: 'lejos' });
A.add({ title: 'Sin', id: 'sin' });
let g = A.groups(A.load());
t('grupos: atrasado, hoy (diaria + fecha), próximos, sin fecha', g.late.map((x) => x.id).join() === 'viejo' && g.today.map((x) => x.id).sort().join() === 'estudiar,hoy-cosa' && g.upcoming.map((x) => x.id).join() === 'pronto,lejos' && g.undated.map((x) => x.id).join() === 'sin');
A.patch('viejo', { done: true });
g = A.groups(A.load());
t('hecha normal: doneAt ISO y sale de Atrasado a Hechas', !g.late.length && g.done[0].id === 'viejo' && !isNaN(Date.parse(g.done[0].doneAt)));
t('categoría inválida → error', (() => { try { A.add({ title: 'x', category: 'otra' }); return false; } catch { return true; } })());
t('id repetido → 409', (() => { try { A.add({ title: 'x', id: 'sin' }); return false; } catch (e) { return e.code === 409; } })());
A.patch('viejo', { done: false });

console.log('== API ==');
const PORT = 4977 + Math.floor(Math.random() * 100);
const srv = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, env: { ...process.env, PORT: String(PORT), NOTIFY_OFF: '1', VAULT_SYNC_OFF: '1', LOG_OFF: '1', VAULT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', (x) => (out += x)); srv.stderr.on('data', (x) => (out += x));
const B = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100 && !/Tablero en/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
const j = (m, p, b) => fetch(B + p, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
try {
  let r = await j('GET', '/api/agenda');
  t('GET /api/agenda: today, tz y tareas', r.s === 200 && r.b.today === '2026-11-05' && r.b.tasks.length === 6, r);
  r = await j('POST', '/api/agenda', { title: 'Desde API', date: '2026-11-06', category: 'personal', client: 'Bea', bureaus: ['TransUnion', 'Equifax'], notes: 'hola' });
  const id = r.b && r.b.id;
  t('POST crea con id y created', r.s === 200 && id && r.b.created && r.b.bureaus.length === 2, r);
  t('POST sin título: 400', (await j('POST', '/api/agenda', { date: 'hoy' })).s === 400);
  t('POST sin JSON: 415', (await fetch(B + '/api/agenda', { method: 'POST', body: 'x' })).status === 415);
  r = await j('PATCH', '/api/agenda/' + id, { done: true, notes: 'editado' });
  t('PATCH done + notas', r.s === 200 && r.b.done && r.b.doneAt && r.b.notes === 'editado', r);
  t('PATCH inexistente: 404', (await j('PATCH', '/api/agenda/nope', { done: true })).s === 404);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex');
  r = await fetch(B + `/api/agenda/${id}/images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png }).then(async (x) => ({ s: x.status, b: await x.json() }));
  const img = r.b && r.b.images && r.b.images[0];
  t('POST imagen: guardada en data/agenda-img y asociada', r.s === 200 && /^data\/agenda-img\/.+\.png$/.test(img || '') && readdirSync(join(dir, 'agenda-img')).length === 1, r);
  const gi = await fetch(B + '/agenda-img/' + img.split('/').pop());
  t('GET /agenda-img/<archivo>: 200 image/png', gi.status === 200 && gi.headers.get('content-type') === 'image/png' && (await gi.arrayBuffer()).byteLength === png.length);
  t('imagen de tipo no permitido: 415', (await fetch(B + `/api/agenda/${id}/images`, { method: 'POST', headers: { 'Content-Type': 'text/html' }, body: 'x' })).status === 415);
  t('ruta de imagen con ../: 404', (await fetch(B + '/agenda-img/..%2Fagenda.json')).status === 404);
  r = await j('DELETE', '/api/agenda/' + id);
  t('DELETE borra la tarea y su imagen', r.s === 200 && readdirSync(join(dir, 'agenda-img')).length === 0 && !(await j('GET', '/api/agenda')).b.tasks.some((x) => x.id === id));
  // imagen dejada a mano con el id al inicio → se asocia sola en el siguiente GET
  writeFileSync(join(dir, 'agenda-img', 'hoy-cosa-1.png'), png);
  r = await j('GET', '/api/agenda');
  t('imagen suelta <id>-1.png se asocia sola', r.b.tasks.find((x) => x.id === 'hoy-cosa').images.includes('data/agenda-img/hoy-cosa-1.png'));
  t('la página incluye la vista Agenda', /function agendaView/.test(await (await fetch(B + '/')).text()));
} finally { srv.kill(); }

console.log('== CLI ==');
const cli = (...a) => spawnSync(process.execPath, ['scripts/agenda.mjs', ...a], { cwd: import.meta.dirname, env: process.env, encoding: 'utf8' });
let c = cli('add', 'Reporte de cliente 1', '--date', 'manana', '--cat', 'trabajo', '--client', 'Cliente 1', '--bureaus', 'EQ,TU');
t('CLI add con fecha "manana" y burós', c.status === 0 && /2026-11-06/.test(c.stdout) && A.load().some((x) => x.title === 'Reporte de cliente 1' && x.date === '2026-11-06' && x.bureaus.join() === 'TransUnion,Equifax'), c.stderr || c.stdout);
c = cli('add', 'X', '--date', 'nunca');
t('CLI fecha inválida: sale 1 con mensaje', c.status === 1 && /fecha no reconocida/.test(c.stderr));
c = cli('list');
t('CLI list muestra secciones', c.status === 0 && /Atrasado \(1\)/.test(c.stdout) && /Próximos días/.test(c.stdout));

rmSync(dir, { recursive: true, force: true });
console.log(`${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
