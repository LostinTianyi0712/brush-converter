/* 追加：读取 Photoshop .pat 图案文件（模式 1/2/3，8 位通道，raw/PackBits） */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const pat = isNode ? require('./pat.js') : root.BC.pat;

  function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
  function utf16be(b, o, units) {
    let s = '';
    for (let i = 0; i < units; i++) {
      const c = (b[o + i * 2] << 8) | b[o + i * 2 + 1];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  function unpackBits(d, start, end) {
    const out = [];
    let i = start;
    while (i < end) {
      const h = d[i++];
      if (h <= 127) {
        const n = h + 1;
        for (let k = 0; k < n && i < end; k++) out.push(d[i++]);
      } else if (h >= 129) {
        const n = 257 - h;
        const v = d[i++];
        for (let k = 0; k < n; k++) out.push(v);
      }
    }
    return out;
  }
  function decodePlane(data, w, h, depthBytes, compression) {
    const n = w * h;
    if (compression === 0) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = data[i * depthBytes];
      return out;
    }
    // PackBits：每行 u16 长度 + 数据
    const out = new Uint8Array(n);
    let p = 0;
    for (let y = 0; y < h; y++) {
      const rowLen = u16(data, p); p += 2;
      const row = unpackBits(data, p, Math.min(data.length, p + rowLen));
      p += rowLen;
      for (let x = 0; x < w; x++) out[y * w + x] = row[x * depthBytes] === undefined ? 0 : row[x * depthBytes];
    }
    return out;
  }

  function readPat(bytes) {
    if (!bytes || bytes.length < 10) return [];
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== '8BPT') return [];
    const count = u32(bytes, 6);
    let p = 10;
    const out = [];
    for (let i = 0; i < count; i++) {
      if (p + 20 > bytes.length) break;
      const ver = u32(bytes, p); p += 4;
      const mode = u32(bytes, p); p += 4;
      const h = u16(bytes, p); p += 2;
      const w = u16(bytes, p); p += 2;
      const units = u32(bytes, p); p += 4;
      const name = utf16be(bytes, p, units); p += units * 2;
      const idLen = bytes[p]; p += 1;
      const id = String.fromCharCode.apply(null, bytes.subarray(p, p + idLen)); p += idLen;
      let palette = null;
      if (mode === 2) {
        palette = bytes.subarray(p, p + 768); p += 768;
        p += 4;
      }
      const vmaVer = u32(bytes, p); p += 4;
      const listLen = u32(bytes, p); p += 4;
      const listStart = p;
      p += 16; // rect
      const slotCount = u32(bytes, p); p += 4;
      const planes = [];
      for (let s = 0; s < slotCount; s++) {
        if (p + 4 > bytes.length) break;
        const written = u32(bytes, p); p += 4;
        if (written !== 1) break;
        const alen = u32(bytes, p); p += 4;
        const bodyStart = p;
        const depth = u32(bytes, p); p += 4;
        p += 16;
        const depth2 = u16(bytes, p); p += 2;
        const compression = bytes[p]; p += 1;
        const dataStart = p;
        const dataEnd = Math.min(bytes.length, bodyStart + alen);
        planes.push(decodePlane(bytes.subarray(dataStart, dataEnd), w, h, depth2 === 16 ? 2 : 1, compression));
        p = bodyStart + alen;
      }
      p = listStart + listLen;
      // 组装灰度
      const n = w * h;
      const gray = new Uint8Array(n);
      if (mode === 2 && palette) {
        const idx = planes[0] || new Uint8Array(n);
        for (let k = 0; k < n; k++) {
          const q = idx[k] * 3;
          gray[k] = Math.round((palette[q] + palette[q + 1] + palette[q + 2]) / 3);
        }
      } else if (mode === 3 && planes.length >= 3) {
        for (let k = 0; k < n; k++) gray[k] = Math.round((planes[0][k] + planes[1][k] + planes[2][k]) / 3);
      } else if (planes.length) {
        gray.set(planes[0].subarray(0, n));
      }
      out.push({ id: id, name: name, width: w, height: h, mode: mode, gray: gray });
    }
    return out;
  }

  const api = { readPat: readPat };
  if (typeof module !== 'undefined' && module.exports && typeof process !== 'undefined') module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { patRead: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
