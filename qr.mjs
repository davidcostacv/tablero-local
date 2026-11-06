// qr.mjs — codificador QR mínimo en JS puro (modo byte, niveles L/M, versiones 1–10), sin dependencias.
// Uso: matrix(texto, 'L') -> [[0/1]], svg(m), ascii(m). Incluye decode(m) para verificar en pruebas.

// ---------- GF(256) y Reed-Solomon ----------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
export function rsGenerator(n) { let g = [1]; for (let i = 0; i < n; i++) { const ng = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); } g = ng; } return g; }
export function rsEncode(data, n) {
  const g = rsGenerator(n), r = new Array(n).fill(0);
  for (const d of data) { const f = d ^ r[0]; r.shift(); r.push(0); if (f) for (let j = 0; j < n; j++) r[j] ^= mul(g[j + 1], f); }
  return r;
}
// Síndromes: cero si (datos||ec) es divisible por el generador.
export function rsSyndromes(codeword, n) { const out = []; for (let i = 0; i < n; i++) { let s = 0; for (const c of codeword) s = mul(s, EXP[i]) ^ c; out.push(s); } return out; }

// ---------- tablas (versiones 1–10) ----------
// [ecPorBloque, [ [bloques, datosPorBloque], ... ]]
const EC = {
  L: [null, [7, [[1, 19]]], [10, [[1, 34]]], [15, [[1, 55]]], [20, [[1, 80]]], [26, [[1, 108]]], [18, [[2, 68]]], [20, [[2, 78]]], [24, [[2, 97]]], [30, [[2, 116]]], [18, [[2, 68], [2, 69]]]],
  M: [null, [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]], [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]],
};
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const dataCapacity = (v, lvl) => EC[lvl][v][1].reduce((n, [b, d]) => n + b * d, 0);

// BCH para información de formato (15 bits) y de versión (18 bits)
// resto de (data · x^deg) módulo el polinomio generador (deg = grado de poly); dataBits = ancho de data
const bch = (data, poly, dataBits) => { const deg = 31 - Math.clz32(poly); let r = data << deg; for (let i = deg + dataBits - 1; i >= deg; i--) if ((r >> i) & 1) r ^= poly << (i - deg); return r; };
export const formatBits = (lvl, mask) => { const d = (LEVEL_BITS[lvl] << 3) | mask; return ((d << 10) | bch(d, 0x537, 5)) ^ 0x5412; };
export const versionBits = (v) => (v << 12) | bch(v, 0x1f25, 6);

// ---------- codificación ----------
function encodeData(text, v, lvl) {
  const bytes = [...Buffer.from(text, 'utf8')], cap = dataCapacity(v, lvl), bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(4, 4); push(bytes.length, v >= 10 ? 16 : 8); bytes.forEach((b) => push(b, 8));
  push(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const cw = []; for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0; cw.length < cap; p++) cw.push(p % 2 ? 0x11 : 0xec);
  return cw;
}
function interleave(cw, v, lvl) {
  const [ecn, groups] = EC[lvl][v], blocks = []; let o = 0;
  for (const [n, len] of groups) for (let i = 0; i < n; i++) { const d = cw.slice(o, o + len); o += len; blocks.push({ d, e: rsEncode(d, ecn) }); }
  const out = [], maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecn; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}
export function chooseVersion(text, lvl) { const n = Buffer.byteLength(text, 'utf8'); for (let v = 1; v <= 10; v++) if (n <= dataCapacity(v, lvl) - 2 - (v >= 10 ? 1 : 0)) return v; throw new Error('texto demasiado largo para QR v10 (' + n + ' bytes)'); }

