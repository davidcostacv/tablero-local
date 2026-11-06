// store.mjs — única capa que lee/escribe data/items.json
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const TYPES = ['project', 'job', 'todo', 'study', 'automation', 'chat'];
export const STATUSES = ['idea', 'todo', 'doing', 'blocked', 'done'];
export const PRIORITIES = ['low', 'med', 'high'];
export const SOURCE_KINDS = ['claude-chat', 'vault', 'manual', 'whatsapp'];
// Teléfono en E.164 (+573001234567). Acepta espacios, guiones y paréntesis y los quita.
export const phone = (v) => { if (typeof v !== 'string') return undefined; const p = v.replace(/[\s().-]/g, ''); return /^\+[1-9]\d{6,14}$/.test(p) ? p : undefined; };

export const DATA_DIR = process.env.DATA_DIR || join(import.meta.dirname, 'data');
const FILE = join(DATA_DIR, 'items.json');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const oneOf = (v, list) => (list.includes(v) ? v : undefined);
// YYYY-MM-DD y que exista en el calendario (2026-02-30 no pasa).
const date = (v) => {
  if (typeof v !== 'string') return undefined;
  v = v.trim();
  return DATE.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v ? v : undefined;
};

// Valida y normaliza un item de entrada. Lanza si falta type o title.
export function clean(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('item inválido');
  const type = oneOf(raw.type, TYPES);
  const title = str(raw.title, 200);
  if (!type) throw new Error(`type inválido: ${raw.type}`);
  if (!title) throw new Error('title requerido');
  const it = { type, title };
  const status = oneOf(raw.status, STATUSES);
  if (status) it.status = status;
  const priority = oneOf(raw.priority, PRIORITIES);
  if (priority) it.priority = priority;
  for (const [k, max] of [['area', 60], ['notes', 2000], ['url', 500]]) {
    const v = str(raw[k], max);
    if (v) it[k] = v;
  }
  for (const k of ['due', 'date']) {
    const v = date(raw[k]);
    if (v) it[k] = v;
  }
  if (Array.isArray(raw.tags)) {
    const tags = [...new Set(raw.tags.map((t) => str(t, 40)).filter(Boolean))].slice(0, 20);
    if (tags.length) it.tags = tags;
  }
  if (raw.contact && typeof raw.contact === 'object') {
    const name = str(raw.contact.name, 80), ph = phone(raw.contact.phone);
    if (name || ph) { it.contact = {}; if (name) it.contact.name = name; if (ph) it.contact.phone = ph; }
  }
  if (raw.source && typeof raw.source === 'object') {
    const kind = oneOf(raw.source.kind, SOURCE_KINDS);
    if (kind) {
      it.source = { kind };
      const ref = str(raw.source.ref, 300);
      const stitle = str(raw.source.title, 200);
      if (ref) it.source.ref = ref;
      if (stitle) it.source.title = stitle;
    }
  }
  return it;
}

// Clave de deduplicación: type + source(kind:ref) + título normalizado.
const key = (it) =>
  `${it.type}|${it.source ? `${it.source.kind}:${it.source.ref || ''}` : ''}|${it.title.toLowerCase()}`;

export function load() {
  try {
    const arr = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function save(items) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(items, null, 1));
  // En Windows el rename puede fallar un instante si otro proceso (antivirus, editor) tiene el archivo abierto.
  for (let i = 0; ; i++) {
    try { return renameSync(tmp, FILE); } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
}

// forceStatus: si es false (defecto), un item que ya existe conserva su status aunque la carga
// traiga otro; así reimportar no pisa lo que se editó en el tablero. PATCH sí cambia el status.
export function upsertMany(raws, { forceStatus = false } = {}) {
  const items = load();
  const byKey = new Map(items.map((it, i) => [key(it), i]));
  const now = new Date().toISOString();
  const out = [];
  for (const raw of Array.isArray(raws) ? raws : [raws]) {
    const it = clean(raw);
    const i = byKey.get(key(it));
    if (i === undefined) {
      const created = { id: randomUUID().slice(0, 8), ...it, status: it.status || 'todo', createdAt: now, updatedAt: now };
      byKey.set(key(it), items.push(created) - 1);
      out.push({ item: created, created: true });
    } else {
      if (!forceStatus) delete it.status;
      items[i] = { ...items[i], ...it, updatedAt: now };
      out.push({ item: items[i], created: false });
    }
  }
  save(items);
  return out;
}

export function patch(id, changes) {
  const items = load();
  const i = items.findIndex((it) => it.id === id);
  if (i < 0) return null;
  const cur = items[i];
  const it = clean({ ...cur, ...changes });
  // Campos que se pueden vaciar explícitamente con null/''.
  for (const k of ['priority', 'area', 'notes', 'url', 'due', 'date', 'tags', 'source', 'contact']) {
    if (k in changes && (changes[k] === null || changes[k] === '')) delete it[k];
  }
  items[i] = { id: cur.id, ...it, status: it.status || cur.status, createdAt: cur.createdAt, updatedAt: new Date().toISOString() };
  save(items);
  return items[i];
}

export function remove(id) {
  const items = load();
  const next = items.filter((it) => it.id !== id);
  if (next.length === items.length) return false;
  save(next);
  return true;
}
