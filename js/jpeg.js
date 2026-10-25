/* 极简 JPEG 解码器（baseline SOF0，8 位，任意采样率）
 * 用途：读取 Corel Painter .nib（30×30 JPEG）等小图。
 * 不支持 progressive/算术编码，遇到会抛错，由调用方回退。
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';

  const ZIGZAG = new Int32Array([
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
  ]);

  const COS = new Float32Array(64);
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos((2 * x + 1) * u * Math.PI / 16) / 2;

  function isJpeg(bytes) { return bytes && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8; }

  function decode(bytes) {
    if (!isJpeg(bytes)) throw new Error('不是 JPEG');
    let p = 2;
    const qt = [], dcT = [], acT = [];
    let frame = null, restartInterval = 0, sosOff = -1, sosTables = null;

    function u16() { const v = (bytes[p] << 8) | bytes[p + 1]; p += 2; return v; }

    while (p < bytes.length - 1) {
      if (bytes[p] !== 0xff) { p++; continue; }
      const m = bytes[p + 1];
      p += 2;
      if (m === 0x00 || m === 0xff) { p--; continue; }
      if (m === 0xd8 || m === 0xd9) continue;
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
      const len = u16();
      const end = p + len - 2;
      if (m === 0xdb) {
        while (p < end) {
          const pq = bytes[p] >> 4, tq = bytes[p] & 15; p++;
          const z = new Uint16Array(64);
          for (let i = 0; i < 64; i++) z[i] = pq ? u16() : bytes[p++];
          const t = new Uint16Array(64);
          for (let i = 0; i < 64; i++) t[ZIGZAG[i]] = z[i];
          qt[tq] = t;
        }
      } else if (m === 0xc4) {
        while (p < end) {
          const tc = bytes[p] >> 4, th = bytes[p] & 15; p++;
          const counts = bytes.subarray(p, p + 16); p += 16;
          let total = 0;
          for (let i = 0; i < 16; i++) total += counts[i];
          const vals = bytes.subarray(p, p + total); p += total;
          const table = new Map();
          let code = 0, k = 0;
          for (let l = 1; l <= 16; l++) {
            for (let j = 0; j < counts[l - 1]; j++) { table.set((l << 16) | code, vals[k++]); code++; }
            code <<= 1;
          }
          if (tc === 0) dcT[th] = table; else acT[th] = table;
        }
      } else if (m === 0xc0 || m === 0xc1) {
        const prec = bytes[p++];
        if (prec !== 8) throw new Error('only 8-bit JPEG');
        const h = u16(), w = u16();
        const nc = bytes[p++];
        const comps = [];
        for (let i = 0; i < nc; i++) { comps.push({ id: bytes[p], hs: bytes[p + 1] >> 4, vs: bytes[p + 1] & 15, tq: bytes[p + 2] }); p += 3; }
        frame = { w: w, h: h, comps: comps };
      } else if (m === 0xdd) {
        restartInterval = u16();
      } else if (m === 0xda) {
        const ns = bytes[p];
        let q = p + 1;
        sosTables = [];
        for (let i = 0; i < ns; i++) { sosTables.push({ id: bytes[q], td: bytes[q + 1] >> 4, ta: bytes[q + 1] & 15 }); q += 2; }
        p = end;
        sosOff = end;
        break;
      }
      p = end;
    }
    if (!frame) throw new Error('no SOF0');
    if (sosOff < 0) throw new Error('no SOS');

    const data = [];
    for (let i = sosOff; i < bytes.length - 1; i++) {
      if (bytes[i] === 0xff) {
        const n = bytes[i + 1];
        if (n === 0x00) { data.push(0xff); i++; continue; }
        if (n >= 0xd0 && n <= 0xd7) { data.push(0xff, n); i++; continue; }
        break;
      }
      data.push(bytes[i]);
    }
    const scan = new Uint8Array(data);

    let bp = 0, bitBuf = 0, bitCnt = 0;
    function readBit() {
      if (bitCnt === 0) { if (bp >= scan.length) return 1; bitBuf = scan[bp++]; bitCnt = 8; }
      bitCnt--;
      return (bitBuf >> bitCnt) & 1;
    }
    function receive(n) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | readBit(); return v; }
    function extend(v, n) { if (n === 0) return 0; const vt = 1 << (n - 1); return v < vt ? v - (1 << n) + 1 : v; }
    function huff(t) {
      let code = 0;
      for (let l = 1; l <= 16; l++) {
        code = (code << 1) | readBit();
        const v = t.get((l << 16) | code);
        if (v !== undefined) return v;
      }
      throw new Error('bad huffman');
    }

    const hmax = Math.max.apply(null, frame.comps.map(c => c.hs));
    const vmax = Math.max.apply(null, frame.comps.map(c => c.vs));
    const mcusX = Math.ceil(frame.w / (8 * hmax)), mcusY = Math.ceil(frame.h / (8 * vmax));
    const planes = frame.comps.map(c => {
      const cw = Math.ceil(Math.ceil(frame.w * c.hs / hmax) / 8) * 8;
      const ch = Math.ceil(Math.ceil(frame.h * c.vs / vmax) / 8) * 8;
      return { w: cw, h: ch, data: new Uint8Array(cw * ch) };
    });
    const preds = frame.comps.map(() => 0);
    const coeff = new Int32Array(64), rowT = new Float32Array(64), blk = new Float32Array(64), out8 = new Float32Array(64);

    function decodeBlock(ci) {
      const c = frame.comps[ci];
      const t = sosTables.find(x => x.id === c.id) || sosTables[ci] || { td: 0, ta: 0 };
      coeff.fill(0);
      const t0 = huff(dcT[t.td]);
      preds[ci] += t0 === 0 ? 0 : extend(receive(t0), t0);
      coeff[0] = preds[ci];
      for (let k = 1; k < 64;) {
        const rs = huff(acT[t.ta]);
        const r = rs >> 4, s = rs & 15;
        if (s === 0) { if (r === 15) { k += 16; continue; } break; }
        k += r;
        if (k > 63) break;
        coeff[ZIGZAG[k]] = extend(receive(s), s);
        k++;
      }
      const q = qt[c.tq] || new Uint16Array(64).fill(1);
      for (let i = 0; i < 64; i++) blk[i] = coeff[i] * q[i];
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        let sum = 0;
        for (let u = 0; u < 8; u++) sum += blk[y * 8 + u] * COS[u * 8 + x];
        rowT[y * 8 + x] = sum;
      }
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
        let sum = 0;
        for (let v = 0; v < 8; v++) sum += rowT[v * 8 + x] * COS[v * 8 + y];
        out8[y * 8 + x] = sum + 128;
      }
      return out8;
    }

    let mcuIdx = 0;
    for (let my = 0; my < mcusY; my++) {
      for (let mx = 0; mx < mcusX; mx++) {
        if (restartInterval && mcuIdx > 0 && mcuIdx % restartInterval === 0) {
          while (bp < scan.length && !(scan[bp] === 0xff && scan[bp + 1] >= 0xd0 && scan[bp + 1] <= 0xd7)) bp++;
          bp += 2; bitCnt = 0;
          for (let i = 0; i < preds.length; i++) preds[i] = 0;
        }
        for (let ci = 0; ci < frame.comps.length; ci++) {
          const c = frame.comps[ci], pl = planes[ci];
          for (let by = 0; by < c.vs; by++) for (let bx = 0; bx < c.hs; bx++) {
            const px = decodeBlock(ci);
            const ox = (mx * c.hs + bx) * 8, oy = (my * c.vs + by) * 8;
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
              const gx = ox + x, gy = oy + y;
              if (gx < pl.w && gy < pl.h) pl.data[gy * pl.w + gx] = Math.max(0, Math.min(255, Math.round(px[y * 8 + x])));
            }
          }
        }
        mcuIdx++;
      }
    }

    const out = new Uint8Array(frame.w * frame.h * 4);
    for (let y = 0; y < frame.h; y++) {
      for (let x = 0; x < frame.w; x++) {
        const vals = [];
        for (let ci = 0; ci < frame.comps.length; ci++) {
          const c = frame.comps[ci], pl = planes[ci];
          const sx = Math.floor(x * c.hs / hmax), sy = Math.floor(y * c.vs / vmax);
          vals.push(pl.data[sy * pl.w + sx]);
        }
        let r, g, b;
        if (vals.length >= 3) {
          const Y = vals[0], Cb = vals[1] - 128, Cr = vals[2] - 128;
          r = Y + 1.402 * Cr; g = Y - 0.344136 * Cb - 0.714136 * Cr; b = Y + 1.772 * Cb;
        } else { r = g = b = vals[0]; }
        const o = (y * frame.w + x) * 4;
        out[o] = Math.max(0, Math.min(255, Math.round(r)));
        out[o + 1] = Math.max(0, Math.min(255, Math.round(g)));
        out[o + 2] = Math.max(0, Math.min(255, Math.round(b)));
        out[o + 3] = 255;
      }
    }
    return { width: frame.w, height: frame.h, rgba: out };
  }

  const api = { isJpeg, decode };
  if (typeof module !== 'undefined' && module.exports && typeof process !== 'undefined') module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { jpeg: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
