#!/usr/bin/env node
// scripts/agenda.mjs — CLI de la Agenda. Escribe directo en data/agenda.json (funciona con el servidor apagado;
// la página lo ve al recargar). Pensada para Claude Code y para usarla a mano desde PowerShell.
import { readFileSync } from 'node:fs';
import * as A from '../agenda.mjs';

const USAGE = `uso (PowerShell, desde la carpeta del tablero):
  node scripts/agenda.mjs add "Título" [--date hoy|manana|pasado|viernes|YYYY-MM-DD|sin] [--cat trabajo|estudio|personal]
                                       [--client "Nombre"] [--bureaus TU,EQ,EX] [--daily] [--notes "texto"] [--id mi-id]
  node scripts/agenda.mjs list [--all]          (Atrasado, Hoy, Próximos, Sin fecha; --all incluye Hechas)
  node scripts/agenda.mjs done <id> [--undo]
  node scripts/agenda.mjs edit <id> [--title --date --cat --client --bureaus --notes --daily true|false]
  node scripts/agenda.mjs rm <id>
  node scripts/agenda.mjs import <archivo.json>  (crea o actualiza por id; conserva lo ya marcado como hecho)
  node scripts/agenda.mjs fotos                  (asocia imágenes dejadas en data\\agenda-img\\<id>-1.png)
  node scripts/agenda.mjs today                  (fecha de "hoy" y zona horaria de la agenda)`;

const [cmd, ...rest] = process.argv.slice(2);
const opts = {}, pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  else pos.push(rest[i]);
}
const fail = (m) => { console.error('Error: ' + m); process.exit(1); };
const day = A.today();
const chips = (t) => [t.category, t.client, t.bureaus.map((b) => A.BUREAU_SHORT[b]).join('/'), t.daily ? 'diaria' : '', t.images.length ? t.images.length + ' img' : ''].filter(Boolean).join(' · ');
const show = (t) => `  [${A.isDone(t, day) ? 'x' : ' '}] ${t.title}  (${chips(t)})  id=${t.id}`;
const fields = () => {
  const b = {};
  if (opts.title !== undefined) b.title = String(opts.title);
  if (opts.date !== undefined) b.date = opts.date === true ? null : A.parseDate(String(opts.date), day);
  if (opts.cat !== undefined || opts.category !== undefined) b.category = String(opts.cat ?? opts.category);
  if (opts.client !== undefined) b.client = opts.client === true ? null : String(opts.client);
  if (opts.bureaus !== undefined) b.bureaus = opts.bureaus === true ? [] : String(opts.bureaus);
  if (opts.notes !== undefined) b.notes = opts.notes === true ? '' : String(opts.notes).replace(/\\n/g, '\n');
  if (opts.daily !== undefined) b.daily = opts.daily === true || opts.daily === 'true' || opts.daily === 'si';
  return b;
};

try {
  switch (cmd) {
    case 'add': {
      const title = pos.join(' ').trim() || opts.title;
      if (!title) fail('falta el título.\n' + USAGE);
      const t = A.add({ ...fields(), title, id: typeof opts.id === 'string' ? opts.id : undefined });
      console.log(`+ ${t.id}: ${t.title} · ${t.daily ? 'todos los días' : t.date ? A.shortDate(t.date) + ' (' + t.date + ')' : 'sin fecha'} · ${chips(t)}`);
      break;
    }
    case 'list': case 'ls': {
      const g = A.groups(A.load(), day);
      console.log(`Agenda · hoy ${A.longDate(day)} (${A.timezone()})`);
      const block = (name, list) => { if (!list.length) return; console.log(`\n${name} (${list.length})`); list.forEach((t) => console.log((t.date && name.startsWith('Próx') ? '  ' + A.shortDate(t.date) + ' ' : '') + show(t))); };
      block('Atrasado', g.late); block('Hoy', g.today); block('Próximos días', g.upcoming); block('Sin fecha', g.undated);
      if (opts.all) block('Hechas (últimas 30)', g.done);
      break;
    }
    case 'done': {
      const t = A.patch(pos[0], { done: !opts.undo }, day);
      if (!t) fail('no existe la tarea ' + pos[0]);
      console.log(`${opts.undo ? 'Reabierta' : 'Hecha'}: ${t.title}`);
      break;
    }
    case 'edit': {
      const t = A.patch(pos[0], fields(), day);
      if (!t) fail('no existe la tarea ' + pos[0]);
      console.log('~ ' + show(t).trim());
      break;
    }
    case 'rm': case 'borrar': {
      if (!A.remove(pos[0])) fail('no existe la tarea ' + pos[0]);
      console.log('Borrada: ' + pos[0]);
      break;
    }
    case 'import': {
      if (!pos[0]) fail('falta el archivo JSON');
      const list = JSON.parse(readFileSync(pos[0], 'utf8').replace(/^﻿/, ''));
      const res = A.upsertMany(Array.isArray(list) ? list : [list]);
      res.forEach((r) => console.log(`${r.created ? '+' : '~'} ${r.task.id}: ${r.task.title}`));
      console.log(`${res.filter((r) => r.created).length} nuevas, ${res.filter((r) => !r.created).length} actualizadas`);
      const n = A.attachLooseImages(); if (n) console.log(`${n} imagen(es) asociada(s) desde data\\agenda-img`);
      break;
    }
    case 'fotos': case 'images': console.log(`${A.attachLooseImages()} imagen(es) nuevas asociadas`); break;
    case 'today': console.log(`${day} (${A.timezone()})`); break;
    default: console.log(USAGE); process.exit(cmd ? 1 : 0);
  }
} catch (e) { fail(e.message); }
