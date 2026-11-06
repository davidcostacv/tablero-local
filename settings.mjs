// settings.mjs — ajustes persistentes en data/settings.json (los escribe la UI, setup.ps1 y notify.mjs).
// Claves: overdueAlerts (bool), vault (ruta del vault de Obsidian), port (puerto del servidor).
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DATA_DIR } from './store.mjs';

export const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const DEFAULTS = { overdueAlerts: true };

// Tolera BOM (PowerShell 5.1 lo pone al escribir UTF-8) y un archivo roto (vuelve a los valores por defecto).
export function readSettings() {
  try { const v = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8').replace(/^﻿/, '')); return v && typeof v === 'object' && !Array.isArray(v) ? { ...DEFAULTS, ...v } : { ...DEFAULTS }; } catch { return { ...DEFAULTS }; }
}
// Mezcla y escribe de forma atómica. Un valor null/undefined borra la clave.
export function saveSettings(partial) {
  const next = { ...readSettings() };
  for (const [k, v] of Object.entries(partial || {})) { if (v === null || v === undefined) delete next[k]; else next[k] = v; }
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 1));
  try { renameSync(tmp, SETTINGS_FILE); } catch { writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 1)); }
  return next;
}

const validPort = (p) => { p = Number(p); return Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : undefined; };
// Puerto: variable PORT > settings.json > 4747.
export const resolvePort = () => validPort(process.env.PORT) || validPort(readSettings().port) || 4747;

// Vault: variable VAULT > settings.json > ~/Claude-Memoria (si existe). Devuelve { path, source } o { path: null }.
export function resolveVault() {
  const env = (process.env.VAULT || '').trim();
  if (env) return { path: env, source: 'env' };
  const s = readSettings();
  if (typeof s.vault === 'string' && s.vault.trim()) return { path: s.vault.trim(), source: 'settings' };
  const def = join(homedir(), 'Claude-Memoria');
  if (existsSync(def)) return { path: def, source: 'default' };
  return { path: null, source: null };
}
