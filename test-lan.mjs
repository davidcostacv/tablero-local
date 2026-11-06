// test-lan.mjs — pruebas del modo red local: token, cookie, límite de intentos, Host, loopback. node test-lan.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } };
const lanIp = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
if (!lanIp) { console.log('sin interfaz de red no-loopback: no se puede probar el modo LAN'); process.exit(0); }
const PORT = 4877 + Math.floor(Math.random() * 100), dir = mkdtempSync(join(tmpdir(), 'lan-test-'));
const srv = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, env: { ...process.env, HOST: '0.0.0.0', PORT: String(PORT), DATA_DIR: dir, NO_QR: '1', NOTIFY_OFF: '1', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d));
// Esperar también a las URLs /login?token= (llegan en otro trozo de stdout) y no esperar para siempre si el servidor no arranca.
await new Promise((r, j) => { const t0 = Date.now(); const i = setInterval(() => { if (/Tablero en/.test(out) && /\/login\?token=/.test(out)) { clearInterval(i); r(); } else if (Date.now() - t0 > 15000) { clearInterval(i); srv.kill(); j(new Error('el servidor no arrancó en 15 s:\n' + out)); } }, 50); });
const token = readFileSync(join(dir, 'token.txt'), 'utf8').trim();
const LAN = `http://${lanIp.address}:${PORT}`, LOCAL = `http://127.0.0.1:${PORT}`;
const f = (url, init) => fetch(url, { redirect: 'manual', ...init });

