'use strict';
// 生成托盘图标与 app 图标，不依赖任何图像库
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'assets');
fs.mkdirSync(OUT, { recursive: true });

let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

function png(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]);
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    (a[3] !== undefined ? a[3] : 255) + ((b[3] !== undefined ? b[3] : 255) - (a[3] !== undefined ? a[3] : 255)) * t
  ];
}

// 圆环：t=0 在 12 点，顺时针 0..1；gap 区间不画
function ringAlpha(dx, dy, cx, cy, rOuter, rInner, gapFrom, gapTo, W) {
  const d = Math.hypot(dx - cx, dy - cy);
  if (d > rOuter || d < rInner) return 0;
  let t = Math.atan2(dy - cy, dx - cx) + Math.PI / 2;
  while (t < 0) t += Math.PI * 2;
  t = t / (Math.PI * 2);
  if (t >= gapFrom && t < gapTo) return 0;
  return 1;
}

function roundedRectAlpha(x, y, w, h, r) {
  const rx = Math.min(Math.max(x, r), w - r);
  const ry = Math.min(Math.max(y, r), h - r);
  const inside = x >= 0 && y >= 0 && x <= w && y <= h;
  if (!inside) return 0;
  if (x < r && y < r) return Math.hypot(x - r, y - r) <= r ? 1 : 0;
  if (x > w - r && y < r) return Math.hypot(x - (w - r), y - r) <= r ? 1 : 0;
  if (x < r && y > h - r) return Math.hypot(x - r, y - (h - r)) <= r ? 1 : 0;
  if (x > w - r && y > h - r) return Math.hypot(x - (w - r), y - (h - r)) <= r ? 1 : 0;
  return 1;
}

/* ---------- 托盘：单色 template ---------- */
function trayIcon(size) {
  const SS = 4;
  const N = size * SS;
  const out = Buffer.alloc(size * size * 4);
  const cx = N / 2, cy = N / 2;
  // 16px 画布里：外半径 6.5px、内半径 3.5px（换算成分数），留 1.5px 边距，别被裁
  // 不做缺口：16px 上的缺口会读成"缺角"，反而脏。缺口留给 Dock 大图标去表达
  const rOuter = N * 0.406, rInner = N * 0.219;
  const gapFrom = 1.01, gapTo = 1.01;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          acc += ringAlpha(x * SS + sx + 0.5, y * SS + sy + 0.5, cx, cy, rOuter, rInner, gapFrom, gapTo, N);
        }
      }
      const a = Math.round((acc / (SS * SS)) * 255);
      const i = (y * size + x) * 4;
      out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = a;
    }
  }
  return png(size, out);
}

/* ---------- app 图标：深底 + 环形进度 ---------- */
function appIcon(size) {
  const SS = size > 256 ? 3 : 4;
  const N = size * SS;
  const out = Buffer.alloc(size * size * 4);
  const cx = N / 2, cy = N / 2;
  const pad = N * 0.13;
  const w = N - pad * 2;
  const radius = N * 0.215;
  const rOuter = N * 0.315, rInner = N * 0.238;

  const BG = [26, 25, 23];
  const LIGHT = [237, 232, 224];
  const ACCENT = [201, 85, 63];
  const DIM = [74, 69, 63];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      let n = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;
          n++;
          const bgA = roundedRectAlpha(px - pad, py - pad, w, w, radius);
          if (bgA <= 0) continue;

          let col = BG;
          const d = Math.hypot(px - cx, py - cy);
          if (d <= rOuter && d >= rInner) {
            let t = Math.atan2(py - cy, px - cx) + Math.PI / 2;
            while (t < 0) t += Math.PI * 2;
            t = t / (Math.PI * 2);
            // 起点一小段赭红，然后暖白，剩余暗灰
            if (t < 0.045) col = ACCENT;
            else if (t < 0.66) col = LIGHT;
            else col = DIM;
          } else if (d < rInner) {
            col = BG;
          }
          r += col[0]; g += col[1]; b += col[2];
          a += bgA * 255;
        }
      }
      const i = (y * size + x) * 4;
      out[i] = n ? Math.round(r / n) : 0;
      out[i + 1] = n ? Math.round(g / n) : 0;
      out[i + 2] = n ? Math.round(b / n) : 0;
      out[i + 3] = Math.round(a / n);
    }
  }
  return png(size, out);
}

fs.writeFileSync(path.join(OUT, 'trayTemplate.png'), trayIcon(16));
fs.writeFileSync(path.join(OUT, 'trayTemplate@2x.png'), trayIcon(32));

const sizes = [16, 32, 64, 128, 256, 512, 1024];
const iconset = path.join(OUT, 'icon.iconset');
fs.mkdirSync(iconset, { recursive: true });
const names = {
  16: ['icon_16x16.png'],
  32: ['icon_16x16@2x.png', 'icon_32x32.png'],
  64: ['icon_32x32@2x.png'],
  128: ['icon_128x128.png'],
  256: ['icon_128x128@2x.png', 'icon_256x256.png'],
  512: ['icon_256x256@2x.png', 'icon_512x512.png'],
  1024: ['icon_512x512@2x.png']
};
for (const s of sizes) {
  const buf = appIcon(s);
  fs.writeFileSync(path.join(OUT, 'icon-' + s + '.png'), buf);
  for (const nm of names[s]) fs.writeFileSync(path.join(iconset, nm), buf);
}
console.log('icons generated');
