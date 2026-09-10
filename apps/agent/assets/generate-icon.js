const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// Draws a rounded-square "P" glyph on a leaf-green background.
function drawIcon(size) {
  const bg = [31, 111, 84]; // brand --leaf
  const fg = [255, 255, 255];
  const px = (x, y) => {
    const cx = size / 2;
    const cy = size / 2;
    const r = size * 0.46;
    const dx = x - cx + 0.5;
    const dy = y - cy + 0.5;
    if (dx * dx + dy * dy > r * r) return null; // outside circle = transparent
    // simple "P" glyph bounding box
    const gx = (x / size) * 10;
    const gy = (y / size) * 10;
    const stem = gx >= 3.2 && gx < 4.4 && gy >= 2.2 && gy < 7.8;
    const bowl =
      gx >= 3.2 &&
      gx < 6.6 &&
      gy >= 2.2 &&
      gy < 5.2 &&
      !(gx >= 4.4 && gx < 5.8 && gy >= 3.1 && gy < 4.3);
    if (stem || bowl) return fg;
    return bg;
  };

  const rowBytes = size * 4 + 1;
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const color = px(x, y);
      const off = y * rowBytes + 1 + x * 4;
      if (!color) {
        raw[off] = raw[off + 1] = raw[off + 2] = raw[off + 3] = 0;
      } else {
        raw[off] = color[0];
        raw[off + 1] = color[1];
        raw[off + 2] = color[2];
        raw[off + 3] = 255;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname);
fs.writeFileSync(path.join(outDir, "icon.png"), drawIcon(512));
fs.writeFileSync(path.join(outDir, "tray.png"), drawIcon(32));
fs.writeFileSync(path.join(outDir, "tray@2x.png"), drawIcon(64));
console.log("Generated icon.png, tray.png, tray@2x.png");
