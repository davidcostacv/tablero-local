#!/usr/bin/env node
// dash.mjs — CLI que escribe directo al JSON (funciona con el servidor apagado)
import { readFileSync } from 'node:fs';
import { load, upsertMany, patch } from './store.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opts = {};
const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  else pos.push(rest[i]);
}

const USAGE = `uso:
  node dash.mjs add --type todo --title "..." [--status --priority --area --notes --url --due --date --tags a,b --source-kind --source-ref --source-title]
  node dash.mjs import <archivo.json | ->
  node dash.mjs list [--type t] [--status s] [--area a]
  node dash.mjs done <id>
  node dash.mjs ask "¿qué tengo atrasado?"
  node dash.mjs import-whatsapp chat.txt [--contact "Nombre" --phone +573001234567 --me "Tu nombre" --dry-run]
Si el item ya existe se actualiza pero conserva su status; usa --force-status para pisarlo.`;

const fail = (msg) => { console.error(msg); process.exit(1); };
const upsertOpts = { forceStatus: opts['force-status'] === true };
const report = (res) => {
  for (const { item, created } of res) console.log(`${created ? '+' : '~'} ${item.id} [${item.type}] ${item.title}`);
  console.log(`${res.filter((r) => r.created).length} nuevos, ${res.filter((r) => !r.created).length} actualizados`);
};

switch (cmd) {
  case 'add': {
    const it = { ...opts };
    delete it['force-status'];
    if (typeof it.tags === 'string') it.tags = it.tags.split(',').map((s) => s.trim()).filter(Boolean);
    if (it['source-kind'] || it['source-ref'] || it['source-title']) {
      it.source = { kind: it['source-kind'] || 'manual', ref: it['source-ref'], title: it['source-title'] };
    }
    try { report(upsertMany([it], upsertOpts)); } catch (e) { fail(e.message); }
    break;
  }
  case 'import': {
    const src = pos[0];
    if (!src) fail(USAGE);
    let text;
    try { text = readFileSync(src === '-' ? 0 : src, 'utf8'); } catch (e) { fail(`no se pudo leer ${src}: ${e.message}`); }
    let data;
    try { data = JSON.parse(text.replace(/^﻿/, '')); } catch { fail('JSON inválido'); }
    try { report(upsertMany(data, upsertOpts)); } catch (e) { fail(e.message); }
    break;
  }
  case 'list': {
    const items = load().filter((it) => ['type', 'status', 'area'].every((k) => !opts[k] || it[k] === opts[k]));
    for (const it of items) console.log(`${it.id}  ${it.type.padEnd(10)} ${it.status.padEnd(7)} ${it.due || it.date || '          '}  ${it.title}${it.area ? `  (${it.area})` : ''}`);
    console.log(`${items.length} items`);
    break;
  }
  case 'done': {
    if (!pos[0]) fail(USAGE);
    const it = patch(pos[0], { status: 'done' });
    if (!it) fail(`no existe ${pos[0]}`);
    console.log(`✓ ${it.id} ${it.title}`);
    break;
  }
  case 'ask': {
    const q = pos.join(' ').trim();
    if (!q) fail(USAGE);
    const { ask } = await import('./agent.mjs');
    const r = await ask(q);
    console.log(r.answer);
    for (const it of r.items) console.log(`  ${it.id}  ${it.type.padEnd(10)} ${it.status.padEnd(7)} ${it.due || it.date || '          '}  ${it.title}${it.area ? `  (${it.area})` : ''}`);
    break;
  }
  case 'import-whatsapp': {
    const src = pos[0];
    if (!src) fail(USAGE);
    let text;
    try { text = readFileSync(src, 'utf8'); } catch (e) { fail(`no se pudo leer ${src}: ${e.message}`); }
    const { importWhatsApp } = await import('./whatsapp.mjs');
    const { basename } = await import('node:path');
    const str = (k) => (typeof opts[k] === 'string' ? opts[k] : undefined);
    const r = importWhatsApp(text, { chat: str('chat') || basename(src, '.txt'), contact: str('contact'), phone: str('phone'), me: str('me') });
    console.log(`${r.messages} mensajes de ${r.senders.join(', ') || 'nadie'} · ${r.todos.length} compromisos detectados`);
    for (const t of r.todos) console.log(`  ${t.due || '          '}  ${t.title}${t.contact && t.contact.name ? `  (${t.contact.name})` : ''}`);
    if (opts['dry-run'] === true) { console.log('(--dry-run: no se guardó nada)'); break; }
    if (r.todos.length) report(upsertMany(r.todos, upsertOpts));
    break;
  }
  default:
    fail(USAGE);
}
