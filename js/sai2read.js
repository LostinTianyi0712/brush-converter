/* PaintTool SAI 2 素材/笔刷读取
 *  - init 素材包：brushform.conf / brushtex.conf / papertex.conf / scatter.conf / bristle.conf
 *    每行 "序号,文件夹\文件.bmp"，纹理解码为笔尖/纹理
 *  - 笔刷 ini（scatter 笔刷）：[Parameters] 里的 Density / AngleControl / Angle / Blur ... 
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const zip = isNode ? require('./zip.js') : root.BC.zip;
  const png = isNode ? require('./png.js') : root.BC.png;

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function isBmp(bytes) { return bytes && bytes.length > 26 && bytes[0] === 0x42 && bytes[1] === 0x4d; }
  function isPng(bytes) { return bytes && bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50; }

  /* BMP -> {w,h,gray}（支持 8 位调色板 / 24 位 / 32 位，含自底向上与自顶向下） */
  function decodeBmp(bytes) {
    if (!isBmp(bytes)) return null;
    const offBits = u32(bytes, 10);
    const headerSize = u32(bytes, 14);
    const w = u32(bytes, 18) | 0;
    let h = u32(bytes, 22) | 0;
    const bpp = u16(bytes, 28);
    const compression = u32(bytes, 30);
    if (compression !== 0 || w <= 0 || h === 0) return null;
    const topDown = h < 0;
    h = Math.abs(h);
    const gray = new Uint8Array(w * h);
    const palette = [];
    if (bpp === 8) {
      const colors = u32(bytes, 46) || 256;
      for (let i = 0; i < colors; i++) {
        const o = 14 + headerSize + i * 4;
        palette.push([bytes[o + 2], bytes[o + 1], bytes[o]]);
      }
    }
    const rowSize = Math.floor((bpp * w + 31) / 32) * 4;
    for (let y = 0; y < h; y++) {
      const srcRow = topDown ? y : (h - 1 - y);
      const rowOff = offBits + srcRow * rowSize;
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        if (bpp === 8) {
          const idx = bytes[rowOff + x];
          const p = palette[idx] || [idx, idx, idx];
          r = p[0]; g = p[1]; b = p[2];
        } else if (bpp === 24) {
          const o = rowOff + x * 3;
          b = bytes[o]; g = bytes[o + 1]; r = bytes[o + 2];
        } else if (bpp === 32) {
          const o = rowOff + x * 4;
          b = bytes[o]; g = bytes[o + 1]; r = bytes[o + 2];
        } else return null;
        gray[y * w + x] = Math.round((r + g + b) / 3);
      }
    }
    return { w: w, h: h, gray: gray };
  }

  function decodeImage(bytes) {
    if (isBmp(bytes)) {
      const g = decodeBmp(bytes);
      if (!g) return null;
      const rgba = new Uint8Array(g.w * g.h * 4);
      for (let i = 0; i < g.w * g.h; i++) {
        const v = g.gray[i];
        rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = v;
      }
      return { w: g.w, h: g.h, rgba: rgba };
    }
    if (isPng(bytes)) {
      try {
        const img = png.decode(bytes);
        return { w: img.width, h: img.height, rgba: png.toMaskRgba(img.rgba) };
      } catch (e) { return null; }
    }
    return null;
  }

  function isSai2Pack(bytes) {
    if (!zip.isZip(bytes)) return false;
    let entries;
    try { entries = zip.read(bytes); } catch (e) { return false; }
    return entries.some(function (e) { return /(^|\/)(brushform|brushtex|papertex|scatter|bristle|blotmap)\.conf$/i.test(e.name); });
  }

  function isBrushIni(bytes) {
    if (!bytes || bytes.length < 40 || bytes.length > 1024 * 1024) return false;
    const head = util.utf8Decode(bytes.subarray(0, Math.min(4096, bytes.length)));
    return /\[Parameters\]/i.test(head) && /(Density|AngleControl)/i.test(head);
  }

  function parseIniParams(text) {
    const out = {};
    for (const line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.charAt(0) === ';' || t.charAt(0) === '[') continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      out[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    return out;
  }

  function parseBrushIni(bytes, fileName) {
    const p = parseIniParams(util.utf8Decode(bytes));
    const density = p.Density === undefined ? 100 : Math.max(1, Math.min(100, p.Density));
    const angle = p.Angle === undefined ? 0 : p.Angle;
    const base = String(fileName || 'sai2-brush').replace(/\.ini$/i, '').replace(/^.*[\\/]/, '');
    return {
      brushes: [{
        name: base.replace(/__/g, ' '),
        tip: null,
        sizePx: 40,
        spacingPct: 10,
        opacity: density / 100,
        minSizeRatio: 0,
        minOpacityRatio: 0,
        pressureSize: true,
        pressureOpacity: false,
        hardness: p.EdgeHardness === undefined ? 1 : Math.max(0, Math.min(1, p.EdgeHardness / 100)),
        angle: angle,
        roundness: 100,
        source: 'sai2',
        _sai2ini: p
      }],
      warnings: ['SAI2 笔刷 ini 只含笔形参数，笔尖图需从素材包（blotmap/brshape/brushtex）里配套使用']
    };
  }

  /* SAI2 笔刷预设文件（toolnrm）：INI 结构，每条笔刷一组 key=value
    参考字段：id/name/desc/brpat_vsbpos/brwav/drawmode/bri/depth/f_prs2dp/f_prs2sz/
             prsfeel/szmin/dpmin/dpmax/quality/blend/water/stretch/bfval/txval/
             brfnam/texnam/brsize/brsizesc/smooth/edgehdns */
  function isToolnrm(bytes) {
    if (!bytes || bytes.length < 40 || bytes.length > 4 * 1024 * 1024) return false;
    const head = util.utf8Decode(bytes.subarray(0, Math.min(bytes.length, 8192)));
    return /brsize\s*=/.test(head) && /(szmin|depth|drawmode)\s*=/.test(head);
  }

  function parseToolnrm(bytes) {
    const text = util.utf8Decode(bytes);
    const lines = text.split(String.fromCharCode(10));
    const records = [];
    let cur = {};
    let started = false;
    const flush = function () {
      if (started && Object.keys(cur).length) records.push(cur);
      cur = {};
      started = false;
    };
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) { flush(); continue; }
      if (t.charAt(0) === ';' || t.charAt(0) === '#') continue;
      if (t.charAt(0) === '[') { flush(); started = true; cur.__section = t.slice(1, -1); continue; }
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      started = true;
      cur[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    flush();
    const brushes = [];
    let idx = 0;
    for (const r of records) {
      if (r.name === undefined && r.brsize === undefined) continue;
      idx++;
      const size = Math.max(1, Math.min(5000, Number(r.brsize) || Number(r.brsizesc) || 30));
      const szmin = Number(r.szmin);
      const depth = Number(r.depth);
      brushes.push({
        name: r.name || ('SAI2 ' + idx),
        tip: null,
        sizePx: Math.round(size),
        spacingPct: 10,
        opacity: isFinite(depth) ? Math.max(0.01, Math.min(1, depth / 100)) : 1,
        minSizeRatio: isFinite(szmin) ? Math.max(0, Math.min(1, szmin / 100)) : 0,
        minOpacityRatio: Number(r.dpmin) ? Math.max(0, Math.min(1, Number(r.dpmin) / 100)) : 0,
        pressureSize: r.f_prs2sz === '1',
        pressureOpacity: r.f_prs2dp === '1',
        hardness: Number(r.edgehdns) ? Math.max(0, Math.min(1, Number(r.edgehdns) / 100)) : 1,
        angle: 0,
        roundness: 100,
        smudgeOn: Number(r.blend) > 0,
        smudgeAmount: Number(r.blend) ? Math.max(0, Math.min(1, Number(r.blend) / 100)) : 0,
        wetEdgesOn: Number(r.water) > 0,
        wetEdgesAmount: Number(r.water) ? Math.max(0, Math.min(1, Number(r.water) / 100)) : 0,
        smoothingStrength: Number(r.smooth) ? Math.max(0, Math.min(1, Number(r.smooth) / 100)) : 0,
        source: 'sai2',
        _sai2tool: r
      });
    }
    return { brushes: brushes, warnings: brushes.length ? [] : ['toolnrm 里没有读到笔刷条目'] };
  }

  function parsePack(bytes, fileName) {
    const entries = zip.read(bytes);
    const files = {};
    const confs = {};
    for (const e of entries) {
      if (e.dir) continue;
      const data = e.data();
      files[e.name] = data;
      files[e.name.replace(/^.*\//, '')] = data;
      const m = e.name.match(/(^|\/)(brushform|brushtex|papertex|scatter|bristle)\.conf$/i);
      if (m) confs[m[2].toLowerCase()] = data;
    }
    const brushes = [];
    for (const cat of Object.keys(confs)) {
      const text = util.utf8Decode(confs[cat]);
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        const comma = t.indexOf(',');
        if (comma < 0) continue;
        const slot = t.slice(0, comma).trim();
        const path = t.slice(comma + 1).trim().replace(/\\/g, '/');
        const data = files[path] || files[path.replace(/^.*\//, '')];
        if (!data) continue;
        const img = decodeImage(data);
        if (!img) continue;
        const base = path.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
        brushes.push({
          name: cat + ' ' + base,
          tip: img,
          sizePx: Math.max(img.w, img.h),
          spacingPct: 100,
          opacity: 1,
          minSizeRatio: 0,
          minOpacityRatio: 0,
          pressureSize: true,
          hardness: 1,
          angle: 0,
          roundness: 100,
          hasTexture: true,
          source: 'sai2',
          _sai2: { category: cat, slot: slot, file: path }
        });
      }
    }
    return {
      brushes: brushes,
      warnings: brushes.length ? [] : ['SAI2 素材包里没有读到可用纹理（检查 conf 与 bmp 是否齐全）']
    };
  }

  const api = { isSai2Pack, isBrushIni, isToolnrm, parseToolnrm, parsePack, parseBrushIni, decodeBmp };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { sai2read: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
