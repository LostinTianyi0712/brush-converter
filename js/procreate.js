/* Procreate .brush / .brushset parser -> normalized brushes */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const zip = isNode ? require('./zip.js') : root.BC.zip;
  const png = isNode ? require('./png.js') : root.BC.png;
  const plist = isNode ? require('./plist.js') : root.BC.plist;
  const bplist = isNode ? require('./bplist.js') : root.BC.bplist;
  const defaultsApi = isNode ? require('./procreateDefaults.js') : root.BC.proDefaults;

  function isProcreate(bytes) {
    if (!zip.isZip(bytes)) return false;
    try {
      const entries = zip.read(bytes);
      return entries.some(e => /Brush\.archive$/i.test(e.name));
    } catch (e) { return false; }
  }

  function toRatio(v, def) {
    if (typeof v !== 'number' || !isFinite(v)) return def;
    return v;
  }

  function luminanceToTip(im) {
    // Procreate shape: white = opaque, black = transparent (luminance as coverage)
    const w = im.width, h = im.height;
    const rgba = new Uint8Array(w * h * 4);
    const src = im.rgba;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      const l = Math.max(src[o], src[o + 1], src[o + 2]);
      const a = src[o + 3] === 255 ? l : Math.round((l * src[o + 3]) / 255);
      rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255; rgba[o + 3] = a;
    }
    return { w, h, rgba };
  }

  function decodeShape(entry) {
    if (!entry) return null;
    try {
      const im = png.decode(entry.data());
      return luminanceToTip(im);
    } catch (e) { return null; }
  }

  function readBrushFolder(entries, prefix) {
    // prefix like 'UUID/' ('' for single-file .brush)
    const find = suffix => entries.find(e => e.name === prefix + suffix);
    const arcEntry = find('Brush.archive');
    if (!arcEntry) return null;
    let params = {};
    try { params = plist.unarchive(arcEntry.data()) || {}; } catch (e) { params = {}; }
    let name = typeof params.name === 'string' ? params.name.trim() : '';
    if (!name || name === '$null') name = '';
    let subArcEntry = null, subShapeEntry = null;
    const subArcCandidates = entries.filter(function (e) { return /(^|\/)Sub\d+\/Brush\.archive$/.test(e.name); });
    if (subArcCandidates.length) {
      const subPrefix = subArcCandidates[0].name.replace(/Brush\.archive$/, '');
      subArcEntry = subArcCandidates[0];
      subShapeEntry = entries.find(function (e) { return e.name === subPrefix + 'Shape.png'; }) || null;
    }
    const shapeEntry = find('Shape.png');
    const grainEntry = find('Grain.png');
    const tipFromShape = decodeShape(shapeEntry);
    const tipFromGrain = shapeEntry ? null : decodeShape(grainEntry);
    const tip = tipFromShape || tipFromGrain;
    let grainRgba = null;
    if (grainEntry) {
      try {
        const im = png.decode(grainEntry.data());
        grainRgba = { w: im.width, h: im.height, rgba: png.toMaskRgba(im.rgba) };
      } catch (e) { grainRgba = null; }
    }
    const tipSource = tipFromShape ? 'shape' : (tipFromGrain ? 'grain' : 'none');
    const maxSize = toRatio(params.maxSize, 1);
    const minSize = toRatio(params.minSize, 0.01);
    const pressSize = toRatio(params.dynamicsPressureSize, 0);
    const pressOpacity = toRatio(params.dynamicsPressureOpacity, 0);
    const maxOpacity = toRatio(params.maxOpacity, 1);
    const paintOpacity = toRatio(params.paintOpacity, 1);
    const minOpacity = toRatio(params.minOpacity, 0);
    const spacing = toRatio(params.plotSpacing, 0);
    // paintSize 是当前笔刷大小（×400≈像素），之前用 maxSize*120 会放大约 3~5 倍
    let sizePx = Math.round((Number(params.paintSize) > 0 ? Number(params.paintSize) : maxSize * 0.25) * 400);
    if (!isFinite(sizePx) || sizePx < 4) sizePx = 40;
    sizePx = Math.max(2, Math.min(3000, sizePx));
    const opacity = Math.max(0.01, Math.min(1, paintOpacity * maxOpacity));
    const minSizeRatio = pressSize > 0.05 ? Math.max(0.02, Math.min(1, minSize)) : 1;
    const minOpacityRatio = pressOpacity > 0.05 ? Math.max(0.02, Math.min(1, minOpacity || 0.25)) : 1;
    const nv = function (k, d) { const v = Number(params[k]); return isFinite(v) ? v : (d === undefined ? 0 : d); };
    const angleDeg = nv('shapeAngle');
    const roundnessPct = nv('shapeRoundness', 1) * 100;
    const taperOn = nv('taperSize') > 0.001 || nv('taperOpacity') > 0.001;
    const taperSizeV = nv('taperSize'), taperOpacityV = nv('taperOpacity');
    const taperStartLen = nv('taperStartLength'), taperEndLen = nv('taperEndLength');
    const wetAmount = nv('wetEdgesAmount');
    const smudgeSizeV = nv('smudgeSize'), smudgeOpacityV = nv('smudgeOpacity');
    const smudgeOnV = smudgeSizeV > 0.5 && smudgeOpacityV > 0.5;
    const smudgeAmount = smudgeOnV ? Math.max(0.05, Math.min(1, nv('dynamicsSmudgeAccumulation', 0.5))) : 0;
    const wetAccum = nv('dynamicsWetAccumulation');
    const grainDepthV = nv('grainDepth', 0);
    const grainDepthJitter = nv('grainDepthJitter');
    const grainDepthMin = nv('grainDepthMinimum');
    const texScaleV = nv('textureScale', 1);
    const texBrightV = nv('textureBrightness', 0.5);
    const texContrastV = nv('textureContrast', 1);
    const plotJitterV = nv('plotJitter');
    const smoothingV = nv('plotSmoothing');
    const hueDyn = Math.max(nv('dynamicsPressureHue'), nv('dynamicsJitterHue'), nv('dynamicsJitterStrokeHue'));
    const satDyn = Math.max(nv('dynamicsPressureSaturation'), nv('dynamicsJitterSaturation'), nv('dynamicsJitterStrokeSaturation'));
    const briDyn = Math.max(nv('dynamicsPressureBrightness'), nv('dynamicsJitterLightness'), nv('dynamicsJitterStrokeLightness'));
    const sizeJitV = Math.max(nv('dynamicsJitterSize'), nv('dynamicsTiltSize'));
    const pressureRound = nv('dynamicsPressureShapeRoundness');
    const dualBlendMode = Number(params.dualBlendMode) || 0;
    // 散布/数量：Procreate 的 shapeScatter（0~约2，对应 0~200%）、shapeCount（/16 为个数）
    let brushSubRaw = null;
    const scatterRaw = Number(params.shapeScatter) || 0;
    const shapeCountRaw = Number(params.shapeCount) || 0;
    const countJitterRaw = Number(params.shapeCountJitter) || 0;
    let dualOn = false, dualTip = null, dualSubName = '', dualBlendNum = 0;
    if (subArcEntry) {
      try {
        const subParams = plist.unarchive(subArcEntry.data()) || {};
        dualOn = true;
        dualSubName = typeof subParams.name === 'string' ? subParams.name : '';
        dualBlendNum = Number(params.dualBlendMode) || 0;
        if (subShapeEntry) dualTip = decodeShape(subShapeEntry);
        if (!dualTip) dualTip = roundTip(96);
        brushSubRaw = { archive: subArcEntry.data(), shape: subShapeEntry ? subShapeEntry.data() : null };
      } catch (e) { /* ignore */ }
    }
    const scatterPct = Math.max(0, Math.min(1000, scatterRaw * 100));
    const scatterCount = shapeCountRaw > 0.001 ? Math.max(2, Math.round(shapeCountRaw * 16)) : 1;
    return {
      name,
      tip,
      tipSource,
      _rawArchive: arcEntry.data(),
      _rawShape: shapeEntry ? shapeEntry.data() : null,
      _rawGrain: grainEntry ? grainEntry.data() : null,
      _grainRgba: grainRgba,
      sizePx,
      spacingPct: Math.max(0.5, Math.min(1000, spacing * 100)),
      opacity,
      minSizeRatio,
      minOpacityRatio,
      procreateDualBlendMode: dualBlendMode,
      dualOn: dualOn || undefined,
      dualTip: dualTip || undefined,
      dualBlendMode: dualBlendNum || undefined,
      dualBrush: dualOn ? { enabled: true, name: dualSubName, blend: dualBlendNum, diameter: undefined } : undefined,
      _rawSubArchive: brushSubRaw ? brushSubRaw.archive : undefined,
      _rawSubShape: brushSubRaw ? brushSubRaw.shape : undefined,
      pressure: pressSize > 0.05 || pressOpacity > 0.05,
      pressureSize: pressSize > 0.05,
      pressureOpacity: pressOpacity > 0.05,
      hasGrain: !!grainEntry,
      hardness: tip ? undefined : 0.8,
      hasTexture: !!grainEntry && grainDepthV > 0,
      angle: angleDeg,
      roundness: roundnessPct,
      taperOn: taperOn,
      taperSize: taperSizeV,
      taperOpacity: taperOpacityV,
      taperStartLength: taperStartLen,
      taperEndLength: taperEndLen,
      wetEdgesOn: wetAmount > 0.001,
      wetEdgesAmount: wetAmount,
      smudgeOn: smudgeOnV,
      smudgeSize: smudgeSizeV,
      smudgeOpacity: smudgeOpacityV,
      smudgeAmount: smudgeAmount,
      textureDepth: grainDepthV > 0 ? Math.max(0.05, Math.min(1, grainDepthV)) : 0,
      grainDepthMinimum: grainDepthMin,
      grainDepthJitter: grainDepthJitter,
      textureScale: texScaleV > 0 ? texScaleV : 1,
      textureBrightness: texBrightV * 100,
      textureContrast: texContrastV * 100,
      spacingJitterPct: plotJitterV * 100,
      smoothingStrength: smoothingV,
      colorDynamicsOn: hueDyn > 0.001 || satDyn > 0.001 || briDyn > 0.001,
      colorJitterHue: hueDyn,
      colorJitterSat: satDyn,
      colorJitterVal: briDyn,
      sizeJitterPct: sizeJitV * 100,
      roundnessDynamics: pressureRound,
      wetEdgesAccumulation: wetAccum,
      burntEdgesAmount: nv('burntEdgesAmount'),
      grainBlendMode: params.grainBlendMode,
      textureRotation: nv('textureRotation'),
      textureInverted: !!params.textureInverted,
      dynamicsLoad: nv('dynamicsLoad'),
      dynamicsGlazedFlow: nv('dynamicsGlazedFlow'),
      dynamicsMix: nv('dynamicsMix'),
      dynamicsMixSoftening: nv('dynamicsMixSoftening'),
      blendMode: params.blendMode,
      _params: params,
      scatterOn: scatterPct > 0.01,
      scatterPct: scatterPct,
      scatterCount: scatterCount,
      scatterBothAxes: true,
      countJitterPct: countJitterRaw * 100,
      source: 'procreate'
    };
  }

  function parse(bytes, fileName) {
    if (!zip.isZip(bytes)) throw new Error('不是 Procreate 笔刷文件（ZIP 容器）');
    const entries = zip.read(bytes);
    const brushes = [];
    const warnings = [];
    const baseName = (fileName || 'brush').replace(/\.(brush|brushset)$/i, '');

    // single .brush: Brush.archive at root
    if (entries.some(e => e.name === 'Brush.archive')) {
      const b = readBrushFolder(entries, '');
      if (b) {
        if (!b.name) b.name = baseName;
        if (!b.tip) warnings.push('该笔刷使用 Procreate 默认圆头（无 Shape 图），将自动生成圆头笔尖');
        brushes.push(b);
      }
      return { brushes, warnings, kind: 'brush' };
    }

    // .brushset: top-level folders
    const folders = new Set();
    for (const e of entries) {
      const m = /^([^/]+)\//.exec(e.name);
      if (m && !m[1].startsWith('.')) folders.add(m[1]);
    }
    let autoIndex = 0;
    for (const folder of folders) {
      autoIndex++;
      const prefix = folder + '/';
      // skip sub-brushes (Sub01 etc.) — only top folder archive
      if (entries.some(e => e.name === prefix + 'Sub01/Brush.archive')) {
        // still readable, just ignore sub variants
      }
      try {
        const b = readBrushFolder(entries, prefix);
        if (!b) continue;
        if (!b.name) b.name = /^[0-9A-Fa-f-]{20,}$/.test(folder) ? (baseName + ' ' + autoIndex) : folder;
        if (!b.tip) warnings.push(b.name + ': 使用默认圆头（无 Shape 图），将自动生成圆头笔尖');
        brushes.push(b);
      } catch (e) {
        warnings.push('解析失败 ' + folder + ': ' + e.message);
      }
    }
    if (!brushes.length) {
      warnings.push('brushset 中没有可转换的笔刷（可能全部使用默认圆头，或只含参数设置）');
    }
    return { brushes, warnings, kind: 'brushset' };
  }

  /* ================= Procreate writer ================= */

  function synthRoundTip(brush, n) {
    n = n || 256;
    const hard = Math.max(0.05, Math.min(1, brush.hardness === undefined ? 0.75 : brush.hardness));
    const round = Math.max(0.05, Math.min(1, brush.roundness === undefined ? 1 : brush.roundness));
    const rgba = new Uint8Array(n * n * 4);
    const c = (n - 1) / 2;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = (x - c) / c, dy = (y - c) / (c * round);
        const d = Math.sqrt(dx * dx + dy * dy);
        let a;
        if (d >= 1) a = 0;
        else if (d <= hard) a = 1;
        else a = (1 - d) / (1 - hard);
        const o = (y * n + x) * 4;
        rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255;
        rgba[o + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
      }
    }
    return { w: n, h: n, rgba };
  }

  function tipRGBA(brush, opts) {
    const tip = brush.tip;
    if (!tip) return synthRoundTip(brush, 256, opts);
    if (tip.rgba) return { w: tip.w, h: tip.h, rgba: tip.rgba };
    if (tip.data) {
      const w = tip.w, h = tip.h, bpp = tip.bpp || 1;
      const rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const a = bpp === 2 ? tip.data[i * 2] : tip.data[i];
        rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = a;
      }
      return { w, h, rgba };
    }
    return null;
  }

  function shapePng(tip, maxSize) {
    let w = tip.w, h = tip.h, rgba = tip.rgba;
    const maxSide = Math.max(w, h);
    const limit = Math.max(64, Math.min(2048, maxSize || 512));
    if (maxSide > limit) {
      const sc = limit / maxSide;
      const nw = Math.max(1, Math.round(w * sc)), nh = Math.max(1, Math.round(h * sc));
      rgba = png.resize(rgba, w, h, nw, nh);
      w = nw; h = nh;
    }
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = rgba[i * 4 + 3];
    return { png: png.encodeGray(w, h, gray), w, h };
  }

  function thumbPng(tip, opts) {
    const W = 256, H = 128;
    const bg = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { bg[i * 4] = 255; bg[i * 4 + 1] = 255; bg[i * 4 + 2] = 255; bg[i * 4 + 3] = 255; }
    const tipW = tip.w, tipH = tip.h;
    const stampMax = 64;
    const sc = stampMax / Math.max(tipW, tipH);
    const sw = Math.max(1, Math.round(tipW * sc)), sh = Math.max(1, Math.round(tipH * sc));
    const stamp = png.resize(tip.rgba, tipW, tipH, sw, sh);
    const spacing = Math.max(0.05, Math.min(1, (opts.spacingPct || 10) / 100));
    const step = Math.max(1.5, sw * spacing);
    const alpha = Math.max(0.2, Math.min(1, opts.opacity === undefined ? 1 : opts.opacity));
    for (let x = 8; x < W - 8; x += step) {
      const t = (x - 8) / (W - 16);
      const cy = H / 2 + Math.sin(t * Math.PI * 1.7) * 26;
      const s = 0.55 + 0.45 * Math.sin(t * Math.PI);
      const dw = Math.max(1, Math.round(sw * s)), dh = Math.max(1, Math.round(sh * s));
      const px = Math.round(x), py = Math.round(cy);
      for (let yy = 0; yy < dh; yy++) {
        const dy = Math.round(py - dh / 2 + yy);
        if (dy < 0 || dy >= H) continue;
        for (let xx = 0; xx < dw; xx++) {
          const dx = Math.round(px - dw / 2 + xx);
          if (dx < 0 || dx >= W) continue;
          const sx = Math.min(sw - 1, Math.floor((xx * sw) / dw));
          const sy = Math.min(sh - 1, Math.floor((yy * sh) / dh));
          const a = (stamp[(sy * sw + sx) * 4 + 3] / 255) * alpha;
          if (a <= 0) continue;
          const o = (dy * W + dx) * 4;
          bg[o] = Math.round(bg[o] * (1 - a) + 45 * a);
          bg[o + 1] = Math.round(bg[o + 1] * (1 - a) + 45 * a);
          bg[o + 2] = Math.round(bg[o + 2] * (1 - a) + 50 * a);
        }
      }
    }
    return png.encode(W, H, bg);
  }

  /* 圆头笔尖（给没有 Shape 的默认圆头笔刷做缩略图） */
  function roundTip(sizePx) {
    const n = Math.max(32, Math.min(256, Math.round(sizePx || 128)));
    const rgba = new Uint8Array(n * n * 4);
    const r = n / 2;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const d = Math.sqrt((x - r + 0.5) * (x - r + 0.5) + (y - r + 0.5) * (y - r + 0.5)) / r;
        const a = Math.max(0, Math.min(1, 1 - d)) * 255;
        const o = (y * n + x) * 4;
        rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255; rgba[o + 3] = Math.round(a);
      }
    }
    return { w: n, h: n, rgba: rgba };
  }

  /* Grain.png：优先用源笔刷真实纹理（Procreate Grain / ABR 图案），否则程序化噪声 */
  function grainPng(brush) {
    if (brush._grainRgba && brush._grainRgba.w > 0) {
      const g = brush._grainRgba;
      return png.encode(g.w, g.h, g.rgba);
    }
    if (brush._patternPixels && brush._patternPixels.w > 0) {
      const pp = brush._patternPixels, w = pp.w, h = pp.h;
      const out = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        let v;
        if (pp.mode === 3) { const o = i * 3; v = Math.round((pp.data[o] + pp.data[o + 1] + pp.data[o + 2]) / 3); }
        else v = pp.data[i];
        out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
      }
      return png.encode(w, h, out);
    }
    const gw = 512, gh = 512;
    const noise = convGrainNoise(gw, gh, 5, 4);
    const grainRgba = new Uint8Array(gw * gh * 4);
    for (let i = 0; i < gw * gh; i++) {
      const v = Math.round(255 * (0.55 + 0.45 * noise[i]));
      grainRgba[i * 4] = v; grainRgba[i * 4 + 1] = v; grainRgba[i * 4 + 2] = v; grainRgba[i * 4 + 3] = 255;
    }
    return png.encode(gw, gh, grainRgba);
  }

  function buildArchive(brush, opts) {
    const D = defaultsApi.defaults();
    const params = Object.assign(D, {
      version: 2,
      plotSpacingVersion: 1,
      // paintSize 是当前大小（×400≈像素），maxSize 是上限；往返尺寸才一致
      paintSize: Math.max(0.0005, Math.min(4, (brush.sizePx || 100) / 400)),
      maxSize: Math.max(0.02, Math.min(16, ((brush.sizePx || 100) / 400) * 1.6)),
      minSize: Math.max(0.01, Math.min(1, brush.minSizeRatio === undefined ? 0.05 : brush.minSizeRatio)),
      maxOpacity: Math.max(0.01, Math.min(1, brush.opacity === undefined ? 1 : brush.opacity)),
      minOpacity: 0,
      paintOpacity: 1,
      plotSpacing: Math.max(0.001, Math.min(1.0, (brush.spacingPct || 10) / 100)),
      shapeRoundness: Math.max(0.05, Math.min(1, (brush.roundness === undefined ? 100 : brush.roundness) / 100)),
      shapeAngle: brush.angle || 0,
      shapeScatter: brush.scatterOn ? Math.max(0, Math.min(2, (brush.scatterPct || 0) / 100)) : 0,
      // shapeCount 在 Procreate 里是 ×16 的归一化值（0.625 = 10 个）
      shapeCount: brush.scatterOn ? Math.max(0, Math.min(1, (brush.scatterCount || 0) / 16)) : 0,
      shapeCountJitter: Math.max(0, Math.min(1, (brush.countJitterPct || 0) / 100)),
      plotJitter: Math.max(0, Math.min(1, (brush.spacingJitterPct || 0) / 100)),
      plotSmoothing: Math.max(0, Math.min(1, brush.smoothingStrength === undefined ? 0 : brush.smoothingStrength)),
      grainDepthJitter: Math.max(0, Math.min(1, brush.grainDepthJitter || 0)),
      textureScale: Math.max(0.01, Math.min(20, brush.textureScale === undefined ? 1 : brush.textureScale)),
      textureBrightness: Math.max(0, Math.min(1, (brush.textureBrightness === undefined ? 51 : brush.textureBrightness) / 100)),
      textureContrast: Math.max(0, Math.min(1, (brush.textureContrast === undefined ? 100 : brush.textureContrast) / 100)),
      textureRotation: brush.textureRotation || 0,
      shapeOrientation: 1,
      previewSize: 0.08,
      dynamicsPressureSize: brush.pressure && (brush.minSizeRatio === undefined || brush.minSizeRatio < 0.95) ? 1 : 0,
      dynamicsPressureOpacity: brush.pressureOpacity ? 1 : 0,
      dynamicsJitterSize: Math.max(0, Math.min(1, (brush.sizeJitterPct || 0) / 100)),
      minOpacity: brush.minOpacityRatio === undefined ? 0 : Math.max(0, Math.min(1, brush.minOpacityRatio)),
      grainDepth: brush.hasTexture ? Math.max(0, Math.min(1, brush.textureDepth === undefined ? (brush.grainStrength === undefined ? 0.6 : brush.grainStrength) : brush.textureDepth)) : 0,
      grainBlendMode: brush.hasTexture ? 0 : 1,
      taperSize: brush.taperOn ? Math.max(0, Math.min(1, brush.taperSize === undefined ? 0.5 : brush.taperSize)) : 0,
      taperOpacity: brush.taperOn ? Math.max(0, Math.min(1, brush.taperOpacity === undefined ? 0.5 : brush.taperOpacity)) : 0,
      taperStartLength: brush.taperOn ? Math.max(0, Math.min(1, brush.taperStartLength || 0.2)) : 0,
      taperEndLength: brush.taperOn ? Math.max(0, Math.min(1, brush.taperEndLength === undefined ? 0.3 : brush.taperEndLength)) : 0,
      wetEdgesAmount: brush.wetEdgesOn ? Math.max(0, Math.min(1, brush.wetEdgesAmount === undefined ? 0.4 : brush.wetEdgesAmount)) : 0,
      smudgeSize: brush.smudgeOn ? Math.max(0, Math.min(1, brush.smudgeAmount === undefined ? 0.3 : brush.smudgeAmount)) : 0,
      smudgeOpacity: brush.smudgeOn ? Math.max(0, Math.min(1, brush.smudgeAmount === undefined ? 0.3 : brush.smudgeAmount)) : 0,
      dynamicsJitterHue: Math.max(0, Math.min(1, brush.colorJitterHue || 0)),
      dynamicsJitterSaturation: Math.max(0, Math.min(1, brush.colorJitterSat || 0)),
      dynamicsJitterLightness: Math.max(0, Math.min(1, brush.colorJitterVal || 0)),
      blendMode: 0,
      dualBlendMode: (function () {
        if (typeof brush.dualBlendMode === 'number') return brush.dualBlendMode;
        const nm = String(brush.dualBlendMode || (brush.dualBrush && brush.dualBrush.blend) || '').toLowerCase().replace(/[^a-z]/g, '');
        const map = { nrml: 0, drkn: 1, mltp: 2, cbrn: 3, linearburn: 4, lghn: 5, scrn: 6, hmix: 7, hardmix: 7, ovrl: 8, sftl: 9, hrdl: 10 };
        return map[nm] || 0;
      })(),
      importedFromABR: brush.source === 'abr',
      name: brush.name || 'brush'
    });
    return bplist.writeKeyedArchive(params, 'SilicaBrush', ['SilicaBrush', 'ValkyrieBrush', 'NSObject']);
  }

  function convGrainNoise(w, h, seed, scale) {
    if (isNode) return require('./convert.js').grainNoise(w, h, seed, scale);
    return root.BC.convert.grainNoise(w, h, seed, scale);
  }

  function writeBrush(brush, opts) {
    opts = opts || {};
    // 还原优先：源就是 Procreate 且没有改过参数时，原样复用 archive/Shape/Grain
    if (opts.fidelity !== false && brush._rawArchive && !opts.forceRebuild) {
      const entries = [{ name: 'Brush.archive', data: new Uint8Array(brush._rawArchive) }];
      if (brush._rawShape) entries.push({ name: 'Shape.png', data: new Uint8Array(brush._rawShape) });
      if (brush._rawGrain) entries.push({ name: 'Grain.png', data: new Uint8Array(brush._rawGrain) });
      if (brush._rawSubArchive) {
        entries.push({ name: 'Sub01/Brush.archive', data: new Uint8Array(brush._rawSubArchive) });
        if (brush._rawSubShape) entries.push({ name: 'Sub01/Shape.png', data: new Uint8Array(brush._rawSubShape) });
      }
      let tipRaw = brush._rawShape ? decodeShape({ data: () => new Uint8Array(brush._rawShape) }) : null;
      if (!tipRaw) tipRaw = roundTip(brush.sizePx || 128);
      entries.push({ name: 'QuickLook/Thumbnail.png', data: thumbPng(tipRaw, { spacingPct: brush.spacingPct, opacity: brush.opacity }) });
      return zip.write(entries);
    }
    const tip = tipRGBA(brush, opts);
    if (!tip) throw new Error('该笔刷没有笔尖图像，无法写入 Procreate 格式');
    const shape = shapePng(tip, opts.maxTipSize || 512);
    const thumb = thumbPng(tip, { spacingPct: brush.spacingPct, opacity: brush.opacity });
    const archive = buildArchive(brush, opts);
    const entries = [
      { name: 'Brush.archive', data: archive },
      { name: 'Shape.png', data: shape.png },
      { name: 'QuickLook/Thumbnail.png', data: thumb }
    ];
    if (brush.hasTexture && !opts.noTextureBake) {
      entries.push({ name: 'Grain.png', data: grainPng(brush) });
    }
    if (brush.dualOn && brush.dualTip) {
      const subArchive = buildArchive(Object.assign({}, brush, {
        name: (brush.dualBrush && brush.dualBrush.name) || (brush.name + ' 2'),
        dualOn: false
      }), opts);
      entries.push({ name: 'Sub01/Brush.archive', data: subArchive });
      let dtip = brush.dualTip;
      if (dtip && !dtip.rgba && dtip.data) {
        const bpp = dtip.bpp || 1;
        const rgba = new Uint8Array(dtip.w * dtip.h * 4);
        for (let i = 0; i < dtip.w * dtip.h; i++) {
          const a = bpp >= 3 ? Math.max(dtip.data[i * bpp], dtip.data[i * bpp + 1], dtip.data[i * bpp + 2]) : dtip.data[i];
          rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = a;
        }
        dtip = { w: dtip.w, h: dtip.h, rgba: rgba };
      }
      if (dtip && dtip.rgba) entries.push({ name: 'Sub01/Shape.png', data: shapePng(dtip, opts.maxTipSize || 512).png });
    }
    return zip.write(entries);
  }

  function writeBrushset(brushList, opts) {
    opts = opts || {};
    const files = [];
    brushList.forEach(function (brush, i) {
      const uuid = proUuid();
      const folder = uuid + '/';
      if (opts.fidelity !== false && brush._rawArchive && !opts.forceRebuild) {
        files.push({ name: folder + 'Brush.archive', data: new Uint8Array(brush._rawArchive) });
        if (brush._rawShape) files.push({ name: folder + 'Shape.png', data: new Uint8Array(brush._rawShape) });
        if (brush._rawGrain) files.push({ name: folder + 'Grain.png', data: new Uint8Array(brush._rawGrain) });
        if (brush._rawSubArchive) {
          files.push({ name: folder + 'Sub01/Brush.archive', data: new Uint8Array(brush._rawSubArchive) });
          if (brush._rawSubShape) files.push({ name: folder + 'Sub01/Shape.png', data: new Uint8Array(brush._rawSubShape) });
        }
        let tp = brush._rawShape ? decodeShape({ data: () => new Uint8Array(brush._rawShape) }) : null;
        if (!tp) tp = roundTip(brush.sizePx || 128);
        files.push({ name: folder + 'QuickLook/Thumbnail.png', data: thumbPng(tp, { spacingPct: brush.spacingPct, opacity: brush.opacity }) });
        return;
      }
      const tip = tipRGBA(brush);
      if (!tip) return;
      const shape = shapePng(tip, opts.maxTipSize || 512);
      const thumb = thumbPng(tip, { spacingPct: brush.spacingPct, opacity: brush.opacity });
      const archive = buildArchive(brush, opts);
      files.push({ name: folder + 'Brush.archive', data: archive });
      files.push({ name: folder + 'Shape.png', data: shape.png });
      files.push({ name: folder + 'QuickLook/Thumbnail.png', data: thumb });
      if (brush.hasTexture && !opts.noTextureBake) {
        files.push({ name: folder + 'Grain.png', data: grainPng(brush) });
      }
      if (brush.dualOn && brush.dualTip) {
        let dtip = brush.dualTip;
        if (dtip && !dtip.rgba && dtip.data) {
          const bpp = dtip.bpp || 1;
          const rgba = new Uint8Array(dtip.w * dtip.h * 4);
          for (let k = 0; k < dtip.w * dtip.h; k++) {
            const a = bpp >= 3 ? Math.max(dtip.data[k * bpp], dtip.data[k * bpp + 1], dtip.data[k * bpp + 2]) : dtip.data[k];
            rgba[k * 4] = 255; rgba[k * 4 + 1] = 255; rgba[k * 4 + 2] = 255; rgba[k * 4 + 3] = a;
          }
          dtip = { w: dtip.w, h: dtip.h, rgba: rgba };
        }
        const subArchive = buildArchive(Object.assign({}, brush, {
          name: (brush.dualBrush && brush.dualBrush.name) || (brush.name + ' 2'),
          dualOn: false
        }), opts);
        files.push({ name: folder + 'Sub01/Brush.archive', data: subArchive });
        if (dtip && dtip.rgba) files.push({ name: folder + 'Sub01/Shape.png', data: shapePng(dtip, opts.maxTipSize || 512).png });
      }
    });
    if (!files.length) throw new Error('没有可写入 Procreate 的笔刷（都缺少笔尖图像）');
    return zip.write(files);
  }

  function proUuid() {
    const hex = '0123456789ABCDEF';
    const b = util.randomBytes(16);
    let s = '';
    for (let i = 0; i < 16; i++) {
      if (i === 4 || i === 6 || i === 8 || i === 10) s += '-';
      s += hex[b[i] >> 4] + hex[b[i] & 15];
    }
    return s;
  }

  const api = { isProcreate, parse, writeBrush, writeBrushset, buildArchive, shapePng, thumbPng };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { procreate: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