function functionMask(v) { // true donde hay patrones fijos (no datos)
  const n = v * 4 + 17, f = Array.from({ length: n }, () => new Array(n).fill(false));
  const box = (r, c, s) => { for (let i = 0; i < s; i++) for (let j = 0; j < s; j++) if (r + i >= 0 && r + i < n && c + j >= 0 && c + j < n) f[r + i][c + j] = true; };
  box(0, 0, 9); box(0, n - 8, 9); box(n - 8, 0, 9); // finders + separadores + formato
  for (let i = 0; i < n; i++) { f[6][i] = true; f[i][6] = true; }
  const a = ALIGN[v]; for (const r of a) for (const c of a) { if ((r < 9 && c < 9) || (r < 9 && c > n - 10) || (r > n - 10 && c < 9)) continue; box(r - 2, c - 2, 5); }
  if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { f[i][n - 11 + j] = true; f[n - 11 + j][i] = true; }
  return f;
}
function drawFunction(m, v) {
  const n = m.length, set = (r, c, val) => { if (r >= 0 && r < n && c >= 0 && c < n) m[r][c] = val; };
  const finder = (r, c) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const on = i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4)); set(r + i, c + j, on ? 1 : 0); } };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) { m[6][i] = i % 2 === 0 ? 1 : 0; m[i][6] = i % 2 === 0 ? 1 : 0; }
  const a = ALIGN[v]; for (const r of a) for (const c of a) { if ((r < 9 && c < 9) || (r < 9 && c > n - 10) || (r > n - 10 && c < 9)) continue; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1 ? 1 : 0); }
  m[n - 8][8] = 1; // módulo oscuro
  if (v >= 7) { const b = versionBits(v); for (let i = 0; i < 18; i++) { const bit = (b >> i) & 1, r = Math.floor(i / 3), c = n - 11 + (i % 3); m[r][c] = bit; m[c][r] = bit; } }
}
function drawFormat(m, lvl, mask) {
  const n = m.length, b = formatBits(lvl, mask), bit = (i) => (b >> i) & 1;
  for (let i = 0; i < 6; i++) m[8][i] = bit(14 - i);
  m[8][7] = bit(8); m[8][8] = bit(7); m[7][8] = bit(6);
  for (let i = 0; i < 6; i++) m[5 - i][8] = bit(5 - i);
  for (let i = 0; i < 8; i++) m[n - 1 - i][8] = bit(14 - i);
  for (let i = 0; i < 8; i++) m[8][n - 8 + i] = bit(7 - i);
}
// Recorre los módulos de datos en el orden de colocación (zigzag desde abajo a la derecha).
function dataPath(n, fn) {
  const out = []; let up = true;
  for (let c = n - 1; c > 0; c -= 2) { if (c === 6) c--; for (let k = 0; k < n; k++) { const r = up ? n - 1 - k : k; for (const cc of [c, c - 1]) if (!fn[r][cc]) out.push([r, cc]); } up = !up; }
  return out;
}
const MASKS = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];
function penalty(m) {
  const n = m.length; let p = 0;
  const run = (get) => { for (let i = 0; i < n; i++) { let last = -1, len = 0; for (let j = 0; j < n; j++) { const v = get(i, j); if (v === last) len++; else { if (len >= 5) p += len - 2; last = v; len = 1; } } if (len >= 5) p += len - 2; } };
  run((i, j) => m[i][j]); run((i, j) => m[j][i]);
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) { const v = m[i][j]; if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) p += 3; }
  const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const scan = (get) => { for (let i = 0; i < n; i++) for (let j = 0; j <= n - 11; j++) { let a = true, b = true; for (let k = 0; k < 11; k++) { const v = get(i, j + k); if (v !== pat[k]) a = false; if (v !== pat2[k]) b = false; } if (a) p += 40; if (b) p += 40; } };
  scan((i, j) => m[i][j]); scan((i, j) => m[j][i]);
  let dark = 0; for (const row of m) for (const v of row) dark += v; const pct = (dark * 100) / (n * n); p += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return p;
}
export function matrix(text, lvl = 'L', opts = {}) {
  if (!EC[lvl]) throw new Error('nivel no soportado: ' + lvl);
  const v = opts.version || chooseVersion(text, lvl), n = v * 4 + 17;
  const cw = interleave(encodeData(text, v, lvl), v, lvl), fn = functionMask(v), path = dataPath(n, fn);
  const bits = []; for (const c of cw) for (let i = 7; i >= 0; i--) bits.push((c >> i) & 1);
  let best = null, bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    if (opts.mask !== undefined && mask !== opts.mask) continue;
    const m = Array.from({ length: n }, () => new Array(n).fill(0));
    drawFunction(m, v);
    path.forEach(([r, c], i) => { m[r][c] = (bits[i] || 0) ^ (MASKS[mask](r, c) ? 1 : 0); });
    drawFormat(m, lvl, mask);
    const p = penalty(m); if (p < bestP) { bestP = p; best = m; best.version = v; best.mask = mask; best.level = lvl; }
  }
  return best;
}

