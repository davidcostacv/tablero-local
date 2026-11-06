// whatsapp.mjs — lee chats exportados de WhatsApp ("Exportar chat" → .txt, Android e iOS) y extrae
// compromisos concretos como to-dos. Sin dependencias; no toca la cuenta de WhatsApp.
import { parseDate } from './agent.mjs';

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
// Android: "12/3/24, 9:15 p. m. - Juan: hola"   "12/03/2024 21:15 - Juan: hola"
// iOS:     "[12/3/24, 21:15:30] Juan: hola"
const HEAD = /^\[?(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?\]?\s*(?:-\s*|–\s*)?([^:]{1,60}?):\s(.*)$/i;
const SYSTEM = /^(<multimedia omitido>|<media omitted>|image omitted|imagen omitida|video omitido|audio omitido|sticker omitido|documento omitido|gif omitido|se eliminó este mensaje|this message was deleted|eliminaste este mensaje|mensaje eliminado)/i;
const clean = (s) => s.replace(/[‎‏‪-‮⁦-⁩]/g, '').replace(/ | /g, ' ');

// Devuelve [{ iso, time, date: Date, sender, text }]
export function parseChat(raw, { dateOrder } = {}) {
  const lines = clean(String(raw).replace(/^﻿/, '')).split(/\r?\n/);
  const heads = [];
  for (const line of lines) {
    const m = line.match(HEAD);
    if (m) heads.push({ m, line });
    else if (heads.length) heads[heads.length - 1].tail = (heads[heads.length - 1].tail || '') + '\n' + line;
  }
  // orden de fecha: si algún primer número > 12 es d/m; si algún segundo > 12 es m/d; por defecto d/m (es)
  let order = dateOrder;
  if (!order) { if (heads.some((h) => Number(h.m[1]) > 12)) order = 'dmy'; else if (heads.some((h) => Number(h.m[2]) > 12)) order = 'mdy'; else order = 'dmy'; }
  return heads.map(({ m, line, tail }) => {
    const a = Number(m[1]), b = Number(m[2]); let y = Number(m[3]); if (y < 100) y += 2000;
    const d = order === 'mdy' ? b : a, mo = order === 'mdy' ? a : b;
    let h = Number(m[4]); const mi = Number(m[5]); const ap = (m[7] || '').toLowerCase();
    if (ap === 'p' && h < 12) h += 12; if (ap === 'a' && h === 12) h = 0;
    const text = (m[9] + (tail || '')).trim();
    return { iso: isoOf(y, mo, d), time: `${pad(h)}:${pad(mi)}`, date: new Date(y, mo - 1, d, h, mi), sender: m[8].trim(), text };
  });
}

const KEY = /\b(te (mando|envio|envío|paso|llevo|traigo|confirmo|aviso|llamo|pago|deposito|transfiero)|me (mandas|envias|envías|pasas|confirmas|avisas|llamas|pagas)|pago|pagar|pagamos|cobrar|cobro|deposito|transferencia|recuerdame|recuérdame|recordame|recordar|acordate|acuerdate|no (te )?olvides|pendiente|hay que|tengo que|tenes que|tenés que|tienes que|debo|debes|necesito|necesitamos|quedamos|confirmame|confírmame|avisame|avísame|llamame|llámame|reunion|reunión|cita|entrega|entregar|entrego|enviar|envio|envío|mandar|mando|revisar|reviso|terminar|termino|comprar|compro|llevar|traer|preparar|preparo|agendar|agenda|presupuesto|propuesta|factura|cotizacion|cotización|turno|visita|vence|vencimiento|fecha limite|fecha límite|deadline)\b/i;
const SHORT = /^(ok|oka|okey|dale|listo|gracias|si|sí|no|jaja|jeje|bueno|va|vale|genial|perfecto|claro|de una|buenas|hola|chau|chao|adios|adiós)[.!\s]*$/i;

// Candidatos a to-do: [{ type, title, due?, priority?, notes, contact?, source }]
export function extractTodos(messages, { contact, phone, chat = 'WhatsApp', me } = {}) {
  const out = [];
  // Si no se indica el contacto, es el otro participante (distinto de "me") cuando el chat es de dos.
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const others = [...new Set(messages.map((m) => m.sender))].filter((s) => !me || norm(s) !== norm(me));
  const fallback = contact || chatContactName(chat) || (others.length === 1 ? others[0] : '');
  for (const msg of messages) {
    const text = msg.text.replace(/\s+/g, ' ').trim();
    if (!text || SYSTEM.test(text) || SHORT.test(text) || text.length < 8 || /^https?:\/\/\S+$/i.test(text)) continue;
    const pd = parseDate(text, msg.date);
    const key = KEY.test(text);
    if (!key && !pd.date) continue;
    if (!key && !/[a-záéíóúñ]{4,}/i.test(pd.text)) continue;
    let title = (key ? text : pd.text).replace(/https?:\/\/\S+/g, '').trim();
    for (let i = 0; i < 3; i++) title = title.replace(/^(hola|buenas|buen dia|buen día|buenos dias|buenos días|che|oye|ey|hey)\b[^.!,:]{0,30}[,!.:]*\s*/i, '').replace(/^(bien|dale|listo|perfecto|ok|oka|genial|claro|vale|bueno|si|sí|gracias)[,.!:]\s*/i, '').trim();
    title = title.replace(/[.!?…\s]+$/g, '').trim();
    if (!title) continue;
    title = title.charAt(0).toUpperCase() + title.slice(1);
    if (title.length > 90) title = title.slice(0, 87).replace(/\s+\S*$/, '') + '…';
    const it = { type: 'todo', title, notes: `${msg.sender} (${msg.iso} ${msg.time}): ${msg.text}`.slice(0, 500), source: { kind: 'whatsapp', ref: `${chat}#${msg.iso}T${msg.time}#${msg.sender}`.slice(0, 300), title: chat } };
    if (pd.date) it.due = pd.date;
    if (/\b(urgente|importante|ya mismo|cuanto antes)\b/i.test(text)) it.priority = 'high';
    const name = fallback || msg.sender;
    if (name || phone) it.contact = { name: name || undefined, phone };
    out.push(it);
  }
  return out;
}

// "Chat de WhatsApp con Juan Pérez" / "WhatsApp Chat with Juan" -> "Juan Pérez"
export function chatContactName(chat) {
  const m = String(chat || '').replace(/\.txt$/i, '').match(/(?:chat de whatsapp con|whatsapp chat with)\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

export function importWhatsApp(raw, opts = {}) {
  const messages = parseChat(raw, opts);
  const senders = [...new Set(messages.map((m) => m.sender))];
  const todos = extractTodos(messages, opts);
  return { messages: messages.length, senders, todos };
}
