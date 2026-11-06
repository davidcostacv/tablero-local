// test-vault.mjs — pruebas del importador del vault con un vault sintético "sucio": node test-vault.mjs
// Genera un vault parecido al real (10 Memoria/areas, 30 Conversaciones/<área>, carpetas con espacios, frontmatter raro,
// CRLF, BOM, latin1, emojis…) en una carpeta temporal y comprueba que todo se mapea a valores que el tablero entiende.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'vault test '));
const VAULT = join(root, 'Google drive', 'Obsidian', 'Claude-Memoria');
const DATA = join(root, 'data');
process.env.VAULT = VAULT; process.env.DATA_DIR = DATA;

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };

// ---------- vault sintético ----------
export function makeVault(ROOT) {
  const w = (rel, text, { crlf = false, bom = false, latin1 = false } = {}) => {
    const f = join(ROOT, rel); mkdirSync(join(f, '..'), { recursive: true });
    let s = crlf ? text.replace(/\n/g, '\r\n') : text; if (bom) s = '﻿' + s;
    writeFileSync(f, latin1 ? Buffer.from(s, 'latin1') : s);
  };
  const long = 'Descripción muy larga '.repeat(200);
  const areas = [
    ['Taller de motos', `---\ntitle: Taller de motos 🏍️\narea: Taller\nstatus: doing\ndate: 2026-10-13\ntags: [taller, motos, clientes]\n---\n\nReseñas de Google y QR en mostrador.\n\n- [stated] pedir reseñas a los 20 últimos clientes\n- [inferred] poner QR en el mostrador\n`],
    ['Landing cliente Y', `---\ntitle: "Landing cliente Y"\narea: Freelance\nstatus: En curso\ndate: Oct 13 – Dec 2, 2026\ntags:\n  - freelance\n  - web\n---\n\n## Resumen\nLanding con formulario.\n\n- [stated] entregar el viernes\n`],
    ['Curso de IA', `---\ntitle: 'Curso de IA'\nstatus: completed\narea: Estudio\ndate: 2026-02-30\n---\nTerminado el módulo 3.\n`],
    ['Sin frontmatter', `Nota sin frontmatter: solo texto.\n\n- [stated] algo\n- [stated] otra cosa\n`],
    ['Vacía', ``],
    ['Solo frontmatter', `---\ntitle: Solo frontmatter\nstatus: blocked\n---\n`],
    ['Frontmatter roto', `---\ntitle: Frontmatter roto\nstatus doing\n: raro\n---sin cierre\n\nTexto.\n`],
    ['🚀', `---\ntitle: 🚀\nstatus: idea\narea: 🚀🔥\n---\nSolo emoji.\n`],
    ['Titulo largo', `---\ntitle: ${'Título larguísimo '.repeat(30)}\nstatus: doing\narea: ${'Área larguísima '.repeat(20)}\n---\n${long}\n`],
    ['Fechas raras', `---\ntitle: Fechas raras\ndate: "13/10/2026"\ndue: 2026-13-45\nstatus: TODO\n---\nhola\n`],
    ['Lista como título', `---\ntitle: [a, b]\narea: [Taller, Casa]\nstatus: [doing]\ntags: [x]\n---\nlista\n`],
    ['CRLF nota', `---\ntitle: CRLF nota\nstatus: done\narea: Casa\n---\n\nPrimer párrafo.\n\n- [stated] viñeta\n`, { crlf: true }],
    ['BOM nota', `---\ntitle: BOM nota\nstatus: doing\narea: Salud\n---\nCon BOM.\n`, { bom: true }],
    ['Latin1 nota', `---\ntitle: Nota con ñ y acentos áéíóú\nstatus: doing\narea: Finanzas\n---\nCafé, señal, ñandú.\n`, { latin1: true }],
    ['Duplicado', `---\ntitle: Duplicado\nstatus: doing\narea: Taller\n---\nuno\n`],
    ['duplicado 2', `---\ntitle: Duplicado\nstatus: done\narea: Taller\n---\ndos\n`],
    ['Null status', `---\ntitle: Null status\nstatus: null\narea: null\ndate: null\n---\nnull\n`],
    ['Quoted status', `---\ntitle: "Quoted"\nstatus: "doing"\narea: 'Familia'\n---\nquoted\n`],
    ['Area proto', `---\ntitle: Area proto\nstatus: doing\narea: __proto__\n---\nproto\n`],
    ['Area constructor', `---\ntitle: Area constructor\nstatus: doing\narea: constructor\n---\nctor\n`],
    ['Notas con html', `---\ntitle: <script>alert(1)</script>\nstatus: doing\narea: <b>Casa</b>\n---\n<img src=x onerror=alert(1)>\n\n- [stated] <i>x</i>\n`],
    ['Pausado', `---\ntitle: Pausado\nstatus: Pausado\narea: Freelance\ndate: 2025-01-01\n---\npausado\n`],
    ['Tipo trabajo', `---\ntitle: Tipo trabajo\ntype: trabajo\nstatus: in-progress\narea: Automatizaciones\n---\n- \n-\n* x\n`],
    ['Tipo raro', `---\ntitle: Tipo raro\ntype: cosa\nstatus: cosa\n---\nx\n`],
  ];
  areas.forEach(([name, text, o]) => w(join('10 Memoria', 'areas', name + '.md'), text, o));
  w(join('10 Memoria', 'areas', 'no-es-md.txt'), 'ignorar');
  w(join('10 Memoria', 'areas', 'sub carpeta', 'anidada.md'), '---\ntitle: anidada\n---\n');
  w(join('10 Memoria', 'perfil.md'), '---\ntitle: Perfil\n---\nPerfil de prueba.\n');
  w(join('20 Proyectos', 'Proyecto con due.md'), `---\ntitle: Proyecto con due\nstatus: doing\narea: Casa\ndue: 2026-11-10\n---\nIntro.\n`);
  w(join('20 Proyectos', 'Proyecto vencido.md'), `---\ntitle: Proyecto vencido\nstatus: todo\narea: Casa\ndue: 2025-11-10\n---\nIntro.\n`);
  const convAreas = ['Taller', 'Freelance', 'Familia', 'Estudio', 'Salud', 'Automatizaciones', 'Carpeta con espacios', 'ñ', '__proto__'];
  const uuid = (i) => `${(0x10000000 + i).toString(16).padStart(8, '0')}-1111-2222-3333-${String(i).padStart(12, '0')}`;
  const pad = (n) => String(n).padStart(2, '0');
  const statuses = ['doing', 'done', 'En curso', 'activo', 'Pausado', 'completed', 'blocked', 'idea', 'TODO', '', 'null', '~', 'in-progress', '[doing]', '"doing"'];
  for (let i = 0; i < 212; i++) {
    const area = convAreas[i % convAreas.length];
    const title = [`Chat ${i}`, `Chat ${i} — “comillas” y 'simples'`, '', '🚀🔥', 'Duplicado', 'T'.repeat(250), 'Conversación con: dos puntos', `[${i}] corchetes`, 'null', 'undefined'][i % 10];
    const fm = [];
    if (i % 3 !== 2) fm.push(`title: ${title}`);
    if (i % 4 !== 3) fm.push(`uuid: ${i % 7 === 6 ? 'no-es-uuid' : uuid(i)}`);
    fm.push(`date: ${[`2026-${pad(1 + (i % 11))}-${pad(1 + (i % 28))}`, '2026-10-13T14:00:00Z', 'Oct 13 – Dec 2, 2026', '', 'null', '2026-02-30'][i % 6]}`);
    if (i % 5 === 0) fm.push(`tags: [${area}, chat, "con comillas"]`);
    if (i % 9 === 0) fm.push(`status: ${statuses[i % statuses.length]}`);
    const body = i % 8 === 7 ? '' : `## Resumen\n${i % 11 === 10 ? long : `Resumen del chat ${i} con ${area}.`}\n\n## Decisiones\n- [stated] decisión ${i}\n- [inferred] otra\n`;
    const fname = [`chat-${i}`, `Chat ${i} con espacios`, `${i}-ñandú`, i === 5 ? '🚀' : `c${i}`][i % 4];
    w(join('30 Conversaciones', area, fname + '.md'), `---\n${fm.join('\n')}\n---\n${body}`, { crlf: i % 2 === 0, bom: i % 13 === 0, latin1: i % 17 === 0 });
  }
  w(join('30 Conversaciones', 'suelto.md'), '---\ntitle: suelto\n---\nno está en subcarpeta\n');
  w(join('40 Otros temas', 'cosa.md'), 'otro');
  w(join('00 Inbox', 'nota.md'), '---\ntitle: inbox\n---\n');
  return { areas: areas.length, chats: 212, projects: 2 };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const n = makeVault(VAULT);
  const { collect, parse, dateOf, mapStatus, mapType } = await import('./import-vault.mjs');
  const { upsertMany, load, clean, TYPES, STATUSES } = await import('./store.mjs');

  // parse / mapeos unitarios
  t('parse: BOM + CRLF', parse('﻿---\r\ntitle: X\r\n---\r\ncuerpo').fm.title === 'X' && parse('﻿---\r\ntitle: X\r\n---\r\ncuerpo').body === 'cuerpo');
  t('parse: lista en varias líneas', JSON.stringify(parse('---\ntags:\n  - a\n  - b\n---\n').fm.tags) === '["a","b"]');
  t('parse: sin cierre no es frontmatter', Object.keys(parse('---\ntitle: x\n---sin cierre\nhola').fm).length === 0);
  t('dateOf: ISO, ISO con hora, d/m/Y', dateOf('2026-10-13') === '2026-10-13' && dateOf('2026-10-13T14:00:00Z') === '2026-10-13' && dateOf('13/10/2026') === '2026-10-13');
  t('dateOf: rango en inglés, 30 de febrero, null → undefined', dateOf('Oct 13 – Dec 2, 2026') === undefined && dateOf('2026-02-30') === undefined && dateOf('null') === undefined);
  t('mapStatus: español/inglés/comillas/corchetes', mapStatus('En curso') === 'doing' && mapStatus('completed') === 'done' && mapStatus('"doing"') === 'doing' && mapStatus('[doing]') === 'doing' && mapStatus('Pausado') === 'blocked' && mapStatus('TODO') === 'todo' && mapStatus('cosa', 'doing') === 'doing' && mapStatus('null', 'doing') === 'doing');
  t('mapType: alias', mapType('trabajo', 'project') === 'job' && mapType('estudiar', 'project') === 'study' && mapType('cosa', 'project') === 'project');

  // recolección completa
  const items = collect(VAULT);
  t(`recolecta ${n.areas} áreas + ${n.projects} proyectos + ${n.chats} chats`, items.length === n.areas + n.projects + n.chats, items.length);
  t('todos los type/status son conocidos', items.every((i) => TYPES.includes(i.type) && STATUSES.includes(i.status)), items.filter((i) => !TYPES.includes(i.type) || !STATUSES.includes(i.status)).map((i) => [i.title, i.type, i.status]));
  t('todos pasan clean() sin lanzar', items.every((i) => { try { clean(i); return true; } catch { return false; } }));
  const by = (title) => items.find((i) => i.title === title);
  t('área con status "En curso" → doing', by('Landing cliente Y') && by('Landing cliente Y').status === 'doing' && by('Landing cliente Y').date === undefined && JSON.stringify(by('Landing cliente Y').tags) === '["freelance","web"]', by('Landing cliente Y'));
  t('"completed" → done; 2026-02-30 se descarta', by('Curso de IA').status === 'done' && by('Curso de IA').date === undefined);
  t('"Pausado" → blocked', by('Pausado').status === 'blocked');
  t('type: trabajo → job, in-progress → doing', by('Tipo trabajo').type === 'job' && by('Tipo trabajo').status === 'doing');
  t('type/status desconocidos → project/doing', by('Tipo raro').type === 'project' && by('Tipo raro').status === 'doing');
  t('título entre comillas se limpia', !!by('Quoted') && by('Quoted').area === 'Familia' && by('Quoted').status === 'doing');
  t('título lista [a, b] → "a, b"; área lista → "Taller, Casa"', !!by('a, b') && by('a, b').area === 'Taller, Casa' && by('a, b').status === 'doing');
  t('status/área null → defecto (área = título)', by('Null status').status === 'doing' && by('Null status').area === 'Null status');
  t('sin frontmatter: título = nombre de archivo, viñetas en notas', by('Sin frontmatter') && /- \[stated\] algo\n- \[stated\] otra cosa/.test(by('Sin frontmatter').notes));
  t('nota vacía: título del archivo y sin notas', by('Vacía') && !by('Vacía').notes);
  t('latin1: se importa sin lanzar (caracteres sustituidos)', items.some((i) => /^Nota con /.test(i.title)));
  t('BOM: título limpio', !!by('BOM nota'));
  t('CRLF: notas sin \\r', by('CRLF nota') && !/\r/.test(by('CRLF nota').notes) && /viñeta/.test(by('CRLF nota').notes));
  t('emoji como título', !!by('🚀') && by('🚀').area === '🚀🔥');
  t('fecha 13/10/2026 → 2026-10-13; due inválido se descarta', by('Fechas raras').date === '2026-10-13' && by('Fechas raras').due === undefined && by('Fechas raras').status === 'todo');
  t('20 Proyectos: due', by('Proyecto con due').due === '2026-11-10');
  t('carpetas anidadas y perfil.md no se importan', !by('anidada') && !by('Perfil') && !by('suelto') && !by('inbox'));
  const chats = items.filter((i) => i.type === 'chat');
  t('chats: todos done, área = carpeta', chats.every((c) => c.status === 'done' && c.area));
  t('chats con uuid → url claude.ai y source claude-chat', chats.some((c) => c.url && c.source.kind === 'claude-chat' && /^https:\/\/claude\.ai\/chat\//.test(c.url)) && chats.every((c) => !c.url || c.source.kind === 'claude-chat'));
  t('chats sin uuid → source vault con ruta relativa con /', chats.some((c) => c.source.kind === 'vault' && /^30 Conversaciones\/[^\\]+\.md$/.test(c.source.ref)));
  t('chats sin título en frontmatter → nombre del archivo', chats.some((c) => /^Chat \d+ con espacios$/.test(c.title)));
  t('chats: fechas solo válidas', chats.every((c) => !c.date || /^\d{4}-\d{2}-\d{2}$/.test(c.date)) && chats.some((c) => c.date === '2026-10-13'));
  t('chats: resumen en notas', chats.some((c) => /^Resumen del chat/.test(c.notes)));

  // importación real e idempotencia
  const r1 = upsertMany(items);
  t('importa todo', r1.length === items.length && r1.every((r) => r.created));
  const stored = load();
  t('guardado con id/createdAt y campos saneados (título ≤ 200, notas ≤ 2000)', stored.every((i) => i.id && i.createdAt && i.title.length <= 200 && (!i.notes || i.notes.length <= 2000)));
  const r2 = upsertMany(collect(VAULT));
  t('reimportar: 0 nuevos (dedupe por fuente + título)', r2.every((r) => !r.created) && load().length === stored.length, r2.filter((r) => r.created).map((r) => r.item.title));
  const { patch } = await import('./store.mjs');
  const edited = stored.find((i) => i.title === 'Landing cliente Y');
  patch(edited.id, { status: 'done' });
  upsertMany(collect(VAULT));
  t('reimportar conserva el status editado en el tablero', load().find((i) => i.id === edited.id).status === 'done');

  rmSync(root, { recursive: true, force: true });
  console.log(`${pass} ok, ${fail} fallos`);
  process.exit(fail ? 1 : 0);
}