// Lectura (sin corrección de errores): verifica formato, desenmascara, extrae palabras y comprueba síndromes RS.
export function decode(m) {
  const n = m.length, v = (n - 17) / 4;
  let fb = 0; for (let i = 0; i < 6; i++) fb = (fb << 1) | m[8][i]; fb = (fb << 1) | m[8][7]; fb = (fb << 1) | m[8][8]; fb = (fb << 1) | m[7][8]; for (let i = 5; i >= 0; i--) fb = (fb << 1) | m[i][8];
  let lvl = null, mask = -1; for (const L of Object.keys(LEVEL_BITS)) for (let k = 0; k < 8; k++) if (formatBits(L, k) === fb) { lvl = L; mask = k; }
  if (!lvl) throw new Error('información de formato inválida');
  if (v >= 7) { let vb = 0; for (let i = 17; i >= 0; i--) vb = (vb << 1) | m[Math.floor(i / 3)][n - 11 + (i % 3)]; if (vb !== versionBits(v)) throw new Error('información de versión inválida'); }
  const fn = functionMask(v), path = dataPath(n, fn), bits = path.map(([r, c]) => m[r][c] ^ (MASKS[mask](r, c) ? 1 : 0));
  const total = Math.floor(bits.length / 8), cw = []; for (let i = 0; i < total; i++) cw.push(parseInt(bits.slice(i * 8, i * 8 + 8).join(''), 2));
  const [ecn, groups] = EC[lvl][v], blocks = []; for (const [k, len] of groups) for (let i = 0; i < k; i++) blocks.push({ d: new Array(len), e: new Array(ecn) });
  let p = 0; const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) b.d[i] = cw[p++];
  for (let i = 0; i < ecn; i++) for (const b of blocks) b.e[i] = cw[p++];
  for (const b of blocks) if (rsSyndromes(b.d.concat(b.e), ecn).some((s) => s)) throw new Error('síndromes RS distintos de cero');
  const data = blocks.flatMap((b) => b.d), db = []; for (const c of data) for (let i = 7; i >= 0; i--) db.push((c >> i) & 1);
  const take = (k) => { let x = 0; for (let i = 0; i < k; i++) x = (x << 1) | db.shift(); return x; };
  if (take(4) !== 4) throw new Error('modo no byte'); const len = take(v >= 10 ? 16 : 8), bytes = []; for (let i = 0; i < len; i++) bytes.push(take(8));
  return { text: Buffer.from(bytes).toString('utf8'), version: v, level: lvl, mask };
}

// ---------- salidas ----------
export function svg(m, scale = 6, quiet = 4) {
  const n = m.length, s = (n + quiet * 2) * scale, rects = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) rects.push(`M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${rects.join('')}" fill="#000"/></svg>`;
}
export function ascii(m, { color = true, quiet = 2 } = {}) {
  const n = m.length, dark = color ? '\x1b[40m  \x1b[0m' : '██', light = color ? '\x1b[47m  \x1b[0m' : '  ', lines = [];
  for (let r = -quiet; r < n + quiet; r++) { let line = ''; for (let c = -quiet; c < n + quiet; c++) line += r >= 0 && r < n && c >= 0 && c < n && m[r][c] ? dark : light; lines.push(line); }
  return lines.join('\n');
}
