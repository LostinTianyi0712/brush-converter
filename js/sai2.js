/* Easy Paint Tool SAI 2 scatter brush writer.
   SAI2 brushes live in one folder: "<name>.bmp" (8-bit indexed brush shape)
   + "<name>.ini" (scatter-brush parameters).  There is no single bundled
   container, so a converted set is emitted as flat files (optionally zipped).
   INI keys reverse-engineered from the SAI2 scatter-brush INI format. */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;

  /* ---------- BMP (8-bit indexed, grayscale palette) ---------- */
  function u16(n) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]); }
  function u32le(n) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]); }

  function encodeBmp8(w, h, gray) {
    const rowSize = ((w + 3) >> 2) << 2;
    const pixelBytes = rowSize * h;
    const paletteBytes = 256 * 4;
    const offBits = 14 + 40 + paletteBytes;
    const total = offBits + pixelBytes;
    const out = new Uint8Array(total);
    // BITMAPFILEHEADER
    out[0] = 0x42; out[1] = 0x4d; // 'BM'
    out.set(u32le(total), 2);
    out.set(u32le(0), 6);
    out.set(u32le(offBits), 10);
    // BITMAPINFOHEADER
    out.set(u32le(40), 14);
    out.set(u32le(w), 18);
    out.set(u32le(h), 22);
    out.set(u16(1), 26);   // planes
    out.set(u16(8), 28);   // bpp
    out.set(u32le(0), 30); // compression BI_RGB
    out.set(u32le(pixelBytes), 34);
    out.set(u32le(2835), 38); // 72 DPI
    out.set(u32le(2835), 42);
    out.set(u32le(256), 46); // colors used
    out.set(u32le(256), 50);
    // palette: grayscale
    for (let i = 0; i < 256; i++) {
      const o = 54 + i * 4;
      out[o] = i; out[o + 1] = i; out[o + 2] = i; out[o + 3] = 0;
    }
    // pixels: bottom-up rows
    for (let y = 0; y < h; y++) {
      const srcRow = h - 1 - y;
      const dst = offBits + y * rowSize;
      for (let x = 0; x < w; x++) out[dst + x] = gray[srcRow * w + x];
    }
    return out;
  }

  /* Brush shape BMP: SAI uses luminance as opacity (white = paint). */
  function tipGray(tip) {
    if (!tip) return null;
    if (tip.data) return { w: tip.w, h: tip.h, data: tip.data };
    if (!tip.rgba) return null;
    const w = tip.w, h = tip.h, g = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = tip.rgba[i * 4 + 3];
    return { w: w, h: h, data: g };
  }

  function trimCenter(g) {
    let minX = g.w, minY = g.h, maxX = -1, maxY = -1;
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (g.data[y * g.w + x] <= 4) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (maxX < 0) return g;
    const cw = maxX - minX + 1, ch = maxY - minY + 1, side = Math.max(cw, ch);
    const out = new Uint8Array(side * side);
    const ox = ((side - cw) / 2) | 0, oy = ((side - ch) / 2) | 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++)
      out[(oy + y) * side + (ox + x)] = g.data[(minY + y) * g.w + (minX + x)];
    return { w: side, h: side, data: out };
  }

  /* Keep only the largest connected blob (removes stray specks that otherwise
     draw an extra thin line), then nearest-resize to the final brush pixel size
     so SAI2 does not smooth the grain away when down-scaling. */
  function cleanAndSize(g, target) {
    const thr = 8;
    const w = g.w, h = g.h, d = g.data;
    const seen = new Uint8Array(w * h);
    let best = null;
    for (let i = 0; i < w * h; i++) {
      if (seen[i] || d[i] <= thr) continue;
      const stack = [i]; seen[i] = 1; const cells = [];
      while (stack.length) {
        const idx = stack.pop(); cells.push(idx);
        const y = (idx / w) | 0, x = idx % w;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (seen[ni] || d[ni] <= thr) continue;
          seen[ni] = 1; stack.push(ni);
        }
      }
      if (!best || cells.length > best.length) best = cells;
    }
    const keep = new Uint8Array(w * h);
    if (best) for (const idx of best) keep[idx] = d[idx];
    const n = Math.max(8, Math.min(500, Math.round(target || 64)));
    const out = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) {
      const sy = Math.min(h - 1, Math.floor(y * h / n));
      for (let x = 0; x < n; x++) {
        const sx = Math.min(w - 1, Math.floor(x * w / n));
        out[y * n + x] = keep[sy * w + sx];
      }
    }
    return { w: n, h: n, data: out };
  }

  function buildIni(brush) {
    const size = Math.max(1, Math.min(5000, Math.round(brush.sizePx || 40)));
    const spacing = Math.max(1, Math.min(1000, Math.round((brush.spacingPct || 10))));
    const angle = Math.round((isFinite(brush.angle) ? brush.angle : 0));
    const ratio = Math.max(10, Math.min(100, Math.round(brush.roundness === undefined ? 100 : brush.roundness)));
    const opacity = Math.max(1, Math.min(100, Math.round((brush.opacity === undefined ? 1 : brush.opacity) * 100)));
    const lines = [
      '; Converted by BrushConverter',
      '[Parameters]',
      'AngleControl = 0',
      'Angle = ' + (angle >= 0 ? '+' : '') + angle,
      'AngleJitter = 0',
      'Scaling = 100',
      'ShapeSize = ' + size,
      'SizeJitter = 0',
      'Spacing = ' + spacing,
      'Scattering = 0',
      'WxHRatio = ' + ratio + ':100',
      'WxHJitter = 0',
      'Count = 1',
      'CountJitter = 0',
      'AllDirScattering = 0',
      'GaussianDistribution = 0',
      'AbsoluteSize = 0',
      'IntegerPosition = 0',
      'HighQualitySampling = 1',
      'ColJitter = 0',
      'HueJitter = 0',
      'SaturationJitter = 0',
      'BrightnessJitter = 0',
      'ApplyToEachShape = 0',
      'Opacity = ' + opacity,
      ''
    ];
    return util.utf8Encode(lines.join('\r\n'));
  }

  function sanitize(name) {
    return String(name || 'brush').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'brush';
  }

  function makeSai2Brush(brush) {
    const tip = tipGray(brush.tip);
    if (!tip) throw new Error('该笔刷没有笔尖形状，无法写成 SAI2 笔刷形状 BMP');
    const target = Math.max(8, Math.min(500, Math.round(brush.sizePx || 40)));
    const g = cleanAndSize(trimCenter(tip), target);
    const bmp = encodeBmp8(g.w, g.h, g.data);
    const ini = buildIni(brush);
    const name = sanitize(brush.name);
    return {
      files: [
        { name: name + '.bmp', data: bmp },
        { name: name + '.ini', data: ini }
      ],
      name: name
    };
  }

  function makeSai2Pack(brushList) {
    const zip = isNode ? require('./zip.js') : root.BC.zip;
    const files = [];
    const used = {};
    const warnings = [];
    for (const brush of brushList || []) {
      let made;
      try { made = makeSai2Brush(brush); }
      catch (e) { warnings.push((brush.name || '未命名') + '：' + e.message); continue; }
      let base = made.name, i = 2;
      while (used[base.toLowerCase()]) { base = made.name + '_' + i; i++; }
      used[base.toLowerCase()] = true;
      for (const f of made.files) {
        const ext = f.name.slice(f.name.lastIndexOf('.'));
        files.push({ name: base + ext, data: f.data });
      }
    }
    files.push({
      name: '说明.txt',
      data: util.utf8Encode(
        'SAI2 笔刷（scatter brush）导入说明\r\n' +
        '==============================\r\n' +
        '1. 找到 SAI2 的 scatter brush 文件夹（通常在 SAI2 安装目录或用户目录下，\r\n' +
        '   名字类似 tool\\scatterbrush / scatterbrush）。\r\n' +
        '2. 把本包里的每个 <名字>.bmp 和对应 <名字>.ini 一起放进该文件夹。\r\n' +
        '3. 重启 SAI2，在笔刷设置里选择 scatter brush（散布笔刷）即可看到新增笔刷。\r\n' +
        '说明：SAI2 没有单文件笔刷格式，必须 bmp + ini 成对放入同一文件夹。\r\n'
      )
    });
    return { bytes: zip.write(files), count: files.length >> 1, warnings: warnings };
  }

  const api = { makeSai2Brush: makeSai2Brush, makeSai2Pack: makeSai2Pack, encodeBmp8: encodeBmp8 };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { sai2: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
