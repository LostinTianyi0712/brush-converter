/* GIMP brush formats: .gbr (single brush) and .gih (brush pipe).
   Spec (GIMP gimpbrush-header.h): header_size, version, width, height,
   bytes, magic ("GIMP" as u32), spacing, name (NUL-terminated), pixel data.
   A .gih starts with a text line (pipe name), a line with the brush count
   (plus optional cell parameters), then that many .gbr-style entries. */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;

  const MAGIC = 0x47494d50; // 'GIMP'
  const MAX_DIM = 10000;
  const BASE = 28;

  function u32(b, o) { return util.u32(b, o); }
  function be32(n) { return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]); }

  function readHeader(bytes, pos) {
    if (pos + 20 > bytes.length) return null;
    const headerSize = u32(bytes, pos);
    const version = u32(bytes, pos + 4);
    if (version < 1 || version > 3) return null;
    const minimum = version === 1 ? 20 : BASE;
    if (headerSize < minimum || headerSize > bytes.length - pos) return null;
    const width = u32(bytes, pos + 8);
    const height = u32(bytes, pos + 12);
    const bpp = u32(bytes, pos + 16);
    if (version >= 2 && u32(bytes, pos + 20) !== MAGIC) return null;
    if (!width || !height || width > MAX_DIM || height > MAX_DIM) return null;
    if (bpp !== 1 && bpp !== 2 && bpp !== 4) return null;
    let spacing = 10;
    let nameStart = pos + 20;
    if (version >= 2) {
      spacing = u32(bytes, pos + 24);
      nameStart = pos + 28;
    }
    const nameLen = headerSize - (nameStart - pos);
    const nameBytes = bytes.subarray(nameStart, nameStart + Math.max(0, nameLen));
    let z = 0;
    while (z < nameBytes.length && nameBytes[z] !== 0) z++;
    const name = util.utf8Decode(nameBytes.subarray(0, z));
    return {
      headerSize: headerSize, version: version, width: width, height: height,
      bpp: bpp, spacing: spacing, name: name,
      dataStart: pos + headerSize
    };
  }

  function isGbr(bytes) {
    const h = readHeader(bytes, 0);
    return !!h;
  }

  function toTip(bytes, h, warnings) {
    const count = h.width * h.height;
    const need = count * h.bpp;
    if (h.dataStart + need > bytes.length) {
      warnings.push('GIMP 笔刷像素数据不完整');
      return null;
    }
    const src = bytes.subarray(h.dataStart, h.dataStart + need);
    const gray = new Uint8Array(count);
    if (h.bpp === 1) gray.set(src);
    else if (h.bpp === 2) { for (let i = 0; i < count; i++) gray[i] = src[i * 2]; }
    else if (h.bpp === 4) { for (let i = 0; i < count; i++) gray[i] = src[i * 4 + 3]; }
    return { w: h.width, h: h.height, bpp: 1, data: gray };
  }

  function brushOf(h, tip, name) {
    const spacing = h.spacing > 0 ? h.spacing : 10;
    return {
      name: name || h.name || 'gimp brush',
      tip: tip,
      sizePx: tip ? Math.max(tip.w, tip.h) : 0,
      spacingPct: Math.max(1, Math.min(1000, spacing)),
      opacity: 1,
      hardness: 1,
      angle: 0,
      roundness: 100,
      pressure: false,
      pressureSize: false,
      minSizeRatio: 1,
      source: 'gimp'
    };
  }

  function parseGbr(bytes, fileName) {
    const warnings = [];
    const h = readHeader(bytes, 0);
    if (!h) throw new Error('不是有效的 GIMP .gbr 笔刷');
    const tip = toTip(bytes, h, warnings);
    if (!tip) warnings.push('笔刷像素解码失败');
    const one = brushOf(h, tip, h.name || (fileName || '').replace(/\.[^.]+$/, ''));
    one._rawFile = bytes;
    one._rawKind = 'gbr';
    one._rawBrushState = util.brushFingerprint(one);
    return { brushes: [one], warnings: warnings };
  }

  function parseGih(bytes, fileName) {
    const warnings = [];
    // text header: first line = pipe name, second line = count (+ params)
    let z = 0;
    while (z < bytes.length && bytes[z] !== 0x0a && z < 1024) z++;
    if (z >= bytes.length || bytes[z] !== 0x0a) throw new Error('不是有效的 GIMP .gih 笔刷（缺少文本头）');
    const pipeName = util.utf8Decode(bytes.subarray(0, z)).trim();
    let line2Start = z + 1;
    z = line2Start;
    while (z < bytes.length && bytes[z] !== 0x0a && z < line2Start + 1024) z++;
    const line2 = util.utf8Decode(bytes.subarray(line2Start, z)).trim();
    const m = /^(\d+)/.exec(line2);
    if (!m) throw new Error('GIMP .gih 笔刷数量无效');
    const count = parseInt(m[1], 10);
    if (!count || count > 1000) throw new Error('GIMP .gih 笔刷数量异常');
    let pos = z + 1;
    const brushes = [];
    for (let i = 0; i < count; i++) {
      const h = readHeader(bytes, pos);
      if (!h) { warnings.push('第 ' + (i + 1) + ' 个 GIH 笔刷头损坏，已停止'); break; }
      const tip = toTip(bytes, h, warnings);
      const name = h.name || (pipeName || (fileName || '').replace(/\.[^.]+$/, '')) + '-' + (i + 1);
      brushes.push(brushOf(h, tip, name));
      pos = h.dataStart + h.width * h.height * h.bpp;
    }
    if (!brushes.length) warnings.push('GIH 中没有可用笔刷');
    const rawGroup = {bytes:bytes,count:brushes.length,name:pipeName};
    brushes.forEach(function (b, index) {
      b._rawFile = bytes; b._rawKind = 'gih';
      b._rawGroup = rawGroup; b._rawGroupIndex = index;
      b._rawBrushState = util.brushFingerprint(b);
    });
    return { brushes: brushes, warnings: warnings, pipeName: pipeName };
  }

  function cstr(str) {
    const b = util.utf8Encode(String(str || ''));
    const out = new Uint8Array(b.length + 1);
    out.set(b);
    return out;
  }

  function buildGbr(brush) {
    let tip = brush.tip;
    if (!tip || !tip.data) {
      if (!tip || !tip.rgba) throw new Error('该笔刷没有笔尖图像，无法写入 GBR');
      const n = tip.w * tip.h;
      const gray = new Uint8Array(n);
      for (let i = 0; i < n; i++) gray[i] = tip.rgba[i * 4 + 3];
      tip = { w: tip.w, h: tip.h, data: gray };
    }
    const w = tip.w, h = tip.h;
    if (tip.data.length !== w * h) throw new Error('笔尖数据尺寸不符');
    const name = cstr(Array.from(brush.name || 'brush').slice(0, 120).join(''));
    const spacing = Math.max(1, Math.min(1000, Math.round(brush.spacingPct || 10)));
    const headerSize = BASE + name.length;
    const head = util.concat([
      be32(headerSize),
      be32(2), // version
      be32(w), be32(h),
      be32(1), // 8-bit gray
      be32(MAGIC),
      be32(spacing)
    ]);
    return util.concat([head, name, tip.data]);
  }

  function writeGbr(brush) { return buildGbr(brush); }

  function grayOf(brush) {
    let tip = brush.tip;
    if (!tip) throw new Error('该笔刷没有笔尖图像，无法写入 GIH');
    if (tip.data) return { w: tip.w, h: tip.h, data: tip.data };
    if (!tip.rgba) throw new Error('该笔刷没有笔尖图像，无法写入 GIH');
    const n = tip.w * tip.h;
    const gray = new Uint8Array(n);
    for (let i = 0; i < n; i++) gray[i] = tip.rgba[i * 4 + 3];
    return { w: tip.w, h: tip.h, data: gray };
  }

  function padGray(t, nw, nh) {
    if (t.w === nw && t.h === nh) return t.data;
    const out = new Uint8Array(nw * nh);
    const left = Math.floor((nw - t.w) / 2), top = Math.floor((nh - t.h) / 2);
    for (let y = 0; y < t.h; y++) {
      out.set(t.data.subarray(y * t.w, (y + 1) * t.w), (top + y) * nw + left);
    }
    return out;
  }

  function buildGbrGray(name, w, h, spacing, gray) {
    const nameBytes = cstr(Array.from(name || 'brush').slice(0, 120).join(''));
    const headerSize = BASE + nameBytes.length;
    const head = util.concat([
      be32(headerSize),
      be32(2),
      be32(w), be32(h),
      be32(1),
      be32(MAGIC),
      be32(spacing)
    ]);
    return util.concat([head, nameBytes, gray]);
  }

  /* GIMP image pipe (.gih): two text header lines, then one GBR per cell.
     Header line 2 is the documented attribute list, e.g.
       "2 ncells:2 cellwidth:532 cellheight:400 step:100 dim:1 cols:1 rows:1 placement:constant rank0:2 sel0:incremental" */
  function writeGih(brushes, pipeName) {
    if (!brushes || !brushes.length) throw new Error('没有可写入 GIH 的笔刷');
    const tips = brushes.map(grayOf);
    let w = 1, h = 1;
    for (const t of tips) { w = Math.max(w, t.w); h = Math.max(h, t.h); }
    const n = brushes.length;
    const spacing = Math.max(1, Math.min(1000, Math.round(brushes[0].spacingPct || 10)));
    const LF = new Uint8Array([0x0a]);
    const line1 = util.utf8Encode(String(pipeName || 'brushconv'));
    const line2 = util.utf8Encode(
      n + ' ncells:' + n + ' cellwidth:' + w + ' cellheight:' + h +
      ' step:' + spacing + ' dim:1 cols:1 rows:1 placement:constant rank0:' + n + ' sel0:incremental'
    );
    const parts = [line1, LF, line2, LF];
    for (let i = 0; i < n; i++) {
      const data = padGray(tips[i], w, h);
      const cellSpacing = Math.max(1, Math.min(1000, Math.round(brushes[i].spacingPct || 10)));
      parts.push(buildGbrGray(brushes[i].name, w, h, cellSpacing, data));
    }
    return util.concat(parts);
  }

  const api = { isGbr, parseGbr, parseGih, writeGbr, writeGih };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { gimp: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
