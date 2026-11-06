// notify.mjs — notificaciones gratuitas sin dependencias: ntfy y/o Telegram, resumen diario y avisos de atraso.
// Lo usa server.mjs (planificador interno) y se puede correr solo: node notify.mjs --test | --digest | --status | --new-topic
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { load, DATA_DIR } from './store.mjs';
import { readSettings, saveSettings as saveAll } from './settings.mjs';

const E = process.env;
export const config = () => ({
  ntfy: E.NTFY_TOPIC ? { topic: E.NTFY_TOPIC, server: (E.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, ''), token: E.NTFY_TOKEN || '' } : null,
  telegram: E.TELEGRAM_BOT_TOKEN && E.TELEGRAM_CHAT_ID ? { token: E.TELEGRAM_BOT_TOKEN, chatId: E.TELEGRAM_CHAT_ID, api: (E.TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '') } : null,
  digestHour: /^\d{1,2}:\d{2}$/.test(E.NOTIFY_DIGEST_HOUR || '') ? E.NOTIFY_DIGEST_HOUR : '08:00',
  privacy: E.NOTIFY_PRIVACY === 'minimal' ? 'minimal' : 'full',
  publicUrl: E.DASH_PUBLIC_URL || '',
  retryMs: Number(E.NOTIFY_RETRY_MS) || 800,
  timeoutMs: Number(E.NOTIFY_TIMEOUT_MS) || 8000,
});
// Solo booleanos: nunca se exponen secretos al navegador.
export const status = () => { const c = config(); return { ntfy: !!c.ntfy, telegram: !!c.telegram, digestHour: c.digestHour, privacy: c.privacy, nextDigest: nextRun(new Date(), c.digestHour).toISOString(), overdueAlerts: settings().overdueAlerts }; };

// ---------- estado y ajustes (en DATA_DIR, nunca se versionan) ----------
const file = (n) => join(DATA_DIR, n);
const readJson = (n, def) => { try { return { ...def, ...JSON.parse(readFileSync(file(n), 'utf8')) }; } catch { return { ...def }; } };
const writeJson = (n, v) => { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(file(n), JSON.stringify(v, null, 1)); };
export const state = () => readJson('notify-state.json', { lastDigest: '', alerted: {} });
export const saveState = (s) => writeJson('notify-state.json', s);
// settings.json lo comparte con el vault y el puerto (settings.mjs); aquí solo interesa overdueAlerts.
export const settings = () => readSettings();
export const saveSettings = (s) => saveAll(s);

