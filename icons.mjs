// icons.mjs — genera public/icon-192.png y public/icon-512.png (mismo dibujo que icon.svg) con un codificador PNG
// mínimo en JS puro (zlib + CRC de node:). Uso: node icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };

export function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; for (let x = 0; x < size; x++) { const [r, g, b, a] = pixel(x, y); const o = y * (size * 4 + 1) + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// Dibujo: cuadrado redondeado oscuro con una "T" blanca (coordenadas en base 512, como icon.svg).
function pixel(size) {
  const s = 512 / size, inRound = (x, y, w, h, r, X, Y) => { const dx = Math.max(X - x - r, 0, x + r - (X + w)), dy = Math.max(Y - y - r, 0, y + r - (Y + h)); return dx * dx + dy * dy <= r * r; };
  return (px, py) => {
    let r = 0, g = 0, b = 0, a = 0, hits = 0;
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) { // 2x2 supermuestreo
      const x = (px + (sx + 0.5) / 2) * s, y = (py + (sy + 0.5) / 2) * s;
      if (!inRound(x, y, 512, 512, 112, 0, 0)) continue;
      hits++;
      const white = inRound(x, y, 256, 56, 14, 128, 136) || inRound(x, y, 56, 240, 14, 228, 136);
      if (white) { r += 255; g += 255; b += 255; } else { r += 0x1a; g += 0x1b; b += 0x1f; }
      a += 255;
    }
    return hits ? [Math.round(r / hits), Math.round(g / hits), Math.round(b / hits), Math.round(a / 4)] : [0, 0, 0, 0];
  };
}
if (/^icons\.mjs$/.test((process.argv[1] || '').split(/[\\/]/).pop())) {
  for (const size of [192, 512]) { const out = join(import.meta.dirname, 'public', `icon-${size}.png`); writeFileSync(out, png(size, pixel(size))); console.log('escrito', out); }
}
