// agent.mjs — asistente local sobre los datos del tablero: intérprete de preguntas en español
// (regex, sin tildes) sobre store.mjs. Gratis, sin red, sin tokens. Lo usan server.mjs (POST /api/agent)
// y dash.mjs (ask). Nunca borra; solo cambia estado con un "marca como hecho" inequívoco.
import { load, upsertMany, patch, TYPES } from './store.mjs';

// ---------- utilidades ----------
export const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const addDays = (n, from = new Date()) => { const d = new Date(from); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const today = () => iso(new Date());
const TYPE_ES = { project: ['proyecto', 'proyectos'], job: ['trabajo', 'trabajos', 'empleo', 'empleos', 'cliente', 'clientes', 'postulacion', 'postulaciones', 'ingreso', 'ingresos', 'laburo', 'laburos'], todo: ['tarea', 'tareas', 'pendiente', 'pendientes', 'to-do', 'todo', 'todos'], study: ['estudio', 'estudios', 'estudiar', 'curso', 'cursos', 'certificacion', 'certificaciones'], automation: ['automatizacion', 'automatizaciones', 'bot', 'bots', 'flujo', 'flujos', 'script', 'scripts', 'skill', 'skills'], chat: ['chat', 'chats', 'conversacion', 'conversaciones'] };
const TYPE_LABEL = { project: ['proyecto', 'proyectos'], job: ['trabajo', 'trabajos'], todo: ['tarea', 'tareas'], study: ['tema de estudio', 'temas de estudio'], automation: ['automatización', 'automatizaciones'], chat: ['chat', 'chats'] };
const FEM = { todo: 1, automation: 1 };
const ag = (w, type, n) => (FEM[type] ? w.replace(/o$/, 'a') : w) + (n === 1 ? '' : 's'); // concordancia: ag('atrasado','todo',2) -> 'atrasadas'
const STATUS_ES = { idea: 'idea', todo: 'pendiente', doing: 'en curso', blocked: 'bloqueado', done: 'hecho' };
const WD = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const isOpen = (it) => it.status !== 'done';
const compact = (it) => { const o = { id: it.id, type: it.type, title: it.title, status: it.status }; for (const k of ['area', 'due', 'date', 'priority']) if (it[k]) o[k] = it[k]; if (it.notes) o.notes = it.notes.length > 160 ? it.notes.slice(0, 160) + '…' : it.notes; if (it.url) o.url = it.url; return o; };
const list = (arr) => arr.map(compact);
const label = (type, n) => type ? TYPE_LABEL[type][n === 1 ? 0 : 1] : (n === 1 ? 'elemento' : 'elementos');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Fecha en español -> YYYY-MM-DD, relativa a `base` (por defecto hoy). Devuelve { date, text } con la
// expresión quitada del texto original.
export function parseDate(text, base) {
  const q = norm(text);
  let m, date;
  const now = base instanceof Date && !isNaN(base) ? base : new Date();
  const today = () => iso(now);
  const addDays = (n) => { const d = new Date(now); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
  // quita del texto original la expresión encontrada en el texto normalizado (tolera tildes y ñ)
  const cut = (mm) => text.replace(new RegExp(esc(mm).replace(/[aeioun]/g, (c) => `[${c}${{ a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', n: 'ñ' }[c]}]`), 'i'), ' ');
  if ((m = q.match(/\b(\d{4}-\d{2}-\d{2})\b/))) { date = m[1]; text = cut(m[0]); }
  else if ((m = q.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/)) && Number(m[1]) <= 31 && Number(m[2]) <= 12) {
    const y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : now.getFullYear();
    const d = new Date(y, Number(m[2]) - 1, Number(m[1]), 12); if (!m[3] && d < now && iso(d) !== today()) d.setFullYear(y + 1);
    date = iso(d); text = cut(m[0]);
  } else if ((m = q.match(/\b(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/))) {
    const mi = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'].indexOf(m[2] === 'setiembre' ? 'septiembre' : m[2]);
    const d = new Date(now.getFullYear(), mi, Number(m[1]), 12); if (d < now && iso(d) !== today()) d.setFullYear(d.getFullYear() + 1);
    date = iso(d); text = cut(m[0]);
  } else if ((m = q.match(/\bpasado manana\b/))) { date = iso(addDays(2)); text = cut(m[0]); }
  else if ((m = q.match(/\b(?:para |el |este |esta |el proximo |la proxima )?(hoy|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/))) {
    const w = m[1]; if (w === 'hoy') date = today(); else if (w === 'manana') date = iso(addDays(1));
    else { let n = (WD[w] - now.getDay() + 7) % 7; if (/proxim/.test(m[0]) && n === 0) n = 7; date = iso(addDays(n)); }
    text = cut(m[0]);
  } else if ((m = q.match(/\ben (\d+) dias?\b/))) { date = iso(addDays(Number(m[1]))); text = cut(m[0]); }
  else if ((m = q.match(/\b(?:la )?proxima semana\b/))) { date = iso(addDays(7)); text = cut(m[0]); }
  else if ((m = q.match(/\bfin de semana\b/))) { date = iso(addDays((6 - now.getDay() + 7) % 7)); text = cut(m[0]); }
  return { date, text: text.replace(/\s{2,}/g, ' ').trim() };
}

// ---------- consultas ----------
export function filterItems(f = {}) {
  const t = today();
  let out = load().filter((it) => (!f.type || it.type === f.type) && (!f.status || it.status === f.status) && (!f.area || norm(it.area) === norm(f.area)) && (!f.priority || it.priority === f.priority));
  if (f.open) out = out.filter(isOpen);
  if (f.noDue) out = out.filter((it) => isOpen(it) && !it.due);
  if (f.due) {
    const until = f.due === 'today' ? t : f.due === 'tomorrow' ? iso(addDays(1)) : f.due === 'week' ? iso(addDays(7)) : f.due.startsWith('days:') ? iso(addDays(Number(f.due.slice(5)) || 7)) : null;
    out = out.filter((it) => isOpen(it) && it.due && (f.due === 'late' ? it.due < t : f.due === 'today' ? it.due === t : f.due === 'tomorrow' ? it.due === until : it.due >= t && it.due <= until));
  }
  if (f.doneSince) out = out.filter((it) => !isOpen(it) && it.type !== 'chat' && (it.updatedAt || '') >= f.doneSince);
  if (f.q) { const q = norm(f.q); out = out.filter((it) => norm(it.title + ' ' + (it.notes || '') + ' ' + (it.area || '') + ' ' + (it.tags || []).join(' ')).includes(q)); }
  out.sort(f.recent || f.doneSince ? (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') : (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (b.priority === 'high') - (a.priority === 'high') || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return out.slice(0, f.limit || 30);
}
export function summary() {
  const items = load(), t = today(), wk = iso(addDays(7));
  const open = items.filter(isOpen);
  const by = (k) => open.reduce((o, it) => { const v = it[k] || '(sin área)'; o[v] = (o[v] || 0) + 1; return o; }, {});
  return { total: items.length, open: open.length, late: open.filter((it) => it.due && it.due < t).length, today: open.filter((it) => it.due === t).length, week: open.filter((it) => it.due && it.due >= t && it.due <= wk).length, byType: by('type'), byStatus: by('status'), byArea: by('area') };
}

// ---------- intérprete ----------
const HELP = 'No entendí la pregunta. Prueba con: "¿qué tengo atrasado?", "¿qué vence esta semana?", "tareas de hoy", "proyectos en curso", "¿cuántos trabajos en curso hay en Taller?", "busca reseñas", "resume el proyecto Web del taller", "qué hice esta semana", "tareas sin fecha", "agrega una tarea: llamar al banco el viernes" o "marca como hecho pagar el seguro".';
// "3 tareas atrasadas en Taller", "1 proyecto en curso", "elementos hechos sobre "x""
function phrase(f, n) {
  const p = [label(f.type, n)];
  if (f.status === 'todo') p.push(n === 1 ? 'pendiente' : 'pendientes');
  else if (f.status === 'doing') p.push('en curso');
  else if (f.status === 'blocked') p.push(ag('bloqueado', f.type, n));
  else if (f.status === 'done') p.push(ag('hecho', f.type, n));
  else if (f.status === 'idea') p.push('en idea');
  else if (f.doneSince) p.push(ag('terminado', f.type, n) + ' esta semana');
  else if (!f.due && !f.q && !f.recent && !f.noDue && f.type !== 'chat') p.push(ag('abierto', f.type, n));
  if (f.priority === 'high') p.push('de prioridad alta');
  if (f.noDue) p.push('sin fecha');
  if (f.recent) p.push(n === 1 ? 'editado recientemente' : 'editados recientemente');
  if (f.due === 'late') p.push(ag('atrasado', f.type, n));
  else if (f.due === 'today') p.push('para hoy');
  else if (f.due === 'tomorrow') p.push('para mañana');
  else if (f.due === 'week') p.push(n === 1 ? 'que vence esta semana' : 'que vencen esta semana');
  else if (f.due) p.push(`que ${n === 1 ? 'vence' : 'vencen'} en los próximos ${f.due.slice(5)} días`);
  if (f.area) p.push('en ' + f.area);
  if (f.q) p.push(`sobre "${f.q}"`);
  return p.join(' ');
}

export function askLocal(question) {
  const raw = String(question || '').trim();
  const q = norm(raw);
  if (!q) return { mode: 'local', answer: HELP, items: [] };
  const items = load();
  const areas = [...new Set(items.map((it) => it.area).filter(Boolean))];
  const areaOf = (s) => areas.find((a) => new RegExp(`(^|[^a-z0-9])${esc(norm(a))}([^a-z0-9]|$)`).test(norm(s)));
  const typeOf = (s) => { const w = norm(s); for (const [t, ws] of Object.entries(TYPE_ES)) if (ws.some((x) => new RegExp(`\\b${x}\\b`).test(w))) return t; return undefined; };
  let m;

  // agregar
  if ((m = raw.match(/^\s*(?:agrega|agregar|agregame|añade|anade|añadir|anadir|añademe|crea|crear|anota|anotar|apunta|apuntar|nuevo|nueva|registra|registrar|recordame|recuérdame|recuerdame)\b\s*(?:me\s+)?(.*)$/i))) {
    let rest = m[1].trim();
    const it = { source: { kind: 'manual', title: 'asistente' } };
    const tm = rest.match(/^(?:un |una |el |la |que )?(proyecto|tarea|pendiente|trabajo|empleo|cliente|postulacion|postulación|curso|tema de estudio|estudio|automatizacion|automatización|bot|flujo|chat)\b\s*:?\s*(?:de\s+|que\s+|para\s+)?/i);
    if (tm) { it.type = typeOf(tm[1]) || 'todo'; rest = rest.slice(tm[0].length); } else it.type = 'todo';
    if (/\b(urgente|prioridad alta|importante)\b/i.test(rest)) { it.priority = 'high'; rest = rest.replace(/\s*\(?\b(urgente|prioridad alta|importante)\b\)?/gi, ' '); }
    else if (/\bprioridad (media|baja)\b/i.test(rest)) { it.priority = /media/i.test(rest) ? 'med' : 'low'; rest = rest.replace(/\s*prioridad (media|baja)/i, ' '); }
    const pd = parseDate(rest); if (pd.date) { it.due = pd.date; rest = pd.text; }
    const tidy = (s) => s.replace(/^[\s:,-]+|[\s:,.-]+$/g, '').replace(/(\s+(para|el|la|los|las|en|de|del|al|a|que))+$/i, '').trim();
    rest = tidy(rest);
    const am = rest.match(/\b(?:en el area|en el área|del area|del área|area|área|en)\s+(?:de\s+)?([A-Za-zÁÉÍÓÚáéíóúñÑ][\wÁÉÍÓÚáéíóúñÑ-]*)\s*$/) || rest.match(/\(([^)]+)\)\s*$/);
    if (am && (areaOf(am[1]) || /area|área|\(/.test(am[0]))) { it.area = areaOf(am[1]) || am[1].trim(); rest = tidy(rest.slice(0, am.index)); }
    if (!rest) return { mode: 'local', answer: '¿Qué título le pongo? Por ejemplo: "agrega una tarea: llamar al banco el viernes".', items: [] };
    it.title = rest.charAt(0).toUpperCase() + rest.slice(1);
    const r = upsertMany([it])[0];
    return { mode: 'local', answer: `${r.created ? 'Listo, agregué' : 'Ya existía, actualicé'} ${label(it.type, 1)} "${r.item.title}"${it.area ? ' en ' + it.area : ''}${it.due ? ` para el ${it.due}` : ''}${it.priority === 'high' ? ' con prioridad alta' : ''}.`, items: list([r.item]), created: r.created };
  }

  // marcar como hecho
  if ((m = q.match(/^(?:marca|marcar|completa|completar|termina|terminar|cierra|cerrar|ya hice|hice|listo|da por (?:hecho|hecha|terminado|terminada))\b(.*)$/)) || (m = q.match(/^(.*)\s+(?:como|esta|está|ya esta|ya está)\s+(?:hecho|hecha|terminado|terminada|completado|completada|listo|lista)\s*$/))) {
    const target = m[1].replace(/\bcomo (hecho|hecha|terminado|terminada|completado|completada|listo|lista)\b/g, ' ').replace(/^\s*(la tarea|el proyecto|el trabajo|la|el|lo de|de)\s+/, '').replace(/[:"'¿?¡!]/g, ' ').trim();
    if (!target) return { mode: 'local', answer: '¿Cuál marco como hecho? Dime parte del título, por ejemplo: "marca como hecho pagar el seguro".', items: [] };
    const words = norm(target).split(/\s+/).filter((w) => w.length > 2 && !['para', 'como', 'con', 'del', 'las', 'los', 'una', 'que'].includes(w));
    const open = items.filter(isOpen);
    let cands = open.filter((it) => norm(it.title).includes(norm(target)));
    if (!cands.length) cands = open.filter((it) => words.length && words.every((w) => norm(it.title).includes(w)));
    if (!cands.length) cands = open.filter((it) => words.filter((w) => norm(it.title).includes(w)).length >= Math.max(1, Math.ceil(words.length / 2)));
    if (cands.length === 1) { const it = patch(cands[0].id, { status: 'done' }); return { mode: 'local', answer: `Hecho: marqué "${it.title}" como ${ag('terminado', it.type, 1)}.`, items: list([it]), changed: true }; }
    if (!cands.length) return { mode: 'local', answer: `No encontré ningún elemento abierto que coincida con "${target}".`, items: [] };
    return { mode: 'local', answer: `Hay ${cands.length} elementos que coinciden con "${target}". ¿Cuál marco? Repite la orden con el título más completo:`, items: list(cands), ambiguous: true };
  }

  // resumen general
  if (/^(resumen|resumen general|como voy|como estoy|estado general|como va todo|que tengo|que hay|dame un resumen|panorama)\s*\??$/.test(q) || /\b(resumen general|panorama|como va todo|como voy|como estoy)\b/.test(q)) {
    const s = summary();
    const byArea = Object.entries(s.byArea).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} (${n})`).join(', ');
    const types = Object.entries(s.byType).map(([t, n]) => `${n} ${label(t, n)}`).join(', ');
    const urgent = filterItems({ due: 'late' }).concat(filterItems({ due: 'week' }));
    return { mode: 'local', answer: `Tienes ${s.open} elementos abiertos (${types}). ${s.late ? `${s.late} ${s.late === 1 ? 'atrasado' : 'atrasados'}` : 'Nada atrasado'}, ${s.today} para hoy y ${s.week} ${s.week === 1 ? 'vence' : 'vencen'} esta semana. Por área: ${byArea || 'sin áreas'}.`, items: list([...new Map(urgent.map((i) => [i.id, i])).values()]), summary: s };
  }

  // resumen de un elemento / detalle
  if ((m = q.match(/^(?:resume|resumeme|resumir|resumen de|resumen del|detalle de|detalles de|que sabes de|que sabes del|cuentame de|cuentame del|cuentame sobre|info de|informacion de|que hay de|como va|como va el|como va la|estado de|estado del|en que estoy con|que paso con)\s+(.+?)\s*\??$/))) {
    const t = m[1].replace(/^(el |la |los |las )?(proyecto|tarea|trabajo|curso|chat|automatizacion)\s+/, '').replace(/^(el |la )/, '');
    const hits = filterItems({ q: t, limit: 5 });
    if (!hits.length) return { mode: 'local', answer: `No encontré nada sobre "${t}".`, items: [] };
    const it = hits[0];
    const bits = [`${label(it.type, 1)} "${it.title}"`, `estado: ${STATUS_ES[it.status]}`, it.area && `área: ${it.area}`, it.priority && `prioridad: ${it.priority === 'high' ? 'alta' : it.priority === 'med' ? 'media' : 'baja'}`, it.due && `vence: ${it.due}`, it.date && `fecha: ${it.date}`, it.notes && `notas: ${it.notes}`, it.url && `enlace: ${it.url}`, it.source && it.source.title && it.source.kind !== 'manual' && `fuente: ${it.source.title}`].filter(Boolean);
    const related = items.filter((x) => x.id !== it.id && (norm(x.title).includes(norm(t)) || (it.source && it.source.ref && x.source && x.source.ref === it.source.ref)));
    return { mode: 'local', answer: bits.join(' · ') + (related.length ? ` Relacionados: ${related.length}.` : ''), items: list([it, ...related.slice(0, 8)]) };
  }

  // filtros de listado / conteo
  const f = { open: true };
  const count = /\b(cuant[oa]s?|numero de|cantidad de)\b/.test(q);
  if (/\b(atrasad\w*|vencid\w*|retrasad\w*|con retraso)\b/.test(q)) f.due = 'late';
  else if (/\bpasado manana\b/.test(q)) f.due = 'days:2';
  else if (/\bmanana\b/.test(q)) f.due = 'tomorrow';
  else if ((m = q.match(/\bproxim\w*\s+(\d+)\s+dias\b/))) f.due = 'days:' + m[1];
  else if (/\b(que (hice|termine|complete)|hechas? esta semana|terminad\w+ esta semana|completad\w+ esta semana|logros?)\b/.test(q)) { f.doneSince = addDays(-7).toISOString(); f.open = false; }
  else if (/\b(esta semana|la semana|semana|proximos dias|proximamente|pronto)\b/.test(q)) f.due = 'week';
  else if (/\bhoy\b/.test(q)) f.due = 'today';
  else if (/\bsin fecha\b/.test(q)) f.noDue = true;
  else if (/\b(recientes?|ultim[oa]s?|lo nuevo|novedades)\b/.test(q)) { f.recent = true; f.limit = 10; }
  const type = typeOf(q); if (type) f.type = type;
  if (/\ben curso\b|\bhaciendo\b|\bactiv[oa]s?\b|\ben marcha\b|\ben progreso\b/.test(q)) f.status = 'doing';
  else if (/\bbloquead/.test(q)) f.status = 'blocked';
  else if (!f.doneSince && /\b(hech[oa]s?|terminad[oa]s?|completad[oa]s?|cerrad[oa]s?)\b/.test(q)) { f.status = 'done'; f.open = false; }
  else if (/\bideas?\b/.test(q)) f.status = 'idea';
  else if (type && type !== 'todo' && /\bpendientes?\b/.test(q)) f.status = 'todo';
  if (/\b(prioridad alta|urgentes?|importantes?|alta prioridad|prioritari[oa]s?)\b/.test(q)) f.priority = 'high';
  const area = areaOf(q); if (area) f.area = area;
  if ((m = raw.match(/(?:busca|buscar|buscame|encuentra|encontrar|hay algo (?:de|sobre)|algo sobre|relacionado con|sobre)\s+(.+?)\s*\??$/i)) || (m = raw.match(/"([^"]+)"/))) {
    let t = m[1].trim(); if (area && norm(t) === norm(area)) t = ''; if (t) { f.q = t; if (!f.status && !f.due) f.open = false; }
  }
  if (type === 'chat') f.open = false;
  const matched = f.due || f.type || f.status || f.priority || f.area || f.q || f.noDue || f.recent || f.doneSince;
  if (!matched) return { mode: 'local', answer: HELP, items: [] };
  const res = filterItems(f);
  const n = res.length;
  const onlySearch = f.q && !f.type && !f.status && !f.due && !f.priority && !f.area;
  let head = onlySearch ? (n ? `Encontré ${n} ${n === 1 ? 'resultado' : 'resultados'} sobre "${f.q}"` : `No encontré nada sobre "${f.q}"`)
    : count ? (n ? `Hay ${n} ${phrase(f, n)}` : `No hay ${phrase(f, 2)}`)
    : n ? `Tienes ${n} ${phrase(f, n)}` : `No tienes ${phrase(f, 2)}`;
  if ((f.due === 'week' || f.due === 'today' || f.due === 'tomorrow') && !count) { const late = filterItems({ due: 'late', type: f.type, area: f.area }).length; if (late) head += ` (además ${late === 1 ? 'hay 1 atrasado' : `hay ${late} atrasados`})`; }
  head += n && !count ? ':' : '.';
  return { mode: 'local', answer: head, items: list(res), count: n };
}

export async function ask(question) { return askLocal(question); }
export const TYPES_ES = TYPES;
