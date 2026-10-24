/* PNG decode/encode (8-bit RGBA output), plus image helpers */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const zlib = isNode ? require('./zlib.js') : root.BC.zlib;

  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function isPng(b) {
    if (b.length < 8) return false;
    for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return false;
    return true;
  }

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  /* Decode PNG -> {width,height,rgba:Uint8Array} */
  function decode(bytes) {
    if (!isPng(bytes)) throw new Error('不是有效的 PNG 图片');
    let p = 8, ihdr = null, plte = null, trns = null, idat = [];
    while (p + 8 <= bytes.length) {
      const len = util.u32(bytes, p);
      const type = util.ascii(bytes, p + 4, 4);
      const data = bytes.subarray(p + 8, p + 8 + len);
      if (type === 'IHDR') {
        ihdr = {
          width: util.u32(data, 0), height: util.u32(data, 4),
          bitDepth: data[8], colorType: data[9], compression: data[10], filter: data[11], interlace: data[12]
        };
      } else if (type === 'PLTE') plte = data;
      else if (type === 'tRNS') trns = data;
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      p += 12 + len;
    }
    if (!ihdr) throw new Error('PNG 缺少 IHDR');
    if (ihdr.interlace) throw new Error('暂不支持隔行扫描 PNG');
    const w = ihdr.width, h = ihdr.height, bd = ihdr.bitDepth, ct = ihdr.colorType;
    const raw = zlib.inflate(util.concat(idat));
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
    if (!channels) throw new Error('不支持的 PNG 颜色类型: ' + ct);
    const bitsPerPixel = channels * bd;
    const stride = Math.ceil((w * bitsPerPixel) / 8);
    const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
    const out = new Uint8Array(w * h * 4);
    const prev = new Uint8Array(stride);
    const line = new Uint8Array(stride);
    let pos = 0;
    const maxv = (1 << bd) - 1;
    for (let y = 0; y < h; y++) {
      const ft = raw[pos++];
      line.set(raw.subarray(pos, pos + stride));
      pos += stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? line[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v = line[x];
        if (ft === 1) v = (v + a) & 255;
        else if (ft === 2) v = (v + b) & 255;
        else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
        else if (ft === 4) v = (v + paeth(a, b, c)) & 255;
        line[x] = v;
      }
      prev.set(line);
      const rowOff = y * w * 4;
      for (let x = 0; x < w; x++) {
        let r, g, bl, al = 255;
        if (ct === 6) {
          const o = x * 4;
          r = line[o]; g = line[o + 1]; bl = line[o + 2]; al = line[o + 3];
          if (bd === 16) { r = line[o]; g = line[o + 2]; bl = line[o + 4]; al = line[o + 6]; }
        } else if (ct === 2) {
          const o = x * 3;
          if (bd === 16) { r = line[o]; g = line[o + 2]; bl = line[o + 4]; }
          else { r = line[o]; g = line[o + 1]; bl = line[o + 2]; }
        } else if (ct === 4) {
          const o = x * 2 * (bd === 16 ? 2 : 1);
          if (bd === 16) { r = g = bl = line[o]; al = line[o + 2]; }
          else { r = g = bl = line[o]; al = line[o + 1]; }
        } else if (ct === 0) {
          let v;
          if (bd === 16) v = line[x * 2];
          else if (bd === 8) v = line[x];
          else {
            const bitPos = x * bd;
            const byte = line[bitPos >> 3];
            const shift = 8 - bd - (bitPos & 7);
            v = (byte >> shift) & maxv;
            v = Math.round((v * 255) / maxv);
          }
          r = g = bl = v;
        } else if (ct === 3) {
          let idx;
          if (bd === 8) idx = line[x];
          else {
            const bitPos = x * bd;
            const byte = line[bitPos >> 3];
            const shift = 8 - bd - (bitPos & 7);
            idx = (byte >> shift) & maxv;
          }
          r = plte[idx * 3]; g = plte[idx * 3 + 1]; bl = plte[idx * 3 + 2];
          if (trns && idx < trns.length) al = trns[idx];
        }
        const o = rowOff + x * 4;
        out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = al;
      }
    }
    return { width: w, height: h, rgba: out };
  }

  function crcChunk(type, data) {
    const typeBytes = util.utf8Encode(type);
    const body = util.concat([typeBytes, data]);
    const crc = util.crc32(body);
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length, false);
    out.set(typeBytes, 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc, false);
    return out;
  }

  /* Encode RGBA8 -> PNG bytes, with adaptive filtering (chooses best per row) */
  function encode(width, height, rgba) {
    const stride = width * 4;
    const raw = new Uint8Array((stride + 1) * height);
    const prev = new Uint8Array(stride);
    const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
    let pos = 0;
    for (let y = 0; y < height; y++) {
      const row = rgba.subarray(y * stride, (y + 1) * stride);
      let best = 0, bestScore = Infinity, bestBuf = null;
      for (let ft = 0; ft < 5; ft++) {
        const b = cand[ft];
        let score = 0;
        for (let x = 0; x < stride; x++) {
          const a = x >= 4 ? row[x - 4] : 0;
          const bb = prev[x];
          const c = x >= 4 ? prev[x - 4] : 0;
          let v;
          if (ft === 0) v = row[x];
          else if (ft === 1) v = (row[x] - a) & 255;
          else if (ft === 2) v = (row[x] - bb) & 255;
          else if (ft === 3) v = (row[x] - ((a + bb) >> 1)) & 255;
          else v = (row[x] - paeth(a, bb, c)) & 255;
          b[x] = v;
          score += v < 128 ? v : 256 - v;
        }
        if (score < bestScore) { bestScore = score; best = ft; bestBuf = b; }
      }
      raw[pos++] = best;
      raw.set(bestBuf, pos);
      pos += stride;
      prev.set(row);
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width, false);
    dv.setUint32(4, height, false);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const idat = zlib.deflate(raw, 9);
    return util.concat([
      new Uint8Array(PNG_SIG),
      crcChunk('IHDR', ihdr),
      crcChunk('IDAT', idat),
      crcChunk('IEND', new Uint8Array(0))
    ]);
  }

  /* Encode an 8-bit RGB image (no alpha; GoPaint grain resources use this) */
  function encodeRgb(width, height, rgb) {
    const stride = width * 3;
    const raw = new Uint8Array((stride + 1) * height);
    const prev = new Uint8Array(stride);
    const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
    let pos = 0;
    for (let y = 0; y < height; y++) {
      const row = rgb.subarray(y * stride, (y + 1) * stride);
      let best = 0, bestScore = Infinity, bestBuf = null;
      for (let ft = 0; ft < 5; ft++) {
        const b = cand[ft];
        let score = 0;
        for (let x = 0; x < stride; x++) {
          const a = x >= 3 ? row[x - 3] : 0;
          const bb = prev[x];
          const c = x >= 3 ? prev[x - 3] : 0;
          let v;
          if (ft === 0) v = row[x];
          else if (ft === 1) v = (row[x] - a) & 255;
          else if (ft === 2) v = (row[x] - bb) & 255;
          else if (ft === 3) v = (row[x] - ((a + bb) >> 1)) & 255;
          else v = (row[x] - paeth(a, bb, c)) & 255;
          b[x] = v;
          score += v < 128 ? v : 256 - v;
        }
        if (score < bestScore) { bestScore = score; best = ft; bestBuf = b; }
      }
      raw[pos++] = best;
      raw.set(bestBuf, pos);
      pos += stride;
      prev.set(row);
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width, false);
    dv.setUint32(4, height, false);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const idat = zlib.deflate(raw, 9);
    return util.concat([
      new Uint8Array(PNG_SIG),
      crcChunk('IHDR', ihdr),
      crcChunk('IDAT', idat),
      crcChunk('IEND', new Uint8Array(0))
    ]);
  }

  /* Encode an 8-bit grayscale image (Procreate Shape.png convention: white = opaque) */
  function encodeGray(width, height, gray) {
    const stride = width;
    const raw = new Uint8Array((stride + 1) * height);
    const prev = new Uint8Array(stride);
    const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
    let pos = 0;
    for (let y = 0; y < height; y++) {
      const row = gray.subarray(y * stride, (y + 1) * stride);
      let best = 0, bestScore = Infinity, bestBuf = cand[0];
      for (let ft = 0; ft < 5; ft++) {
        const b = cand[ft];
        let score = 0;
        for (let x = 0; x < stride; x++) {
          const a = x >= 1 ? row[x - 1] : 0;
          const bb = prev[x];
          const c = x >= 1 ? prev[x - 1] : 0;
          let v;
          if (ft === 0) v = row[x];
          else if (ft === 1) v = (row[x] - a) & 255;
          else if (ft === 2) v = (row[x] - bb) & 255;
          else if (ft === 3) v = (row[x] - ((a + bb) >> 1)) & 255;
          else v = (row[x] - paeth(a, bb, c)) & 255;
          b[x] = v;
          score += v < 128 ? v : 256 - v;
        }
        if (score < bestScore) { bestScore = score; best = ft; bestBuf = b; }
      }
      raw[pos++] = best;
      raw.set(bestBuf, pos);
      pos += stride;
      prev.set(row);
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width, false);
    dv.setUint32(4, height, false);
    ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const idat = zlib.deflate(raw, 9);
    return util.concat([
      new Uint8Array(PNG_SIG),
      crcChunk('IHDR', ihdr),
      crcChunk('IDAT', idat),
      crcChunk('IEND', new Uint8Array(0))
    ]);
  }

  /* Gray->RGBA with white RGB (brush tip convention) */
  function grayToRgba(gray, w, h, invert) {
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const a = invert ? 255 - gray[i] : gray[i];
      const o = i * 4;
      out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = a;
    }
    return out;
  }

  /* Resize RGBA with box filter (fast, good quality) */
  function resize(src, sw, sh, dw, dh) {
    if (sw === dw && sh === dh) return src;
    const out = new Uint8Array(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
      const y0 = Math.floor((y * sh) / dh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
      for (let x = 0; x < dw; x++) {
        const x0 = Math.floor((x * sw) / dw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const o = (yy * sw + xx) * 4;
            r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3]; n++;
          }
        }
        const o = (y * dw + x) * 4;
        out[o] = (r / n) | 0; out[o + 1] = (g / n) | 0; out[o + 2] = (b / n) | 0; out[o + 3] = (a / n) | 0;
      }
    }
    return out;
  }

  /* Turn RGBA into white-RGB + alpha mask (画世界Pro expects alpha as coverage) */
  function toMaskRgba(rgba) {
    const out = new Uint8Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      out[i] = 255; out[i + 1] = 255; out[i + 2] = 255; out[i + 3] = rgba[i + 3];
    }
    return out;
  }

  /* ---------- PNG text chunks (tEXt / iTXt / zTXt) ----------
     Used by Krita .kpp presets (PNG container with "preset"/"version" text keys). */
  function readTextChunks(bytes) {
    const out = {};
    if (!isPng(bytes)) return out;
    let pos = 8;
    while (pos + 8 <= bytes.length) {
      const len = util.u32(bytes, pos);
      const type = util.ascii(bytes, pos + 4, 4);
      const data = bytes.subarray(pos + 8, pos + 8 + len);
      pos += 12 + len;
      if (type === 'tEXt') {
        let z = 0;
        while (z < data.length && data[z] !== 0) z++;
        const key = util.utf8Decode(data.subarray(0, z));
        out[key] = util.utf8Decode(data.subarray(z + 1));
      } else if (type === 'zTXt') {
        let z = 0;
        while (z < data.length && data[z] !== 0) z++;
        const key = util.utf8Decode(data.subarray(0, z));
        try { out[key] = util.utf8Decode(zlib.inflate(data.subarray(z + 2))); } catch (e) { /* ignore */ }
      } else if (type === 'iTXt') {
        let z = 0;
        while (z < data.length && data[z] !== 0) z++;
        const key = util.utf8Decode(data.subarray(0, z));
        if (z + 2 < data.length) {
          const compressed = data[z + 1] === 1;
          let q = z + 3;
          let a = q;
          while (a < data.length && data[a] !== 0) a++;
          const lang = data.subarray(q, a);
          q = a + 1;
          a = q;
          while (a < data.length && data[a] !== 0) a++;
          const translated = data.subarray(q, a);
          const body = data.subarray(a + 1);
          try {
            out[key] = util.utf8Decode(compressed ? zlib.inflate(body) : body);
          } catch (e) { /* ignore */ }
        }
      } else if (type === 'IEND') {
        break;
      }
    }
    return out;
  }

  /* Insert tEXt chunks right after IHDR (so a PNG can carry metadata). */
  function injectText(bytes, map) {
    const chunks = [];
    let pos = 8;
    let inserted = false;
    while (pos + 8 <= bytes.length) {
      const len = util.u32(bytes, pos);
      const type = util.ascii(bytes, pos + 4, 4);
      const end = pos + 12 + len;
      chunks.push(bytes.subarray(pos, end));
      pos = end;
      if (type === 'IHDR' && !inserted) {
        for (const key of Object.keys(map)) {
          const kb = util.utf8Encode(key);
          const vb = util.utf8Encode(String(map[key]));
          const data = new Uint8Array(kb.length + 1 + vb.length);
          data.set(kb, 0); data[kb.length] = 0; data.set(vb, kb.length + 1);
          chunks.push(crcChunk('tEXt', data));
        }
        inserted = true;
      }
      if (type === 'IEND') break;
    }
    return util.concat([bytes.subarray(0, 8)].concat(chunks));
  }

  function injectZtxt(bytes, map) {
    const chunks = [];
    let pos = 8;
    let inserted = false;
    while (pos + 8 <= bytes.length) {
      const len = util.u32(bytes, pos);
      const type = util.ascii(bytes, pos + 4, 4);
      const end = pos + 12 + len;
      chunks.push(bytes.subarray(pos, end));
      pos = end;
      if (type === 'IHDR' && !inserted) {
        for (const key of Object.keys(map)) {
          const raw = util.utf8Encode(String(map[key]));
          const comp = zlib.deflate(raw, 9);
          const head = util.concat([util.utf8Encode(key), new Uint8Array([0, 0]), new Uint8Array(comp)]);
          chunks.push(crcChunk('zTXt', head));
        }
        inserted = true;
      }
      if (type === 'IEND') break;
    }
    return util.concat([bytes.subarray(0, 8)].concat(chunks));
  }

  const png = { isPng, decode, encode, encodeRgb, encodeGray, grayToRgba, resize, toMaskRgba, readTextChunks, injectText, injectZtxt };
  if (isNode) module.exports = png;
  else root.BC = Object.assign(root.BC || {}, { png });
})(typeof globalThis !== 'undefined' ? globalThis : this);
