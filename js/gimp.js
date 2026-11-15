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

  /* 【第out轮】bpp=4 的 GIMP 笔刷是「彩色笔刷」（RGBA，落笔自带颜色），
     旧实现一律只取 alpha 通道压成灰度蒙版，等于把彩色笔刷静默降级成单色笔尖。
     GIMP 2.10 `gimpbrush-load.c` 对 bpp==4 走 gimp_brush_load_RGBA：四个通道全部保留。
     这里把原始 RGBA 原样交给上层（tip.rgba），灰度蒙版仍可用（tipToRGBA 会取 alpha），
     写回时由 writeGbr/writeGih 依据 pixelsOf 还原 bpp，不再假造 bpp=1。 */
  function toTip(bytes, h, warnings) {
    const count = h.width * h.height;
    const need = count * h.bpp;
    if (h.dataStart + need > bytes.length) {
      warnings.push('GIMP 笔刷像素数据不完整');
      return null;
    }
    const src = bytes.subarray(h.dataStart, h.dataStart + need);
    if (h.bpp === 4) {
      return { w: h.width, h: h.height, bpp: 4, rgba: new Uint8Array(src) };
    }
    const gray = new Uint8Array(count);
    if (h.bpp === 1) gray.set(src);
    else if (h.bpp === 2) { for (let i = 0; i < count; i++) gray[i] = src[i * 2]; }
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
    let cellW = 0, cellH = 0;
    for (let i = 0; i < count; i++) {
      const h = readHeader(bytes, pos);
      if (!h) { warnings.push('第 ' + (i + 1) + ' 个 GIH 笔刷头损坏，已停止'); break; }
      const tip = toTip(bytes, h, warnings);
      const fallback = (pipeName || (fileName || '').replace(/\.[^.]+$/, '')) + '-' + (i + 1);
      const name = h.name || fallback;
      const cell = brushOf(h, tip, name);
      /* 写回时要还原 cell 头的版本：v1 头没有 magic/spacing，长度也不同 */
      cell._cellVersion = h.version;
      /* cell 名可能是空串（GIMP 导出的 pipe 常见）：空名 + NUL 就是 headerSize=29。
         旧写端用「管道名-序号」补出一个名字，头立刻从 29 变成 29+长度，
         整条 pipe 的字节全部偏移。这里记住原始名，只有用户真的改过名字才用新名。 */
      cell._cellName = h.name;
      cell._nameAuto = fallback;
      if (i === 0) { cellW = h.width; cellH = h.height; }
      brushes.push(cell);
      pos = h.dataStart + h.width * h.height * h.bpp;
    }
    if (!brushes.length) warnings.push('GIH 中没有可用笔刷');
    /* 【第189轮】sel0:random 且多 cell 的 pipe 是「散布笔刷」：这些 cell 是同一个笔尖的
       偏移副本，GIMP 里仍然是**一支**笔刷（每次落笔随机挑一个 cell）。
       上层据此区分「N 个 cell」与「N 支笔刷」——否则散布笔刷会被误当成多支。 */
    const scatterPipe = /sel0:random/i.test(line2) && count > 1;
    /* 头部参数表随管道一起保存：写回时要按源 token 原样还原
       （sel0/step/dim/cols/rows/placement/未知项），不再一律套常量模板。 */
    const params = parsePipeParams(line2);
    const rawGroup = { bytes: bytes, count: brushes.length, name: pipeName, line2: line2, params: params, cellW: cellW, cellH: cellH };
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

  /* 笔尖像素的「原样形态」：彩色笔刷走 RGBA(bpp4)，其余走 8-bit 灰度(bpp1)。
     旧写端一律 be32(1)，把彩色笔刷写成灰度蒙版 —— 这是「写侧恒用常量」的典型：
     读侧明明还有 rgba，写侧硬编码 bpp=1，往返一次颜色就没了。 */
  function pixelsOf(brush) {
    const tip = brush && brush.tip;
    if (!tip) throw new Error('该笔刷没有笔尖图像');
    if (tip.data && tip.w > 0 && tip.h > 0) return { w: tip.w, h: tip.h, bpp: 1, data: tip.data };
    if (tip.rgba && tip.w > 0 && tip.h > 0) {
      /* 【第252轮】灰度蒙版转成 RGBA 后 RGB 恒 255，不该写成 bpp4——那会把体积×4，
         也会把「灰度笔刷」变成 GIMP 的「彩色笔刷」（落笔自带颜色）。只有真彩色才走 bpp4。 */
      /* 只有**源本身就是彩色 GBR/GIH**（_rawGbrBpp===4）才保留 RGBA；其余一律按笔尖蒙版写灰度——
         这是项目既有约定（GIMP 里落笔用前景色而不是笔刷自带颜色），不能按像素是否带色自动升级。 */
      const keepColor = brush._rawGbrBpp === 4;
      if (!keepColor) {
        const n = tip.w * tip.h, gray = new Uint8Array(n);
        for (let i = 0; i < n; i++) gray[i] = tip.rgba[i * 4 + 3];
        return { w: tip.w, h: tip.h, bpp: 1, data: gray };
      }
      return { w: tip.w, h: tip.h, bpp: 4, data: tip.rgba };
    }
    throw new Error('该笔刷没有笔尖图像');
  }

  /* RGBA 是否真的带了颜色。灰度蒙版转成 RGBA 后 RGB 恒为 255（见 maskRgbaFromTip/
     pngTipPng），只有原生彩色笔刷才会出现非纯白 RGB。用这条判据决定写 bpp4 还是 bpp1，
     避免把普通灰度笔刷的体积×4。 */
  function rgbaHasColor(rgba) {
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i] !== 255 || rgba[i + 1] !== 255 || rgba[i + 2] !== 255) return true;
    }
    return false;
  }

  function buildGbrPixels(name, w, h, spacing, bpp, data, version) {
    /* 空名是合法的（GIMP 导出的 pipe cell 常常只有 NUL）：不能把 '' 兜底成 'brush'，
       否则 headerSize 从 29 变成 34，后面每个 cell 的偏移全部错位。 */
    const nm = (name === undefined || name === null) ? 'brush' : String(name);
    const nameBytes = cstr(Array.from(nm).slice(0, 120).join(''));
    /* 旧版（version 1）GBR 头只有 header_size/version/w/h/bpp 五个 u32 + 名字，
       没有 magic 和 spacing。GIMP 2.10 仍然直接读 v1，Krita 自带的若干 pipe
       （moo-bubbler / vegetal_stylised / RGBA anim …）就是 v1 cell。
       旧写端恒写 v2，往返一次头就从 20+N 变成 28+N，字节不再一致。 */
    if (version === 1) {
      const headerSize1 = 20 + nameBytes.length;
      const head1 = util.concat([be32(headerSize1), be32(1), be32(w), be32(h), be32(bpp)]);
      return util.concat([head1, nameBytes, data]);
    }
    const headerSize = BASE + nameBytes.length;
    const head = util.concat([
      be32(headerSize),
      be32(2), // version
      be32(w), be32(h),
      be32(bpp),
      be32(MAGIC),
      be32(spacing)
    ]);
    return util.concat([head, nameBytes, data]);
  }

  function buildGbr(brush) {
    const px = pixelsOf(brush);
    const w = px.w, h = px.h, bpp = px.bpp, data = px.data;
    if (data.length !== w * h * bpp) throw new Error('笔尖数据尺寸不符');
    const spacing = Math.max(1, Math.min(1000, Math.round(brush.spacingPct === undefined ? 10 : brush.spacingPct)));
    return buildGbrPixels(brush.name || 'brush', w, h, spacing, bpp, data);
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

  function padGray(t, nw, nh, bpp) {
    const k = bpp || 1;
    if (t.w === nw && t.h === nh) return t.data;
    const out = new Uint8Array(nw * nh * k);
    const left = Math.floor((nw - t.w) / 2), top = Math.floor((nh - t.h) / 2);
    for (let y = 0; y < t.h; y++) {
      out.set(t.data.subarray(y * t.w * k, (y + 1) * t.w * k), ((top + y) * nw + left) * k);
    }
    return out;
  }

  function buildGbrGray(name, w, h, spacing, gray) {
    return buildGbrPixels(name, w, h, spacing, 1, gray);
  }

  /* ---- pipe 头部（line 2）参数表 ----
     真实 GIMP 导出的 line 2 形如：
       "5 ncells:5 cellwidth:200 cellheight:195 step:0 dim:1 cols:1 rows:1 placement:constant rank0:5 sel0:random"
     旧写端把这一整行**重算**成常量模板：sel0 一律 incremental、step 换成 cell 的 spacing、
     dim/cols/rows/placement 补成默认、未知 token 全丢。于是：
       · sel0:random 的散布管道 → 写成 incremental（GIMP 里从「随机挑 cell」变成「依次轮换」）；
       · step:0（管道踏步，0=不指定）→ 被写成 20，间距被静默改掉；
       · 多维 pipe（cols/rows）被压平。
     现在把源头部按 token 原样带到写侧，只改「确实变了」的那几项。 */
  function parsePipeParams(line2) {
    const tokens = [];
    const map = Object.create(null);
    for (const part of String(line2 || '').trim().split(/\s+/)) {
      if (!part) continue;
      const i = part.indexOf(':');
      if (i < 0) { tokens.push({ key: null, value: part }); continue; }
      const key = part.slice(0, i), value = part.slice(i + 1);
      tokens.push({ key: key, value: value });
      if (!(key in map)) map[key] = value;
    }
    return { tokens: tokens, map: map };
  }

  function pipeHeaderLine(n, w, h, spacing, sel, src, sameLayout) {
    /* 源头部只在「整组的每个 cell 都来自同一个 pipe 且数量未变」时才可比对；
       writeGih 的调用方（convert.makeGih / makeGihFiles / scatterCells）会传不同粒度，
       这里自己再校验一遍，避免把 4 个 cell 的头部套到 1 个 cell 的文件上。 */
    const usable = src && src.tokens && src.tokens.length;
    if (!usable) {
      return n + ' ncells:' + n + ' cellwidth:' + w + ' cellheight:' + h +
        ' step:' + spacing + ' dim:1 cols:1 rows:1 placement:constant rank0:' + n + ' sel0:' + sel;
    }
    const out = [];
    for (const tok of src.tokens) {
      if (!tok.key) { out.push(String(n)); continue; }       /* 首段裸数字 = cell 数 */
      let v = tok.value;
      switch (tok.key) {
        case 'ncells': v = String(n); break;
        /* cell 画布没变就不要重算：GIMP 的 cellwidth/cellheight 是声明值，
           真实尺寸以每个 cell 自己的 GBR 头为准。原生文件里两者可以不一致
           （A_herbs.gih 声明 168×514、实际 cell 128×256），重算等于改掉源声明。 */
        case 'cellwidth': if (!sameLayout) v = String(w); break;
        case 'cellheight': if (!sameLayout) v = String(h); break;
        case 'step': v = String(spacing); break;
        case 'sel0': v = String(sel); break;
        default:
          if (/^rank\d+$/.test(tok.key)) {
            /* rank0 是第 0 维的 cell 数：1 维 pipe 时等于 cell 数。
               多维 pipe（存在 rank1..）在 cell 数不变时原样保留，变了就压成 1 维。 */
            if (!sameLayout) {
              if (tok.key === 'rank0') v = String(n);
              else continue;                                  /* 多维维度作废 */
            }
          } else if ((tok.key === 'cols' || tok.key === 'rows') && !sameLayout) {
            v = '1';
          }
          break;
      }
      out.push(tok.key + ':' + v);
    }
    /* 源里没有的项一律不补：v1 风格的短头部（只有 ncells/dim/rank0/sel0）本身就是合法的，
       补上 cellwidth/cellheight/step 会让头部与原文件不再一致。只兜底 ncells。 */
    if (!src.map.ncells) out.unshift('ncells:' + n);
    return out.join(' ');
  }

  function writeGih(brushes, pipeName, opts) {
    if (!brushes || !brushes.length) throw new Error('没有可写入 GIH 的笔刷');
    const px = brushes.map(pixelsOf);
    let w = 1, h = 1;
    for (const t of px) { w = Math.max(w, t.w); h = Math.max(h, t.h); }
    const n = brushes.length;
    const spacing = Math.max(1, Math.min(1000, Math.round(brushes[0].spacingPct === undefined ? 10 : brushes[0].spacingPct)));
    /* 整组同源的 pipe 头部：每个 cell 都来自同一个 _rawGroup、下标对齐、数量不变才算「同源」 */
    const g0 = brushes[0] && brushes[0]._rawGroup;
    let srcParams = null;
    if (g0 && g0.params && g0.count === n && brushes.every(function (b, i) {
      return b && b._rawGroup === g0 && b._rawGroupIndex === i;
    })) srcParams = g0.params;
    const sameLayout = !!srcParams && Number(g0.cellW) === w && Number(g0.cellH) === h;
    const srcSel = srcParams && srcParams.map.sel0 && /^(incremental|angular|velocity|random|pressure|xtilt|ytilt)$/.test(srcParams.map.sel0)
      ? srcParams.map.sel0 : null;
    const sel = (opts && typeof opts.sel === 'string') ? opts.sel : (srcSel || 'incremental');
    /* step（管道踏步）与 cell 的 spacing 是两个字段：源里 step:0 表示不指定，
       旧实现用 cell spacing 覆盖它等于改掉了笔刷间距。 */
    const step = (opts && opts.step !== undefined) ? opts.step
      : (srcParams && srcParams.map.step !== undefined ? srcParams.map.step : spacing);
    /* bpp：所有 cell 都带真实颜色才写 RGBA(4)，否则仍写 8-bit 灰度(1)。
       灰阶来源转出来的 rgba 的 RGB 恒为 255（见 rgbaHasColor），不会误判。 */
    const allRgba = px.every(function (t) { return t.bpp === 4; });
    const keepColor = allRgba && px.some(function (t) { return rgbaHasColor(t.data); });
    const bpp = keepColor ? 4 : 1;
    /* cell 头的版本：整组同源自 v1 pipe 时写回 v1（否则头长度会从 20+N 变 28+N） */
    const srcVer = g0 && brushes.every(function (b) { return b && b._cellVersion === 1; }) ? 1 : 2;
    const cellVersion = (srcParams && srcVer === 1) ? 1 : 2;
    const LF = new Uint8Array([0x0a]);
    const line1 = util.utf8Encode(String(pipeName || 'brushconv'));
    const line2 = util.utf8Encode(pipeHeaderLine(n, w, h, step, sel, srcParams, sameLayout));
    const parts = [line1, LF, line2, LF];
    for (let i = 0; i < n; i++) {
      const t = px[i];
      let data;
      if (bpp === 4) {
        data = t.bpp === 4 ? padGray(t, w, h, 4) : (function () {          /* 灰阶 cell 补成 RGBA */
          const g = padGray(t, w, h, 1), out2 = new Uint8Array(w * h * 4);
          for (let k = 0; k < w * h; k++) {
            out2[k * 4] = 255; out2[k * 4 + 1] = 255; out2[k * 4 + 2] = 255; out2[k * 4 + 3] = g[k];
          }
          return out2;
        })();
      } else {
        data = t.bpp === 4 ? (function () {                                /* 彩色 cell 降成 alpha 蒙版 */
          const g0b = new Uint8Array(t.w * t.h);
          for (let k = 0; k < t.w * t.h; k++) g0b[k] = t.data[k * 4 + 3];
          return padGray({ w: t.w, h: t.h, data: g0b }, w, h, 1);
        })() : padGray(t, w, h, 1);
      }
      const cellSpacing = Math.max(1, Math.min(1000, Math.round(brushes[i].spacingPct === undefined ? 10 : brushes[i].spacingPct)));
      const cellName = (brushes[i]._cellName !== undefined && brushes[i]._nameAuto !== undefined &&
        brushes[i].name === brushes[i]._nameAuto) ? brushes[i]._cellName : brushes[i].name;
      parts.push(buildGbrPixels(cellName, w, h, cellSpacing, bpp, data, cellVersion));
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
