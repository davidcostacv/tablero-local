// log.mjs — registro en archivo para cuando el servidor corre oculto (tarea programada): data/server.log.
// Duplica console.log/info/warn/error al archivo con fecha y hora. Rota al pasar de maxBytes (por defecto 1 MB)
// y conserva una copia anterior (server.log.1). Nunca lanza: si no puede escribir, sigue solo por consola.
import { appendFileSync, statSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { format } from 'node:util';

const pad = (n) => String(n).padStart(2, '0');
export const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export function createFileLog(file, { maxBytes = 1024 * 1024, keep = 1 } = {}) {
  let size = 0;
  try { size = statSync(file).size; } catch { size = 0; }
  const rotate = () => {
    try {
      if (keep > 0) { try { unlinkSync(file + '.1'); } catch {} renameSync(file, file + '.1'); } else unlinkSync(file);
    } catch {}
    size = 0;
  };
  const write = (level, args) => {
    let line;
    try { line = `${stamp()} ${level} ${format(...args)}\n`; } catch { return; }
    try {
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) rotate();
      appendFileSync(file, line);
      size += bytes;
    } catch {}
  };
  return { file, write, rotate, size: () => size };
}

// Envuelve la consola: todo lo que se imprime queda también en el archivo. Devuelve el log (con `restore`).
export function installFileLog(file, opts) {
  const log = createFileLog(file, opts);
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const LEVEL = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR' };
  for (const k of Object.keys(orig)) console[k] = (...args) => { try { orig[k](...args); } catch {} log.write(LEVEL[k], args); };
  log.restore = () => { for (const k of Object.keys(orig)) console[k] = orig[k]; };
  return log;
}
