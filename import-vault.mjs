// import-vault.mjs — importa chats y proyectos del vault de Obsidian (idempotente)
// CLI: node import-vault.mjs (vault = variable VAULT > data/settings.json > ~/Claude-Memoria). El servidor usa
// collectAsync() para sincronizar en segundo plano sin bloquear el bucle de eventos.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import { homedir } from 'node:os';
import { upsertMany, STATUSES, TYPES } from './store.mjs';
import { resolveVault } from './settings.mjs';

const VAULT = resolveVault().path || join(homedir(), 'Claude-Memoria');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- frontmatter YAML simple (clave: valor, listas [a, b] o "- a" en líneas siguientes) ----------
const unquote = (v) => v.replace(/^(["'])(.*)\1$/s, '$2').trim();
const NULLISH = new Set(['', 'null', '~', 'undefined', 'none', 'nil', '[]', '{}']);
// Valor plano: sin comillas, sin corchetes; "null"/"~"/vacío → undefined. Una lista "[a, b]" se queda como "a, b".
const scalar = (v) => { if (Array.isArray(v)) v = v.filter(Boolean).join(', '); if (typeof v !== 'string') return undefined; v = unquote(v); if (/^\[.*\]$/s.test(v)) v = v.slice(1, -1).split(',').map(unquote).filter(Boolean).join(', '); return NULLISH.has(v.toLowerCase()) ? undefined : v; };
const list = (v) => { if (Array.isArray(v)) return v.map(unquote).filter(Boolean); if (typeof v !== 'string') return []; v = unquote(v); if (/^\[.*\]$/s.test(v)) v = v.slice(1, -1); return v.split(',').map(unquote).filter(Boolean); };
export function parse(text) {
  text = String(text).replace(/^﻿/, '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const fm = {};
  if (m) {
    let last = null;
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([\w-]+):\s*(.*)$/);
      if (kv) { last = kv[1].toLowerCase(); fm[last] = kv[2].trim(); continue; }
      const li = line.match(/^\s+-\s+(.*)$/); // lista YAML en varias líneas
      if (li && last) { if (!Array.isArray(fm[last])) fm[last] = fm[last] ? [fm[last]] : []; fm[last].push(li[1].trim()); }
    }
  }
  return { fm, body: m ? text.slice(m[0].length) : text };
}

// ---------- mapeo a los valores que entiende el tablero ----------
const STATUS_ALIAS = { hecho: 'done', hecha: 'done', completed: 'done', completado: 'done', completada: 'done', finalizado: 'done', terminado: 'done', cerrado: 'done', closed: 'done', 'en curso': 'doing', activo: 'doing', active: 'doing', 'in-progress': 'doing', 'in progress': 'doing', progreso: 'doing', ongoing: 'doing', wip: 'doing', bloqueado: 'blocked', bloqueada: 'blocked', pausado: 'blocked', paused: 'blocked', 'on hold': 'blocked', pendiente: 'todo', open: 'todo', abierto: 'todo', planned: 'todo', backlog: 'idea', ideas: 'idea' };
const TYPE_ALIAS = { proyecto: 'project', proyectos: 'project', trabajo: 'job', trabajos: 'job', task: 'todo', 'to-do': 'todo', tarea: 'todo', tareas: 'todo', pendiente: 'todo', estudio: 'study', estudiar: 'study', curso: 'study', automatizacion: 'automation', automatización: 'automation', automatizaciones: 'automation', conversacion: 'chat', conversación: 'chat', conversaciones: 'chat', chats: 'chat' };
export const mapStatus = (v, def) => { const s = (scalar(v) || '').toLowerCase().replace(/[_]/g, ' ').trim(); return STATUSES.includes(s) ? s : STATUS_ALIAS[s] || def; };
export const mapType = (v, def) => { const s = (scalar(v) || '').toLowerCase().trim(); return TYPES.includes(s) ? s : TYPE_ALIAS[s] || def; };
// 2026-10-13, 2026-10-13T14:00:00Z, 13/10/2026 → YYYY-MM-DD (real en el calendario); "Oct 13 – Dec 2, 2026" → undefined.
export const dateOf = (v) => {
  v = scalar(v); if (!v) return undefined;
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) { const d = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); if (d) m = [, d[3], d[2].padStart(2, '0'), d[1].padStart(2, '0')]; }
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  try { return new Date(iso + 'T00:00:00Z').toISOString().slice(0, 10) === iso ? iso : undefined; } catch { return undefined; }
};

