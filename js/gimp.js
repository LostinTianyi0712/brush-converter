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
    /* 【第189轮】sel0:random 且多 cell 的 pipe 是「散布笔刷」：这些 cell 是同一个笔尖的
       偏移副本，GIMP 里仍然是**一支**笔刷（每次落笔随机挑一个 cell）。
       上层据此区分「N 个 cell」与「N 支笔刷」——否则散布笔刷会被误当成多支。 */
    const scatterPipe = /sel0:random/i.test(line2) && count > 1;
    const rawGroup = {bytes:bytes,count:brushes.length,name:pipeName};
    brushes.forEach(function (b, index) {
      b._rawFile = bytes; b._rawKind = 'gih';
      b._rawGroup = rawGroup; b._rawGroupIndex = index;
      b._rawBrushState = util.brushFingerprint(b);
    });
    return { brushes: brushes, warnings: warnings, pipeName: pipeName, scatterPipe: scatterPipe };
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
    const spacing = Math.max(1, Math.min(1000, Math.round(brush.spacingPct === undefined ? 10 : brush.spacingPct)));
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
       "2 ncells:2 cellwidth:532 cellheight:400 step:100 dim:1 cols:1 rows:1 placement:constant rank0:2 sel0:incremental"

     【第189轮】`sel0` 的取值受 GIMP 2.10 `app/core/gimpbrushpipe.c:gimp_brush_pipe_select_brush`
     约束：只有 incremental / angular / velocity / random / pressure / xtilt / ytilt 有效，
     其余字符串一律降级成 constant（constant 意味着永远是第 0 个 cell）。
     参数名是 `sel%d`（`gimp_pixpipe_params_parse` 用 strncmp("sel") + atoi(下标)），
     不是 2003 年那版文档里的 `selection:`。
     opts.sel 留出 random 的入口：散布笔刷要把同一个笔尖的多个偏移副本当一个 pipe 的 cell，
     靠 random 在落笔时随机挑一个——这是 GIMP 表达散布的唯一机制（它没有 ABR 那种 jitter 参数）。 */
  function writeGih(brushes, pipeName, opts) {
    if (!brushes || !brushes.length) throw new Error('没有可写入 GIH 的笔刷');
    const tips = brushes.map(grayOf);
    let w = 1, h = 1;
    for (const t of tips) { w = Math.max(w, t.w); h = Math.max(h, t.h); }
    const n = brushes.length;
    const spacing = Math.max(1, Math.min(1000, Math.round(brushes[0].spacingPct === undefined ? 10 : brushes[0].spacingPct)));
    const sel = (opts && typeof opts.sel === 'string') ? opts.sel : 'incremental';
    const LF = new Uint8Array([0x0a]);
    const line1 = util.utf8Encode(String(pipeName || 'brushconv'));
    const line2 = util.utf8Encode(
      n + ' ncells:' + n + ' cellwidth:' + w + ' cellheight:' + h +
      ' step:' + spacing + ' dim:1 cols:1 rows:1 placement:constant rank0:' + n + ' sel0:' + sel
    );
    const parts = [line1, LF, line2, LF];
    for (let i = 0; i < n; i++) {
      const data = padGray(tips[i], w, h);
      const cellSpacing = Math.max(1, Math.min(1000, Math.round(brushes[i].spacingPct === undefined ? 10 : brushes[i].spacingPct)));
      parts.push(buildGbrGray(brushes[i].name, w, h, cellSpacing, data));
    }
    return util.concat(parts);
  }

  /* 【第189轮】把一个笔尖拆成 N 个「偏移副本」当 pipe 的 cell，用 sel0:random 在落笔时
     随机挑一个——这是 GIMP 表达散布的唯一机制（它没有 ABR 那种 jitter 参数）。
     做法：把画布放大到 笔尖 + 2×散布半径，每次把笔尖画在随机偏移的位置；没画到的地方是 0（无墨）。
     代价：GIMP 里这支笔刷的显示尺寸会变成放大后的画布（GIMP 按 cell 尺寸当笔刷尺寸），
     所以半径上限压在笔尖的 0.5 倍，避免糊成一大团。
     偏移用确定性伪随机：同一支笔刷每次导出结果一致，测试才能断言。 */
  function scatterCells(brush, opts) {
    opts = opts || {};
    const tip = grayOf(brush);
    const w = tip.w, h = tip.h;
    const pct = Number(brush.scatterPct);
    if (!(pct > 0) || !(w > 0 && h > 0)) return null;
    const n = Math.max(2, Math.min(8, Math.round(opts.scatterCells || 4)));
    const ratio = Math.min(0.5, (pct / 100) * 0.5);
    const r = Math.max(1, Math.round(Math.max(w, h) * ratio));
    const cw = w + r * 2, ch = h + r * 2;
    if (cw * ch * n > 64 * 1024 * 1024) return null;   /* 防御：4 倍放大 + 8 cell 仍超 64MB 就不做 */
    function rnd(k, salt) {
      let x = (k * 1103515245 + salt * 12345 + 0x9e3779b9) >>> 0;
      x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0;
      x ^= x >>> 13; x = Math.imul(x, 3266489917) >>> 0;
      x ^= x >>> 16;
      return (x >>> 0) / 4294967296;
    }
    const cells = [];
    const baseName = String(brush.name || 'brush');
    for (let k = 0; k < n; k++) {
      const dx = Math.round((rnd(k, 1) * 2 - 1) * r);
      const dy = Math.round((rnd(k, 2) * 2 - 1) * r);
      const cell = new Uint8Array(cw * ch);            /* 0 = 无墨 */
      const ox = r + dx, oy = r + dy;
      for (let y = 0; y < h; y++) {
        const ty = oy + y;
        if (ty < 0 || ty >= ch) continue;
        for (let x = 0; x < w; x++) {
          const tx = ox + x;
          if (tx < 0 || tx >= cw) continue;
          cell[ty * cw + tx] = tip.data[y * w + x];
        }
      }
      cells.push({
        name: baseName + ' #' + (k + 1),
        spacingPct: brush.spacingPct,
        tip: { w: cw, h: ch, data: cell }
      });
    }
    return cells;
  }

  const api = { isGbr, parseGbr, parseGih, writeGbr, writeGih, scatterCells };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { gimp: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
