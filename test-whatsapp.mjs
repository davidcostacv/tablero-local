// test-whatsapp.mjs — pruebas del importador de chats de WhatsApp: node test-whatsapp.mjs
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wa-test-'));
process.env.DATA_DIR = dir;
const { upsertMany, load, clean } = await import('./store.mjs');
const { parseChat, extractTodos, importWhatsApp, chatContactName } = await import('./whatsapp.mjs');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };

// Android (es, con BOM, a. m./p. m. con espacio estrecho, multilínea)
const android = '﻿3/11/26, 9:15 a. m. - Carlos: Hola Juan! Mañana te mando la propuesta\n3/11/26, 9:16 p. m. - Juan Pérez: El viernes te pago el anticipo\n3/11/26, 10:05 a. m. - Juan Pérez: Necesito la factura,\nes urgente porque cierra el 15/11\n3/11/26, 10:06 a. m. - Juan Pérez: <Multimedia omitido>\n3/11/26, 10:07 a. m. - Carlos: ok\n';
let msgs = parseChat(android);
t('android: 5 mensajes', msgs.length === 5, msgs.map((m) => m.text));
t('android: fecha d/m/y e iso', msgs[0].iso === '2026-11-03' && msgs[0].time === '09:15', msgs[0]);
t('android: p. m. -> 21:16', msgs[1].time === '21:16', msgs[1]);
t('android: multilínea unida', /factura,\nes urgente/.test(msgs[2].text), msgs[2].text);
t('android: remitente con tilde', msgs[1].sender === 'Juan Pérez', msgs[1].sender);
let todos = extractTodos(msgs, { chat: 'Chat de WhatsApp con Juan Pérez' });
t('extrae 3 compromisos (no "ok", no multimedia)', todos.length === 3, todos.map((x) => x.title));
t('"mañana" relativo al mensaje (3/11 -> 4/11)', todos[0].due === '2026-11-04' && /Mañana te mando la propuesta/.test(todos[0].title), todos[0]);
t('"el viernes" relativo al mensaje (3/11 martes -> 6/11)', todos[1].due === '2026-11-06', todos[1]);
t('"15/11" con año del mensaje + urgente -> alta', todos[2].due === '2026-11-15' && todos[2].priority === 'high', todos[2]);
t('contacto desde el nombre del chat', todos[0].contact && todos[0].contact.name === 'Juan Pérez', todos[0].contact);
t('source whatsapp con ref única', todos[0].source.kind === 'whatsapp' && /#2026-11-03T09:15#Carlos$/.test(todos[0].source.ref), todos[0].source);

// iOS (en, m/d/y con segundos, corchetes)
const ios = '[11/03/26, 21:15:30] Juan: Don\'t forget to send the invoice tomorrow\n[11/03/26, 21:16:02] Carlos: sure\n[11/15/26, 08:00:00] Juan: Pago pendiente de la factura 123\n';
msgs = parseChat(ios);
t('ios: 3 mensajes', msgs.length === 3, msgs);
t('ios: detecta m/d/y por 11/15', msgs[2].iso === '2026-11-15' && msgs[0].iso === '2026-11-03', msgs.map((m) => m.iso));
t('ios: hora con segundos', msgs[0].time === '21:15', msgs[0]);
todos = extractTodos(msgs, { contact: 'Juan', phone: '+57 300 123 4567' });
t('ios: compromiso "pago pendiente" con contacto y teléfono', todos.some((x) => /Pago pendiente/.test(x.title) && x.contact.name === 'Juan' && x.contact.phone === '+57 300 123 4567'), todos);

// archivo de ejemplo + dedupe
const sample = readFileSync(new URL('./docs/samples/whatsapp-ejemplo.txt', import.meta.url), 'utf8');
const r = importWhatsApp(sample, { chat: 'Chat de WhatsApp con Juan Pérez', phone: '+573001234567' });
t('ejemplo: 11 mensajes de 2 personas (sin el aviso del sistema)', r.messages === 11 && r.senders.length === 2, { m: r.messages, s: r.senders });
t('ejemplo: quita saludo y muletilla del título', r.todos[0].title === 'Mañana te mando la propuesta con el presupuesto', r.todos[0].title);
t('ejemplo: entre 5 y 7 compromisos', r.todos.length >= 5 && r.todos.length <= 7, r.todos.map((x) => x.title));
t('ejemplo: "la próxima semana" relativo', r.todos.some((x) => /visita al taller/.test(x.title) && x.due === '2026-11-10'), r.todos.filter((x) => /visita/.test(x.title)));
t('ejemplo: "el jueves" relativo al 4/11 -> 5/11', r.todos.some((x) => /reunión/.test(x.title) && x.due === '2026-11-05'), r.todos.filter((x) => /reuni/.test(x.title)));
const a = upsertMany(r.todos), b = upsertMany(r.todos);
t('dedupe: segunda importación 0 nuevos', a.every((x) => x.created) && b.every((x) => !x.created) && load().length === r.todos.length, { a: a.length, b: b.filter((x) => x.created).length });
t('teléfono normalizado E.164 en store', load()[0].contact.phone === '+573001234567', load()[0].contact);
const r2 = importWhatsApp(sample, { chat: 'whatsapp-ejemplo', me: 'Carlos' });
t('me: el contacto es el otro participante', r2.todos.length && r2.todos.every((x) => x.contact.name === 'Juan Pérez'), r2.todos.map((x) => x.contact.name));
t('chatContactName', chatContactName('Chat de WhatsApp con Ana María.txt') === 'Ana María' && chatContactName('WhatsApp Chat with Bob') === 'Bob');
t('store: teléfono inválido se descarta, nombre queda', JSON.stringify(clean({ type: 'todo', title: 'x', contact: { name: 'Ana', phone: '12345' } }).contact) === '{"name":"Ana"}');
t('store: contacto vacío no se guarda', !clean({ type: 'todo', title: 'x', contact: { phone: 'abc' } }).contact);

rmSync(dir, { recursive: true, force: true });
console.log(`${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
