/**
 * Writes assets/icon.png — orange play-triangle matching the overlay (#ff8c14).
 * Run from npm run build before copy-assets.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const OUT = path.join(__dirname, '..', 'assets', 'icon.png');
// Match src/renderer/index.html idle fill
const R = 255;
const G = 140;
const B = 20;

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, t, data, crc]);
}

// Same geometry as tray icon in main/index.ts, scaled from 16×16 → 256×256
const ax = 13 * 16;
const ay = 7 * 16;
const bx = 2 * 16;
const by = 2 * 16;
const cx = 2 * 16;
const cy = 12 * 16;

function sign(px, py, x1, y1, x2, y2) {
  return (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
}

function inTri(px, py) {
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4), 0);
for (let y = 0; y < SIZE; y++) {
  raw[y * (1 + SIZE * 4)] = 0;
  for (let x = 0; x < SIZE; x++) {
    let a = 0;
    if (inTri(x + 0.5, y + 0.5)) a = 255;
    else {
      for (let dy = -1; dy <= 1 && !a; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (inTri(x + 0.5 + dx * 7.2, y + 0.5 + dy * 7.2)) {
            a = 90;
            break;
          }
        }
      }
    }
    if (a > 0) {
      const o = y * (1 + SIZE * 4) + 1 + x * 4;
      raw[o] = R;
      raw[o + 1] = G;
      raw[o + 2] = B;
      raw[o + 3] = a;
    }
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`  wrote  ${path.relative(path.join(__dirname, '..'), OUT)}`);
