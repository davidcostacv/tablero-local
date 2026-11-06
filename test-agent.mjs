// test-agent.mjs — pruebas del asistente sin frameworks: node test-agent.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dash-test-'));
process.env.DATA_DIR = dir;
const { upsertMany, load } = await import('./store.mjs');
const { ask, askLocal, parseDate } = await import('./agent.mjs');

const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
upsertMany([
  { type: 'todo', title: 'Pedir reseñas de Google', area: 'Taller', due: day(-5), priority: 'high' },
  { type: 'todo', title: 'Pagar seguro de la camioneta', area: 'Taller', due: day(-1) },
  { type: 'todo', title: 'Llamar al contador', area: 'Finanzas', due: day(0) },
  { type: 'todo', title: 'Enviar propuesta a Cliente Y', area: 'Freelance', due: day(2), priority: 'high' },
  { type: 'todo', title: 'Renovar dominio', area: 'Taller', due: day(5) },
  { type: 'todo', title: 'Revisar flujo n8n', area: 'Automatización', due: day(12) },
  { type: 'todo', title: 'Ordenar fotos', area: 'Personal' },
  { type: 'project', title: 'Web del taller', area: 'Taller', status: 'doing', notes: 'Rediseño con turnos online.' },
  { type: 'project', title: 'App de inventario', area: 'Taller', status: 'idea' },
  { type: 'job', title: 'Cliente Y: landing', area: 'Freelance', status: 'doing' },
  { type: 'job', title: 'Mecánica Pérez: mantenimiento web', area: 'Taller', status: 'doing' },
  { type: 'job', title: 'Postulación Acme', area: 'Trabajo', status: 'blocked' },
  { type: 'study', title: 'Curso de n8n', area: 'Automatización', status: 'doing' },
  { type: 'automation', title: 'Bot de turnos', area: 'Taller', status: 'done' },
  { type: 'chat', title: 'Plan de reseñas', area: 'Taller', status: 'done', date: day(-3) },
]);

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } };
const titles = (r) => r.items.map((i) => i.title);
const Q = (q) => { const r = askLocal(q); console.log(`- ${q}\n  -> ${r.answer}${r.items.length ? ' [' + titles(r).join(' | ') + ']' : ''}`); return r; };

console.log('== modo local ==');
let r = Q('¿Qué tengo atrasado?'); t('atrasados', r.items.length === 2 && titles(r).includes('Pagar seguro de la camioneta'), r);
r = Q('¿qué vence hoy?'); t('hoy', titles(r).join() === 'Llamar al contador', r);
r = Q('que tengo para mañana'); t('mañana', r.items.length === 0 && /mañana/.test(r.answer), r);
r = Q('¿Qué vence esta semana?'); t('semana', r.items.length === 3 && titles(r).includes('Renovar dominio') && !titles(r).includes('Revisar flujo n8n') && !titles(r).includes('Pagar seguro de la camioneta') && /2 atrasados/.test(r.answer), r);
r = Q('próximos 15 días'); t('proximos N dias', titles(r).includes('Revisar flujo n8n'), r);
r = Q('proyectos en curso'); t('tipo+estado', titles(r).join() === 'Web del taller', r);
r = Q('¿cuántos trabajos en curso hay en el área Taller?'); t('conteo area', r.count === 1 && /Hay 1 trabajo/.test(r.answer) && titles(r)[0] === 'Mecánica Pérez: mantenimiento web', r);
r = Q('tareas de Taller'); t('tipo+area', r.items.length === 3 && r.items.every((i) => i.area === 'Taller'), r);
r = Q('busca reseñas'); t('busqueda', r.items.length === 2 && titles(r).includes('Plan de reseñas'), r);
r = Q('qué tengo bloqueado'); t('bloqueados', titles(r).join() === 'Postulación Acme', r);
r = Q('tareas urgentes'); t('prioridad', r.items.length === 2 && r.items.every((i) => i.priority === 'high'), r);
r = Q('cosas hechas'); t('hechos', r.items.length === 2 && r.items.every((i) => i.status === 'done'), r);
r = Q('resume el proyecto Web del taller'); t('resumen item', /Rediseño con turnos online/.test(r.answer) && /en curso/.test(r.answer), r);
r = Q('resumen general'); t('resumen general', r.summary && r.summary.late === 2 && /atrasados/.test(r.answer), r);
r = Q('agrega una tarea: llamar al banco el viernes'); const added = load().find((i) => i.title === 'Llamar al banco');
t('agregar viernes', r.created && added && added.type === 'todo' && added.due && new Date(added.due + 'T12:00:00').getDay() === 5 && added.due >= day(0), { r, added });
r = Q('agrega proyecto Tienda online en Taller para el 25/12 urgente'); const p = load().find((i) => i.title === 'Tienda online');
t('agregar proyecto fecha dd/mm area prioridad', p && p.type === 'project' && p.area === 'Taller' && /-12-25$/.test(p.due) && p.priority === 'high', p);
r = Q('añade estudiar Rust'); t('agregar sin tipo', load().some((i) => i.title === 'Estudiar Rust' && i.type === 'todo'), r);
r = Q('anota probar el asistente mañana en Taller'); const pa = load().find((i) => /^Probar el asistente$/.test(i.title));
t('agregar mañana + area (ñ)', pa && pa.due === day(1) && pa.area === 'Taller', { r, pa });
r = Q('marca como hecho pagar el seguro'); t('hecho inequivoco', r.changed && load().find((i) => i.title === 'Pagar seguro de la camioneta').status === 'done', r);
r = Q('marca Cliente Y como hecho'); t('hecho ambiguo', r.ambiguous && r.items.length === 2 && load().filter((i) => /Cliente Y/.test(i.title)).every((i) => i.status !== 'done'), r);
r = Q('termina la tarea inexistente xyz'); t('hecho sin match', /No encontré/.test(r.answer), r);
r = Q('¿cuál es el sentido de la vida?'); t('desconocida', /No entendí/.test(r.answer) && r.items.length === 0, r);
r = Q('¿qué tengo atrasado en Taller?'); t('atrasado+area', r.items.length === 1 && r.items[0].title === 'Pedir reseñas de Google', r);
t('parseDate yyyy-mm-dd', parseDate('pagar 2026-12-01 luz').date === '2026-12-01');
t('parseDate pasado mañana', parseDate('x pasado mañana').date === day(2));

r = Q('tareas sin fecha'); t('sin fecha', r.items.length === 2 && titles(r).includes('Ordenar fotos') && titles(r).includes('Estudiar Rust'), r);
r = Q('qué hice esta semana'); t('hechas esta semana', r.items.length >= 1 && titles(r).includes('Pagar seguro de la camioneta') && r.items.every((i) => i.status === 'done'), r);
r = Q('lo último'); t('recientes', r.recent !== false && r.items.length > 0 && /recientemente/.test(r.answer), r);
r = Q('chats de Taller'); t('chats (hechos) por area', titles(r).join() === 'Plan de reseñas', r);
r = Q('recuérdame comprar filtros el 15 de diciembre'); const rf = load().find((i) => i.title === 'Comprar filtros'); t('agregar "N de mes"', rf && /-12-15$/.test(rf.due), rf);
r = Q('¿cuántas tareas hay en Finanzas?'); t('conteo tareas area', r.count === 1 && /Hay 1 tarea abierta en Finanzas/.test(r.answer), r);
r = await ask('proyectos'); t('ask() async', r.mode === 'local' && r.items.length === 3 && /3 proyectos abiertos/.test(r.answer), r);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
