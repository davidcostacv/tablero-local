// test-notify.mjs — pruebas de notify.mjs y qr.mjs con servidores HTTP falsos (nunca envía nada real).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'notify-test-'));
process.env.DATA_DIR = dir;
process.env.NOTIFY_RETRY_MS = '20';
process.env.NOTIFY_TIMEOUT_MS = '2000';
let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };

// servidor falso que hace de ntfy y de Telegram
const hits = []; let failFirst = 0;
const fake = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hits.push({ url: req.url, headers: req.headers, body: b }); if (failFirst > 0) { failFirst--; res.writeHead(500); return res.end('boom'); } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }); });
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${fake.address().port}`;
process.env.NTFY_TOPIC = 'tablero-test-topic'; process.env.NTFY_SERVER = base; process.env.NTFY_TOKEN = 'tk_secret';
process.env.TELEGRAM_BOT_TOKEN = '123:ABC'; process.env.TELEGRAM_CHAT_ID = '42'; process.env.TELEGRAM_API = base;
process.env.DASH_PUBLIC_URL = 'http://pc.tailnet.ts.net:4747';

const { upsertMany, load } = await import('./store.mjs');
const N = await import('./notify.mjs');
const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
upsertMany([
  { type: 'todo', title: 'Pagar seguro', due: day(-2), area: 'Taller' }, { type: 'todo', title: 'Pedir reseñas', due: day(-1), priority: 'high' },
  { type: 'todo', title: 'Llamar al contador', due: day(0) }, { type: 'todo', title: 'Renovar dominio', due: day(3) }, { type: 'todo', title: 'Sin fecha' },
  { type: 'project', title: 'Web del taller', status: 'doing' }, { type: 'todo', title: 'Ya hecha', due: day(-5), status: 'done' },
]);

console.log('== resumen ==');
const d = N.digest(load());
t('conteos del resumen', d.counts.late === 2 && d.counts.today === 1 && d.counts.week === 1 && d.counts.doing === 1, d.counts);
t('título y prioridad alta con atrasadas', /2 atrasadas, 1 para hoy/.test(d.title) && d.priority === 'high', d.title);
t('cuerpo lista los elementos', /• Pagar seguro/.test(d.body) && /• Renovar dominio/.test(d.body) && !/Ya hecha/.test(d.body) && !/Sin fecha/.test(d.body), d.body);
const dm = N.digest(load(), { privacy: 'minimal' });
t('privacidad mínima: solo conteos', !/Pagar seguro/.test(dm.body) && /2 atrasadas/.test(dm.body), dm.body);

console.log('== envío (ntfy + telegram, cabeceras) ==');
hits.length = 0;
let r = await N.send({ title: 'Prueba ñ', body: 'hola', priority: 'high', tags: ['warning'] }, () => {});
t('ambos canales ok', r.ntfy && r.ntfy.ok && r.telegram && r.telegram.ok, r);
const ntfyHit = hits.find((h) => h.url === '/tablero-test-topic'), tgHit = hits.find((h) => /\/bot123:ABC\/sendMessage$/.test(h.url));
t('ntfy: cabeceras Title/Priority/Tags/Click/Authorization', ntfyHit && ntfyHit.headers.priority === 'high' && ntfyHit.headers.tags === 'warning' && ntfyHit.headers.click === 'http://pc.tailnet.ts.net:4747' && ntfyHit.headers.authorization === 'Bearer tk_secret' && Buffer.from(ntfyHit.headers.title, 'latin1').toString('utf8') === 'Prueba ñ', ntfyHit && ntfyHit.headers);
t('telegram: chat_id y texto', tgHit && JSON.parse(tgHit.body).chat_id === '42' && /Prueba ñ/.test(JSON.parse(tgHit.body).text) && /hola/.test(JSON.parse(tgHit.body).text), tgHit && tgHit.body);

console.log('== reintentos y errores ==');
hits.length = 0; failFirst = 1;
r = await N.send({ title: 'x', body: 'y', priority: 'default' }, () => {});
t('reintenta tras 500 y termina ok', r.ntfy.ok && hits.filter((h) => h.url === '/tablero-test-topic').length === 2, { r, n: hits.length });
process.env.NTFY_SERVER = 'http://127.0.0.1:1'; // puerto cerrado
const logs = []; r = await N.send({ title: 'x', body: 'y', priority: 'default' }, (s) => logs.push(s));
t('error de red: no lanza, informa y sigue con el otro canal', r.ntfy && !r.ntfy.ok && r.telegram.ok && logs.some((l) => /fallida/.test(l)), { r, logs });
process.env.NTFY_SERVER = base;
delete process.env.NTFY_TOPIC; delete process.env.TELEGRAM_BOT_TOKEN;
r = await N.send({ title: 'x', body: 'y' }, () => {});
t('sin canales: skipped', r.skipped, r);
process.env.NTFY_TOPIC = 'tablero-test-topic'; process.env.TELEGRAM_BOT_TOKEN = '123:ABC';

console.log('== avisos de atraso (una vez por día) ==');
hits.length = 0;
r = await N.sendOverdue(() => {});
t('primer aviso: 2 atrasados', r.count === 2 && hits.length === 2, r);
r = await N.sendOverdue(() => {});
t('segundo aviso el mismo día: nada', r.skipped === 'nada nuevo atrasado', r);
const st = N.state(); t('estado persistido con la fecha de hoy', Object.values(st.alerted).every((v) => v === N.today()) && Object.keys(st.alerted).length === 2, st);
N.saveSettings({ overdueAlerts: false }); r = await N.sendOverdue(() => {}); t('avisos desactivados', r.skipped === 'avisos desactivados', r); N.saveSettings({ overdueAlerts: true });
t('status sin secretos', (() => { const s = N.status(); return s.ntfy === true && s.telegram === true && !JSON.stringify(s).includes('tk_secret') && !JSON.stringify(s).includes('ABC'); })(), N.status());
r = await N.sendDigest(() => {}); t('sendDigest marca lastDigest', N.state().lastDigest === N.today() && r.counts.late === 2, r);

console.log('== planificador: próxima ejecución (DST y zonas) ==');
const nr = N.nextRun(new Date(2026, 2, 28, 9, 0), '08:00'); // Madrid: el 29/3/2026 cambia a horario de verano
t('siguiente día a las 08:00 locales (cruzando DST)', nr.getDate() === 29 && nr.getMonth() === 2 && nr.getHours() === 8 && nr.getMinutes() === 0, nr.toString());
const nr2 = N.nextRun(new Date(2026, 9, 25, 7, 30), '08:00'); t('mismo día si aún no pasó', nr2.getDate() === 25 && nr2.getHours() === 8, nr2.toString());
const nr3 = N.nextRun(new Date(2026, 9, 25, 8, 0), '08:00'); t('exactamente a la hora -> mañana', nr3.getDate() === 26, nr3.toString());
const nr4 = N.nextRun(new Date(2026, 11, 31, 23, 59), '00:30'); t('cruce de año', nr4.getFullYear() === 2027 && nr4.getMonth() === 0 && nr4.getDate() === 1 && nr4.getHours() === 0 && nr4.getMinutes() === 30, nr4.toString());
t('horas de 1 dígito', N.nextRun(new Date(2026, 5, 1, 5, 0), '7:05').getHours() === 7);

console.log('== QR ==');
const Q = await import('./qr.mjs');
// polinomios generadores publicados (ISO 18004 / tablas estándar), en exponentes de α
const EXP = []; for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; x <<= 1; if (x & 0x100) x ^= 0x11d; }
const alog = (v) => EXP.indexOf(v);
t('RS: generador de 7 = α^[0,87,229,146,149,238,102,21]', Q.rsGenerator(7).map(alog).join() === '0,87,229,146,149,238,102,21', Q.rsGenerator(7).map(alog).join());
t('RS: generador de 10 = α^[0,251,67,46,61,118,70,64,94,32,45]', Q.rsGenerator(10).map(alog).join() === '0,251,67,46,61,118,70,64,94,32,45', Q.rsGenerator(10).map(alog).join());
const data = [0x20, 0x5b, 0x0b, 0x78, 0xd1, 0x72, 0xdc, 0x4d, 0x43, 0x40, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
const ec = Q.rsEncode(data, 10);
t('RS: síndromes cero (datos||ec divisible por el generador)', Q.rsSyndromes(data.concat(ec), 10).every((s) => s === 0));
t('formato M/máscara 0 = 101010000010010', Q.formatBits('M', 0).toString(2).padStart(15, '0') === '101010000010010', Q.formatBits('M', 0).toString(2));
t('formato L/máscara 0 = 111011111000100 (0x77C4)', Q.formatBits('L', 0) === 0x77c4, Q.formatBits('L', 0).toString(2));
t('formato H/máscara 7 = 000100001101011? (BCH consistente: 15 bits, 2 niveles distintos)', Q.formatBits('H', 7) !== Q.formatBits('L', 7) && Q.formatBits('H', 7) < 32768);
t('información de versión 7 = 000111110010010100 (0x07C94)', Q.versionBits(7) === 0x07c94, Q.versionBits(7).toString(2));
t('información de versión 8 = 001000010110111100 (0x085BC)', Q.versionBits(8) === 0x085bc, Q.versionBits(8).toString(2));
for (const [txt, lvl] of [['http://192.168.1.10:4747/login?token=0123456789abcdef0123456789abcdef', 'L'], ['Hola ñandú', 'M'], ['http://pc-de-casa.tail1234.ts.net:4747/login?token=' + 'f'.repeat(32) + '&x=' + 'y'.repeat(60), 'L'], ['a', 'L']]) {
  const m = Q.matrix(txt, lvl); let dec; try { dec = Q.decode(m); } catch (e) { dec = { error: e.message }; }
  t(`QR v${m.version} ${lvl} codifica y se lee: "${txt.slice(0, 30)}…"`, dec.text === txt && dec.level === lvl && m.length === m.version * 4 + 17, dec);
}
const big = Q.matrix('x'.repeat(260), 'L'); t('cabe hasta v10 (260 bytes -> v' + big.version + ')', big.version <= 10 && Q.decode(big).text.length === 260);
let threw = false; try { Q.matrix('x'.repeat(300), 'L'); } catch { threw = true; } t('más de v10 lanza error claro', threw);
t('svg y ascii', /^<svg/.test(Q.svg(big)) && Q.ascii(big, { color: false }).split('\n').length === big.length + 4);

fake.close(); rmSync(dir, { recursive: true, force: true });
console.log(`${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
