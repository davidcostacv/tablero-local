// vault-sync.mjs — sincronización automática del vault de Obsidian dentro del servidor.
// Reimporta al arrancar, cada VAULT_SYNC_MINUTES (por defecto 10), cuando cambia un .md del vault (fs.watch con
// rebote; si fs.watch falla queda solo el sondeo) y a demanda (POST /api/vault/sync). Reutiliza collectAsync() de
// import-vault.mjs y upsertMany() del store, así reimportar conserva el status editado en el tablero. Nunca lanza.
import { watch, statSync } from 'node:fs';
import { collectAsync, summarize } from './import-vault.mjs';
import { upsertMany } from './store.mjs';
import { resolveVault } from './settings.mjs';

const E = process.env;
const minutes = (v, def) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : def; };

export function createVaultSync({ log = (s) => console.log('[vault] ' + s), intervalMinutes = minutes(E.VAULT_SYNC_MINUTES, 10), debounceMs = Number(E.VAULT_WATCH_DEBOUNCE_MS) || 2000, useWatch = E.VAULT_WATCH !== '0' } = {}) {
  let last = null;          // { at, ok, created, updated, total, ms, trigger, error }
  let running = null;       // promesa de la sincronización en curso (se comparte: no hay dos a la vez)
  let timer = null, watcher = null, watchedPath = null, debounce = null, nextAt = null;
  const intervalMs = Math.max(1000, Math.round(intervalMinutes * 60000));

  const where = () => { const v = resolveVault(); const exists = !!v.path && (() => { try { return statSync(v.path).isDirectory(); } catch { return false; } })(); return { ...v, exists }; };

  async function run(trigger) {
    const t0 = Date.now(), v = where();
    // Sin vault no hay nada que sincronizar: solo una petición manual deja constancia (para que Ajustes lo muestre).
    if (!v.path) { const r = { at: new Date().toISOString(), ok: false, error: 'sin vault configurado', trigger, ms: 0 }; if (trigger === 'manual') last = r; return r; }
    if (!v.exists) { last = { at: new Date().toISOString(), ok: false, error: `la carpeta no existe: ${v.path}`, trigger, ms: 0 }; if (trigger !== 'intervalo') log(`no se pudo sincronizar: ${last.error}`); return last; }
    try {
      const items = await collectAsync(v.path);
      const s = summarize(items, items.length ? upsertMany(items) : []);
      last = { at: new Date().toISOString(), ok: true, ...s, ms: Date.now() - t0, trigger };
      if (s.created || trigger !== 'intervalo') log(`sincronizado (${trigger}): ${s.created} nuevos, ${s.updated} actualizados, ${s.total} items en ${last.ms} ms · ${v.path}`);
    } catch (e) {
      last = { at: new Date().toISOString(), ok: false, error: e && e.message ? e.message : String(e), ms: Date.now() - t0, trigger };
      log(`error al sincronizar (${trigger}): ${last.error}`);
    }
    ensureWatch(v);
    return last;
  }
  // Sincroniza ahora; si ya hay una en curso, devuelve esa misma promesa.
  const sync = (trigger = 'manual') => running || (running = run(trigger).finally(() => { running = null; }));

  // fs.watch recursivo (Windows y macOS siempre; Linux desde Node 20). Si no se puede, el sondeo periódico basta.
  function ensureWatch(v) {
    if (!useWatch || !v.exists || watchedPath === v.path) return;
    closeWatch();
    try {
      watcher = watch(v.path, { recursive: true, persistent: false }, (_ev, name) => {
        if (name && !/\.md$/i.test(String(name)) && !/[\\/]$/.test(String(name)) && /\.[A-Za-z0-9]+$/.test(String(name))) return; // .obsidian/workspace.json y similares
        clearTimeout(debounce); debounce = setTimeout(() => { sync('cambio').catch(() => {}); }, debounceMs);
      });
      watcher.on('error', (e) => { log(`fs.watch falló (${e.message}); se usará solo el sondeo cada ${intervalMinutes} min`); closeWatch(); watchedPath = null; useWatch = false; });
      watchedPath = v.path;
    } catch (e) { log(`fs.watch no disponible (${e.message}); se usará solo el sondeo cada ${intervalMinutes} min`); watcher = null; useWatch = false; }
  }
  function closeWatch() { if (watcher) { try { watcher.close(); } catch {} } watcher = null; watchedPath = null; clearTimeout(debounce); }

  function start() {
    const v = where();
    if (!v.path) { log('sin vault configurado: setup.ps1 -Vault "C:\\ruta\\Claude-Memoria" (o variable VAULT)'); }
    else log(`vault: ${v.path}${v.exists ? '' : ' (la carpeta no existe)'} · sincroniza cada ${intervalMinutes} min${useWatch ? ' y al detectar cambios' : ''}`);
    const tick = () => { nextAt = new Date(Date.now() + intervalMs).toISOString(); sync('intervalo').catch(() => {}); };
    timer = setInterval(tick, intervalMs); timer.unref();
    nextAt = new Date(Date.now() + intervalMs).toISOString();
    return sync('inicio');
  }
  function stop() { clearInterval(timer); timer = null; closeWatch(); }

  // Estado para /api/meta y Ajustes (la ruta solo se expone desde el PC; el servidor decide).
  function status() {
    const v = where();
    return { configured: !!v.path, path: v.path, source: v.source, exists: v.exists, lastSync: last, nextSync: timer ? nextAt : null, syncing: !!running, watching: !!watcher, intervalMinutes };
  }
  return { start, stop, sync, status };
}
