// agenda.mjs — Agenda / to-do list. Única capa que lee/escribe data/agenda.json.
// La usan server.mjs (API /api/agenda), scripts/agenda.mjs (CLI) y la skill dashboard.
// "Hoy" se calcula en la zona horaria de la agenda (configurable): AGENDA_TZ > settings.agendaTimezone >
// la zona horaria del PC.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from './store.mjs';
import { readSettings } from './settings.mjs';

export const FILE = () => join(DATA_DIR, 'agenda.json');
export const IMG_DIR = () => join(DATA_DIR, 'agenda-img');
export const CATEGORIES = ['trabajo', 'estudio', 'personal'];
export const BUREAUS = ['TransUnion', 'Equifax', 'Experian'];
export const BUREAU_SHORT = { TransUnion: 'TU', Equifax: 'EQ', Experian: 'EX' };
export const IMG_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMG_NAME = /^[\w.-]{1,120}\.(png|jpe?g|webp|gif)$/i;

// ---------- fechas en la zona de la agenda ----------
const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const validDate = (v) => typeof v === 'string' && YMD.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
export const dayIn = (tz, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export function timezone(now = new Date()) {
  if (process.env.AGENDA_TZ) return process.env.AGENDA_TZ;
  const s = readSettings();
  if (typeof s.agendaTimezone === 'string' && s.agendaTimezone) return s.agendaTimezone;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
// AGENDA_TODAY=YYYY-MM-DD fija "hoy" (pruebas).
export const today = (now = new Date()) => (validDate(process.env.AGENDA_TODAY) ? process.env.AGENDA_TODAY : dayIn(timezone(now), now));
export const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const weekday = (ymd) => new Date(ymd + 'T00:00:00Z').getUTCDay(); // 0 = domingo
export const longDate = (ymd) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('es', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
export const shortDate = (ymd) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('es', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');

const strip = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const DAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
// "hoy", "manana"/"mañana", "pasado"/"pasado-manana", un día de la semana (la PRÓXIMA ocurrencia, de 1 a 7 días:
// "viernes" dicho un viernes es el de la semana que viene), "sin"/"sin-fecha"/"none" (null) o YYYY-MM-DD.
export function parseDate(v, base = today()) {
  if (v === null || v === undefined || v === '') return null;
  const s = strip(v).replace(/\s+/g, '-');
  if (['sin', 'sin-fecha', 'none', 'null', 'nada'].includes(s)) return null;
  if (s === 'hoy' || s === 'today') return base;
  if (s === 'manana' || s === 'tomorrow') return addDays(base, 1);
  if (s === 'pasado' || s === 'pasado-manana') return addDays(base, 2);
  const wd = DAYS.indexOf(s.replace(/^(el|este|proximo)-/, ''));
  if (wd >= 0) { const diff = ((wd - weekday(base) + 7) % 7) || 7; return addDays(base, diff); }
  if (validDate(s)) return s;
  throw new Error(`fecha no reconocida: "${v}" (usa hoy, manana, un día como viernes, o YYYY-MM-DD)`);
}
export function parseBureaus(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s/+]+/) : [];
  const out = new Set();
  for (const b of list) {
    const k = strip(b);
    if (!k) continue;
    if (k === 'tu' || k.startsWith('trans')) out.add('TransUnion');
    else if (k === 'eq' || k.startsWith('equi')) out.add('Equifax');
    else if (k === 'ex' || k.startsWith('exp')) out.add('Experian');
    else throw new Error(`buró no reconocido: "${b}" (usa TU, EQ, EX)`);
  }
  return BUREAUS.filter((b) => out.has(b));
}

// ---------- validación ----------
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const slug = (s) => strip(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'tarea';
const isoOrNull = (v) => (typeof v === 'string' && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const imgPath = (p) => { const n = basename(String(p || '')); return IMG_NAME.test(n) ? 'data/agenda-img/' + n : null; };

export function clean(raw, base = today()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('tarea inválida');
  const title = str(raw.title, 200);
  if (!title) throw new Error('title requerido');
  const id = typeof raw.id === 'string' && /^[\w-]{1,60}$/.test(raw.id) ? raw.id : slug(title) + '-' + randomBytes(2).toString('hex');
  const category = raw.category == null || raw.category === '' ? 'trabajo' : strip(raw.category);
  if (!CATEGORIES.includes(category)) throw new Error(`category inválida: ${raw.category} (trabajo, estudio o personal)`);
  const daily = raw.daily === true;
  return {
    id, title,
    date: daily ? null : parseDate(raw.date, base),
    daily, category,
    client: str(raw.client, 80),
    bureaus: parseBureaus(raw.bureaus),
    done: daily ? false : raw.done === true,
    doneAt: daily ? null : raw.done === true ? isoOrNull(raw.doneAt) || new Date().toISOString() : null,
    lastDone: daily && validDate(raw.lastDone) ? raw.lastDone : null,
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 5000) : '',
    images: Array.isArray(raw.images) ? [...new Set(raw.images.map(imgPath).filter(Boolean))].slice(0, 20) : [],
    created: isoOrNull(raw.created) || new Date().toISOString(),
  };
}

// ---------- archivo ----------
export function load() {
  try { const a = JSON.parse(readFileSync(FILE(), 'utf8').replace(/^﻿/, '')); return Array.isArray(a) ? a : []; }
  catch (e) { if (e.code === 'ENOENT') return []; throw new Error('data/agenda.json no se pudo leer: ' + e.message); }
}
export function save(tasks) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE() + '.tmp';
  writeFileSync(tmp, JSON.stringify(tasks, null, 1));
  try { renameSync(tmp, FILE()); } catch { writeFileSync(FILE(), JSON.stringify(tasks, null, 1)); }
}
export const isDone = (t, day = today()) => (t.daily ? t.lastDone === day : !!t.done);

export function add(raw) {
  const tasks = load(), t = clean(raw);
  if (tasks.some((x) => x.id === t.id)) throw Object.assign(new Error(`ya existe una tarea con id ${t.id}`), { code: 409 });
  tasks.push(t); save(tasks); return t;
}
// Importar: crea las nuevas y actualiza las existentes (mismo id) conservando done/lastDone/imágenes/created.
export function upsertMany(list) {
  const tasks = load(), res = [];
  for (const raw of list) {
    const i = tasks.findIndex((x) => x.id === raw.id);
    if (i < 0) { const t = clean(raw); tasks.push(t); res.push({ task: t, created: true }); continue; }
    const prev = tasks[i];
    const t = clean({ ...prev, ...raw, done: prev.done, doneAt: prev.doneAt, lastDone: prev.lastDone, created: prev.created, images: [...(prev.images || []), ...(raw.images || [])] });
    tasks[i] = t; res.push({ task: t, created: false });
  }
  save(tasks); return res;
}
const EDITABLE = ['title', 'date', 'daily', 'category', 'client', 'bureaus', 'notes'];
export function patch(id, body, day = today()) {
  const tasks = load(), i = tasks.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const prev = tasks[i], next = { ...prev };
  for (const k of EDITABLE) if (k in body) next[k] = body[k];
  const t = clean(next, day);
  t.done = prev.daily && !t.daily ? false : t.daily ? false : prev.done; t.doneAt = t.daily ? null : prev.doneAt; t.lastDone = t.daily ? prev.lastDone || null : null;
  if ('done' in body) {
    const v = body.done === true;
    if (t.daily) t.lastDone = v ? day : t.lastDone === day ? null : t.lastDone;
    else { t.done = v; t.doneAt = v ? new Date().toISOString() : null; }
  }
  tasks[i] = t; save(tasks); return t;
}
export function remove(id) {
  const tasks = load(), t = tasks.find((x) => x.id === id);
  if (!t) return false;
  for (const p of t.images || []) { try { unlinkSync(join(IMG_DIR(), basename(p))); } catch {} }
  save(tasks.filter((x) => x.id !== id)); return true;
}

// ---------- imágenes ----------
export function addImage(id, buf, mime) {
  const ext = IMG_TYPES[mime];
  if (!ext) throw Object.assign(new Error('tipo de imagen no permitido (png, jpg, webp o gif)'), { code: 415 });
  const tasks = load(), t = tasks.find((x) => x.id === id);
  if (!t) return null;
  if (!existsSync(IMG_DIR())) mkdirSync(IMG_DIR(), { recursive: true });
  const name = `${id}-${Date.now().toString(36)}${randomBytes(2).toString('hex')}.${ext}`;
  writeFileSync(join(IMG_DIR(), name), buf);
  t.images = [...(t.images || []), 'data/agenda-img/' + name];
  save(tasks); return t;
}
export function removeImage(id, file) {
  const tasks = load(), t = tasks.find((x) => x.id === id), n = basename(String(file || ''));
  if (!t || !(t.images || []).includes('data/agenda-img/' + n)) return null;
  t.images = t.images.filter((p) => p !== 'data/agenda-img/' + n);
  try { unlinkSync(join(IMG_DIR(), n)); } catch {}
  save(tasks); return t;
}
// Imágenes dejadas a mano en data/agenda-img con el id de la tarea al inicio del nombre
// (ana-equifax-1.png, bea-experian-upload-2.jpg) se asocian solas. Devuelve cuántas asoció.
export function attachLooseImages() {
  let names; try { names = readdirSync(IMG_DIR()).filter((n) => IMG_NAME.test(n)); } catch { return 0; }
  const tasks = load(), used = new Set(tasks.flatMap((t) => t.images || []));
  const ids = tasks.map((t) => t.id).sort((a, b) => b.length - a.length); // el id más largo gana (ana-equifax antes que ana)
  let n = 0;
  for (const name of names) {
    const p = 'data/agenda-img/' + name;
    if (used.has(p)) continue;
    const id = ids.find((x) => name.toLowerCase().startsWith(x.toLowerCase() + '-') || name.toLowerCase().startsWith(x.toLowerCase() + '.'));
    if (!id) continue;
    const t = tasks.find((x) => x.id === id); t.images = [...(t.images || []), p]; used.add(p); n++;
  }
  if (n) save(tasks);
  return n;
}

// ---------- vistas (las mismas reglas que la página) ----------
export function groups(tasks, day = today()) {
  const open = tasks.filter((t) => !isDone(t, day));
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  const upcoming = open.filter((t) => !t.daily && t.date && t.date > day).sort((a, b) => a.date.localeCompare(b.date) || byTitle(a, b));
  return {
    late: open.filter((t) => !t.daily && t.date && t.date < day).sort((a, b) => a.date.localeCompare(b.date) || byTitle(a, b)),
    today: tasks.filter((t) => t.daily || t.date === day).sort((a, b) => isDone(a, day) - isDone(b, day) || b.daily - a.daily || byTitle(a, b)),
    upcoming,
    undated: open.filter((t) => !t.daily && !t.date).sort(byTitle),
    done: tasks.filter((t) => !t.daily && t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')).slice(0, 30),
  };
}
export const counts = (tasks, day = today()) => { const g = groups(tasks, day); return { today: g.today.filter((t) => !isDone(t, day)).length, late: g.late.length }; };