// ---------- fechas ----------
const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
export const today = () => iso(new Date());
// Próxima ocurrencia local de HH:MM a partir de `now` (si ya pasó hoy, mañana). Usa hora local, así respeta el DST.
export function nextRun(now, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

// ---------- contenido ----------
const isOpen = (i) => i.status !== 'done';
const fmt = (s) => { const d = new Date(s + 'T00:00:00'); return d.toLocaleDateString('es', { day: 'numeric', month: 'short' }).replace('.', ''); };
const line = (i, privacy) => (privacy === 'minimal' ? '' : `• ${i.title}${i.due ? ' (' + fmt(i.due) + ')' : ''}`);
export function digest(items, { privacy = 'full', when = new Date() } = {}) {
  const t = iso(when), wk = iso(new Date(when.getFullYear(), when.getMonth(), when.getDate() + 7));
  const open = items.filter(isOpen), late = open.filter((i) => i.due && i.due < t), hoy = open.filter((i) => i.due === t), week = open.filter((i) => i.due && i.due > t && i.due <= wk);
  const doing = open.filter((i) => i.status === 'doing' && i.type !== 'todo').length;
  const parts = [`${late.length} atrasadas · ${hoy.length} para hoy · ${week.length} esta semana · ${doing} en curso`];
  if (privacy !== 'minimal') {
    const top = [...late.sort((a, b) => a.due.localeCompare(b.due)), ...hoy, ...week.sort((a, b) => a.due.localeCompare(b.due))].slice(0, 8);
    if (top.length) parts.push('', ...top.map((i) => line(i, privacy)));
  }
  const title = late.length ? `Tablero: ${late.length} atrasada${late.length === 1 ? '' : 's'}, ${hoy.length} para hoy` : `Tablero: ${hoy.length} para hoy`;
  return { title, body: parts.join('\n'), priority: late.length ? 'high' : 'default', tags: late.length ? ['warning'] : ['calendar'], counts: { late: late.length, today: hoy.length, week: week.length, doing } };
}
// Elementos atrasados de los que todavía no se avisó hoy.
export function overdueToAlert(items, st, t = today()) { return items.filter((i) => isOpen(i) && i.due && i.due < t && st.alerted[i.id] !== t); }
export function overdueMessage(items, privacy) { return { title: `Tablero: ${items.length} ${items.length === 1 ? 'elemento atrasado' : 'elementos atrasados'}`, body: privacy === 'minimal' ? `${items.length} con fecha vencida` : items.slice(0, 10).map((i) => `• ${i.title} (${fmt(i.due)})`).join('\n'), priority: 'high', tags: ['rotating_light'] }; }

// ---------- envío ----------
async function post(url, init, { retryMs, timeoutMs }, log) {
  let last;
  for (let i = 0; i <= 2; i++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return { ok: true, status: r.status };
      last = `HTTP ${r.status}`;
      if (r.status < 500 && r.status !== 429) return { ok: false, error: last };
    } catch (e) { last = e.name === 'TimeoutError' ? 'timeout' : (e.cause && e.cause.code) || e.message; }
    if (i < 2) await new Promise((res) => setTimeout(res, retryMs * (i + 1)));
  }
  log(`notificación fallida (${last})`);
  return { ok: false, error: last };
}
// msg: { title, body, priority: 'high'|'default', tags: [] }. Nunca lanza; devuelve el resultado por canal.
export async function send(msg, log = (s) => console.error('[notify] ' + s)) {
  const c = config(), out = {};
  if (!c.ntfy && !c.telegram) return { skipped: 'sin canales configurados' };
  if (c.ntfy) {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', Title: Buffer.from(msg.title, 'utf8').toString('latin1'), Priority: msg.priority === 'high' ? 'high' : 'default', Tags: (msg.tags || []).join(',') };
    if (c.publicUrl) headers.Click = c.publicUrl;
    if (c.ntfy.token) headers.Authorization = 'Bearer ' + c.ntfy.token;
    out.ntfy = await post(`${c.ntfy.server}/${encodeURIComponent(c.ntfy.topic)}`, { method: 'POST', headers, body: msg.body }, c, log);
  }
  if (c.telegram) {
    const text = `*${msg.title.replace(/[_*`[]/g, '')}*\n${msg.body}${c.publicUrl ? '\n' + c.publicUrl : ''}`;
    out.telegram = await post(`${c.telegram.api}/bot${c.telegram.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: c.telegram.chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }) }, c, log);
  }
  return out;
}
export async function sendDigest(log) { const d = digest(load(), { privacy: config().privacy }); const r = await send(d, log); const s = state(); s.lastDigest = today(); saveState(s); return { ...r, counts: d.counts }; }
export async function sendOverdue(log) {
  if (!settings().overdueAlerts) return { skipped: 'avisos desactivados' };
  const s = state(), items = overdueToAlert(load(), s);
  if (!items.length) return { skipped: 'nada nuevo atrasado' };
  const r = await send(overdueMessage(items, config().privacy), log);
  if (!r.skipped) { items.forEach((i) => { s.alerted[i.id] = today(); }); saveState(s); }
  return { ...r, count: items.length };
}

// ---------- planificador (dentro del servidor; sin cron) ----------
export function start(log = (s) => console.log('[notify] ' + s)) {
  const c = config();
  if (!c.ntfy && !c.telegram) { log('sin canales: configura NTFY_TOPIC o TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID'); return null; }
  let last = 0;
  const tick = async () => {
    const now = new Date();
    if (state().lastDigest !== today() && now >= nextRun(new Date(now.getTime() - 86400000), c.digestHour) && now.getHours() * 60 + now.getMinutes() >= Number(c.digestHour.split(':')[0]) * 60 + Number(c.digestHour.split(':')[1])) {
      const r = await sendDigest(log); log(`resumen diario enviado (${JSON.stringify(r.counts || r)})`);
    }
    if (now.getTime() - last >= 5 * 60000) { last = now.getTime(); const r = await sendOverdue(log); if (r.count) log(`aviso de ${r.count} atrasados`); }
  };
  const timer = setInterval(() => tick().catch((e) => log('error: ' + e.message)), 60000);
  timer.unref();
  tick().catch((e) => log('error: ' + e.message));
  log(`canales: ${[c.ntfy && 'ntfy', c.telegram && 'telegram'].filter(Boolean).join(', ')} · resumen diario a las ${c.digestHour} · próximo: ${nextRun(new Date(), c.digestHour).toLocaleString('es')}`);
  return { stop: () => clearInterval(timer), next: () => nextRun(new Date(), c.digestHour) };
}

// ---------- CLI ----------
if (/^notify\.mjs$/.test((process.argv[1] || '').split(/[\\/]/).pop())) {
  const arg = process.argv[2];
  const log = (s) => console.log('[notify] ' + s);
  if (arg === '--new-topic') console.log('tablero-' + randomBytes(16).toString('hex'));
  else if (arg === '--status') console.log(JSON.stringify(status(), null, 1));
  else if (arg === '--test') send({ title: 'Tablero: prueba', body: 'Las notificaciones funcionan.', priority: 'default', tags: ['white_check_mark'] }, log).then((r) => console.log(JSON.stringify(r)));
  else if (arg === '--digest') sendDigest(log).then((r) => console.log(JSON.stringify(r)));
  else if (arg === '--overdue') sendOverdue(log).then((r) => console.log(JSON.stringify(r)));
  else console.log('uso: node notify.mjs --test | --digest | --overdue | --status | --new-topic');
}