const section = (body, name) => {
  const m = body.match(new RegExp(`^##\\s+${name}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'mi'));
  return m ? m[1].trim() : '';
};
const firstParagraph = (body) => body.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#')) || '';
const bullets = (body) => body.split(/\r?\n/).filter((l) => /^\s*[-*]\s+\S/.test(l)).map((l) => l.trim());
const isMd = (d) => d.isFile() && /\.md$/i.test(d.name);
const mdFiles = (dir) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(isMd).map((d) => join(dir, d.name)) : [];
const subdirs = (dir) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name)) : [];
const title = (fm, file) => scalar(fm.title) || basename(file).replace(/\.md$/i, '').trim() || 'Sin título';
const src = (vault, file, t) => ({ kind: 'vault', ref: relative(vault, file).replaceAll('\\', '/'), title: t });

export function read(file) { return parse(readFileSync(file, 'utf8')); }

// ---------- una nota → un item (misma lógica para la versión síncrona y la asíncrona) ----------
// 30 Conversaciones/<área>/*.md -> chat
function chatItem(vault, areaDir, file, text) {
  const { fm, body } = parse(text);
  const t = title(fm, file);
  const it = { type: 'chat', status: 'done', title: t, area: scalar(fm.area) || basename(areaDir), date: dateOf(fm.date), tags: list(fm.tags), notes: section(body, 'Resumen') || firstParagraph(body), source: src(vault, file, t) };
  const uuid = scalar(fm.uuid) || scalar(fm.id);
  if (UUID.test(uuid || '')) { it.url = `https://claude.ai/chat/${uuid}`; it.source.ref = uuid; it.source.kind = 'claude-chat'; }
  return it;
}
// 10 Memoria/areas/*.md -> project (descripción + viñetas); status/type del frontmatter si existen
function areaItem(vault, file, text) {
  const { fm, body } = parse(text);
  const t = title(fm, file);
  return { type: mapType(fm.type || fm.tipo, 'project'), status: mapStatus(fm.status || fm.estado, 'doing'), title: t, area: scalar(fm.area) || t, date: dateOf(fm.date), due: dateOf(fm.due), tags: list(fm.tags), notes: [firstParagraph(body), ...bullets(body)].filter(Boolean).join('\n'), source: src(vault, file, t) };
}
// 20 Proyectos/*.md -> project
function projectItem(vault, file, text) {
  const { fm, body } = parse(text);
  const t = title(fm, file);
  return { type: mapType(fm.type || fm.tipo, 'project'), status: mapStatus(fm.status || fm.estado, 'doing'), title: t, area: scalar(fm.area), date: dateOf(fm.date), due: dateOf(fm.due), tags: list(fm.tags), notes: firstParagraph(body), source: src(vault, file, t) };
}

// Construye la lista de items a partir del vault (sin escribir). Síncrona: CLI y pruebas.
export function collect(vault = VAULT) {
  const items = [];
  for (const areaDir of subdirs(join(vault, '30 Conversaciones'))) for (const file of mdFiles(areaDir)) items.push(chatItem(vault, areaDir, file, readFileSync(file, 'utf8')));
  for (const file of mdFiles(join(vault, '10 Memoria', 'areas'))) items.push(areaItem(vault, file, readFileSync(file, 'utf8')));
  for (const file of mdFiles(join(vault, '20 Proyectos'))) items.push(projectItem(vault, file, readFileSync(file, 'utf8')));
  return items;
}

// Igual que collect() pero con fs asíncrono y lecturas en paralelo acotadas: la usa el servidor para no bloquearse
// mientras sincroniza (cientos de notas, posiblemente en una carpeta de Google Drive).
async function ls(dir) { try { return await readdir(dir, { withFileTypes: true }); } catch { return []; } }
async function mapLimit(arr, limit, fn) { const out = new Array(arr.length); let i = 0; await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, async () => { for (;;) { const k = i++; if (k >= arr.length) return; out[k] = await fn(arr[k], k); } })); return out; }
export async function collectAsync(vault = VAULT, { concurrency = 16 } = {}) {
  const jobs = [];
  const conv = join(vault, '30 Conversaciones');
  for (const d of await ls(conv)) if (d.isDirectory()) { const areaDir = join(conv, d.name); for (const f of await ls(areaDir)) if (isMd(f)) jobs.push({ file: join(areaDir, f.name), build: (text) => chatItem(vault, areaDir, join(areaDir, f.name), text) }); }
  const areas = join(vault, '10 Memoria', 'areas');
  for (const f of await ls(areas)) if (isMd(f)) jobs.push({ file: join(areas, f.name), build: (text) => areaItem(vault, join(areas, f.name), text) });
  const proj = join(vault, '20 Proyectos');
  for (const f of await ls(proj)) if (isMd(f)) jobs.push({ file: join(proj, f.name), build: (text) => projectItem(vault, join(proj, f.name), text) });
  // Una nota ilegible (bloqueada por Drive, borrada a mitad) se salta; el resto se importa.
  const items = await mapLimit(jobs, concurrency, async (j) => { try { return j.build(await readFile(j.file, 'utf8')); } catch { return null; } });
  return items.filter(Boolean);
}

// Importa (upsert) y devuelve el resumen; la usa el CLI y el servidor. Conserva el status editado en el tablero.
export function summarize(items, res) {
  const by = {}; for (const r of res) by[r.item.type] = (by[r.item.type] || 0) + 1;
  return { created: res.filter((r) => r.created).length, updated: res.filter((r) => !r.created).length, total: items.length, byType: by };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  if (!existsSync(VAULT)) {
    console.log(`VAULT no existe (${VAULT}): 0 items importados`);
    process.exit(0);
  }
  const items = collect(VAULT);
  const s = summarize(items, items.length ? upsertMany(items) : []);
  console.log(`${s.created} nuevos, ${s.updated} actualizados (${s.total} items desde ${VAULT}: ${Object.entries(s.byType).map(([k, n]) => `${n} ${k}`).join(', ') || 'nada'})`);
}