t('token generado (32 hex) y mostrado con URL /login', /^[a-f0-9]{32}$/.test(token) && out.includes(`${LAN}/login?token=${token}`), { token, out: out.slice(0, 300) });
t('loopback sin token: 200', (await f(`${LOCAL}/api/items`)).status === 200);
t('loopback página: 200', (await f(`${LOCAL}/`)).status === 200);
t('LAN sin token: 401 en API', (await f(`${LAN}/api/items`)).status === 401);
t('LAN sin token: 401 en la página', (await f(`${LAN}/`)).status === 401);
t('LAN con Bearer: 200', (await f(`${LAN}/api/items`, { headers: { Authorization: 'Bearer ' + token } })).status === 200);
t('LAN con Bearer malo: 401', (await f(`${LAN}/api/items`, { headers: { Authorization: 'Bearer ' + 'a'.repeat(32) } })).status === 401);
const login = await f(`${LAN}/login?token=${token}`);
const setCookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')])[0] || '';
const cookie = setCookie.split(';')[0];
t('login válido: 302 + cookie HttpOnly SameSite=Strict', login.status === 302 && /^dash=[a-f0-9]{32}$/.test(cookie) && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), setCookie);
t('LAN con cookie: 200 API y página', (await f(`${LAN}/api/items`, { headers: { Cookie: cookie } })).status === 200 && (await f(`${LAN}/`, { headers: { Cookie: cookie } })).status === 200);
// fetch ignora la cabecera Host: para probarla se usa http.request
const { request } = await import('node:http');
const withHost = (host) => new Promise((res) => { const r = request({ host: lanIp.address, port: PORT, path: '/api/items', headers: { Cookie: cookie, Host: host } }, (resp) => { resp.resume(); res(resp.statusCode); }); r.on('error', () => res(0)); r.end(); });
t('Host externo: 403', (await withHost('evil.com')) === 403);
t('Host IP privada: ok', (await withHost(`192.168.1.5:${PORT}`)) === 200);
t('Host *.ts.net: ok', (await withHost(`pc-de-casa.tail1234.ts.net:${PORT}`)) === 200);
t('Host IP propia: ok', (await withHost(`${lanIp.address}:${PORT}`)) === 200);
t('Host IP pública: 403', (await withHost(`8.8.8.8:${PORT}`)) === 403);
t('/qr desde LAN: 403', (await f(`${LAN}/qr`, { headers: { Cookie: cookie } })).status === 403);
const qr = await f(`${LOCAL}/qr`); const qrHtml = await qr.text();
t('/qr desde loopback: 200 con SVG y enlace', qr.status === 200 && /<svg/.test(qrHtml) && qrHtml.includes(`/login?token=${token}`));
t('escritura con cookie funciona (POST)', (await f(`${LAN}/api/items`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'todo', title: 'desde el teléfono' }) })).status === 200);
// límite de intentos: 5 logins malos -> 429
let codes = []; for (let i = 0; i < 6; i++) codes.push((await f(`${LAN}/login?token=malo${i}`)).status);
const first429 = codes.indexOf(429); // el Bearer malo de arriba ya contó como un intento fallido
t('intentos fallidos -> 403 y luego 429 (a partir del 5.º fallo)', first429 >= 3 && first429 <= 4 && codes.slice(0, first429).every((c) => c === 403) && codes.slice(first429).every((c) => c === 429), codes);
t('bloqueado también para la API con token bueno desde esa IP', (await f(`${LAN}/api/items`, { headers: { Cookie: cookie } })).status === 429);
t('loopback no afectado por el bloqueo', (await f(`${LOCAL}/api/items`)).status === 200);
t('el token no aparece en /api/meta', !(await (await f(`${LOCAL}/api/meta`)).text()).includes(token));
t('/api/meta identifica la app', (await (await f(`${LOCAL}/api/meta`)).json()).app === 'life-dashboard');
// puerto ocupado: por este mismo tablero -> abre y sale 0; por otra cosa -> mensaje con comandos del shell de la plataforma
const run = (code, env) => new Promise((res) => { const p = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: import.meta.dirname, env: { ...process.env, NOTIFY_OFF: '1', OPEN_BROWSER: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); let o = '', e = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e += d)); p.on('close', (c) => res({ code: c, out: o, err: e })); });
const second = await run("import('./server.mjs')", { PORT: String(PORT), DATA_DIR: dir });
t('segundo tablero en el mismo puerto: sale 0 y avisa que ya está abierto', second.code === 0 && second.out.includes(`ya está abierto en http://localhost:${PORT}`), second);
const other = createServer(() => {}); await new Promise((r) => other.listen(0, '127.0.0.1', r)); const busy = other.address().port;
const asWin = await run("Object.defineProperty(process, 'platform', { value: 'win32' }); import('./server.mjs')", { PORT: String(busy), DATA_DIR: dir });
t('puerto ocupado por otra cosa (win32): sale 1 con comandos PowerShell', asWin.code === 1 && asWin.err.includes(`El puerto ${busy} ya está en uso`) && asWin.err.includes(`Get-NetTCPConnection -LocalPort ${busy} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`) && asWin.err.includes(`$env:PORT="5000"; node server.mjs`) && !asWin.err.includes('PORT=5000 node'), asWin);
const asNix = await run("Object.defineProperty(process, 'platform', { value: 'linux' }); import('./server.mjs')", { PORT: String(busy), DATA_DIR: dir });
t('puerto ocupado por otra cosa (linux): sale 1 con la forma bash', asNix.code === 1 && asNix.err.includes(`El puerto ${busy} ya está en uso`) && asNix.err.includes('PORT=5000 node server.mjs') && !asNix.err.includes('$env:'), asNix);
// la función pura, en otro proceso (importar server.mjs también arranca un servidor; aquí en un puerto libre y se sale enseguida)
const pure = await run("const { portInUseMessage: m } = await import('./server.mjs'); console.log(JSON.stringify([m(5000, 'win32'), m(4747, 'darwin')])); process.exit(0)", { PORT: String(PORT + 200), DATA_DIR: dir });
const [w, d] = pure.code === 0 ? JSON.parse(pure.out.trim().split('\n').pop()) : ['', ''];
t('portInUseMessage: usa el puerto real y evita sugerir el mismo', w.includes('-LocalPort 5000 ') && w.includes('$env:PORT="5001"') && d === 'El puerto 4747 ya está en uso (¿otro tablero abierto?). Cierra esa ventana o usa otro puerto: PORT=5000 node server.mjs', pure);
other.close();
srv.kill(); rmSync(dir, { recursive: true, force: true });
console.log(`${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
