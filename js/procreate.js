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
    const subArcCandidates = entries.filter(function (e) {
      return e.name.indexOf(prefix) === 0 && /^Sub\d+\/Brush\.archive$/.test(e.name.slice(prefix.length));
    });
    if (subArcCandidates.length) {
      const subPrefix = subArcCandidates[0].name.replace(/Brush\.archive$/, '');
      subArcEntry = subArcCandidates[0];
      subShapeEntry = entries.find(function (e) { return e.name === subPrefix + 'Shape.png'; }) || null;
    }
    const shapeEntry = find('Shape.png');
    const grainEntry = find('Grain.png');
    const tipFromShape = decodeShape(shapeEntry);
    // Grain is an independent texture, never a substitute for a bundled Shape.
    const tipFromGrain = null;
    const tip = tipFromShape || tipFromGrain;
    let grainRgba = null;
    if (grainEntry) {
      try {
        const im = png.decode(grainEntry.data());
        grainRgba = { w: im.width, h: im.height, rgba: im.rgba };
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
    if (!isFinite(sizePx) || sizePx <= 0) sizePx = 40;
    sizePx = Math.max(0.2, Math.min(3000, sizePx));
    const opacity = Math.max(0, Math.min(1, paintOpacity * maxOpacity));
    const minSizeRatio = pressSize > 0.05 ? Math.max(0, Math.min(1, minSize)) : 1;
    const minOpacityRatio = pressOpacity > 0.05 ? Math.max(0, Math.min(1, minOpacity)) : 1;
    const nv = function (k, d) { const v = Number(params[k]); return isFinite(v) ? v : (d === undefined ? 0 : d); };
    // Procreate 的 shapeAngle 存的是弧度（真实样本 -1.5708 = -90°）
    const angleDeg = nv('shapeAngle') * 180 / Math.PI;
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
    const sizeJitV = nv('dynamicsJitterSize');
    const pressureRound = nv('dynamicsPressureShapeRoundness');
    const dualBlendMode = Number(params.dualBlendMode) || 0;
    const tiltSizeDyn = Math.max(0, Number(params.dynamicsTiltSize) || 0);
    const tiltOpacityDyn = Math.max(0, Number(params.dynamicsTiltOpacity) || 0);
    const tiltAngleDyn = Math.max(0, Number(params.dynamicsTiltAngle) || 0);
    const tiltRoundnessDyn = Math.max(0, Number(params.dynamicsTiltShapeRoundness) || 0);
    const speedSizeDyn = Math.max(0, Number(params.dynamicsSpeedSize) || 0);
    const speedOpacityDyn = Math.max(0, Number(params.dynamicsSpeedOpacity) || 0);
    // Procreate 参数语义（与官方 Brush Studio 一致）：
    //   Stroke Path 的 Jitter(plotJitter) = 位置散布；Shape 的 Scatter(shapeScatter) = 每颗笔尖随机旋转
    //   过去把 shapeScatter 当位置散布会写出过大的 PS 散布（包浆笔刷 2 → 200%），必须分开映射。
    let brushSubRaw = null;
    const plotJitterRaw = Number(params.plotJitter) || 0;
    const shapeScatterRaw = Number(params.shapeScatter) || 0;
    const shapeCountRaw = Number(params.shapeCount) || 0;
    const countJitterRaw = Number(params.shapeCountJitter) || 0;
    let dualOn = false, dualTip = null, dualSubName = '', dualBlendNum = 0, subBrush = null;
    if (subArcEntry) {
      try {
        const subParams = plist.unarchive(subArcEntry.data()) || {};
        subBrush = readBrushFolder(entries, subArcEntry.name.slice(0, -'Brush.archive'.length));
        dualOn = true;
        dualSubName = typeof subParams.name === 'string' ? subParams.name : '';
        dualBlendNum = Number(params.dualBlendMode) || 0;
        if (subBrush) dualTip = subBrush.tip;
        if (!dualTip && subShapeEntry) dualTip = decodeShape(subShapeEntry);
        if (!dualTip) dualTip = roundTip(96);
        brushSubRaw = { archive: subArcEntry.data(), shape: subShapeEntry ? subShapeEntry.data() : null };
      } catch (e) { /* ignore */ }
    }
    // plotJitter 内部刻度约 0–10（样本最高 7.02 = 约 70%），换算成百分比
    const scatterPct = Math.max(0, Math.min(1000, plotJitterRaw * 10));
    const rotationScatterPct = Math.max(0, Math.min(100, shapeScatterRaw * 50));
    const scatterCount = shapeCountRaw > 0.001 ? Math.max(1, Math.round(shapeCountRaw * 16)) : 1;
    const brush = {
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
      tiltSizeDyn: tiltSizeDyn,
      tiltOpacityDyn: tiltOpacityDyn,
      tiltAngleDyn: tiltAngleDyn,
      tiltRoundnessDyn: tiltRoundnessDyn,
      speedSizeDyn: speedSizeDyn,
      speedOpacityDyn: speedOpacityDyn,
      dualOn: dualOn || undefined,
      dualTip: dualTip || undefined,
      dualBlendMode: dualOn ? dualBlendNum : undefined,
      dualBrush: dualOn ? Object.assign({}, subBrush || {}, {
        enabled: true, name: dualSubName, blend: dualBlendNum,
        diameter: subBrush ? subBrush.sizePx : undefined,
        spacing: subBrush ? subBrush.spacingPct : undefined
      }) : undefined,
      dualSubBrush: subBrush || undefined,
      _rawSubArchive: brushSubRaw ? brushSubRaw.archive : undefined,
      _rawSubShape: brushSubRaw ? brushSubRaw.shape : undefined,
      _rawSubGrain: subBrush ? subBrush._rawGrain : undefined,
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
      spacingJitterPct: 0,
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
      scatterOn: scatterPct > 0.01 || scatterCount > 1,
      angleJitterDeg: rotationScatterPct,
      procreateRotationScatterPct: rotationScatterPct,
      procreateJitterPct: scatterPct,
      scatterPct: scatterPct,
      scatterCount: scatterCount,
      scatterBothAxes: true,
      countJitterPct: countJitterRaw * 100,
      source: 'procreate'
    };
    brush._rawNormalized = {};
    Object.keys(brush).forEach(function(key){const v=brush[key];if(key[0]!=='_' && (v===null || ['number','boolean','string'].indexOf(typeof v)>=0))brush._rawNormalized[key]=v;});
    brush._rawTipState=util.brushFingerprint({tip:brush.tip});
    brush._rawGrainState=util.brushFingerprint({tip:brush._grainRgba});
    brush._rawBrushState=util.brushFingerprint(brush);
    brush._rawEntries=entries.filter(e=>!e.dir && e.name.startsWith(prefix)).map(e=>({name:e.name.slice(prefix.length),data:e.data()}));
    return brush;
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

  function archiveParams(brush, opts) {
    const D = defaultsApi.defaults();
    const params = Object.assign(D, {
      version: 2,
      plotSpacingVersion: 1,
      // paintSize 是当前大小（×400≈像素），maxSize 是上限；往返尺寸才一致
      paintSize: Math.max(0.0005, Math.min(4, (brush.sizePx || 100) / 400)),
      maxSize: Math.max(0.02, Math.min(16, ((brush.sizePx || 100) / 400) * 1.6)),
      minSize: Math.max(0, Math.min(1, brush.minSizeRatio === undefined ? 0.05 : brush.minSizeRatio)),
      maxOpacity: Math.max(0, Math.min(1, brush.opacity === undefined ? 1 : brush.opacity)),
      minOpacity: 0,
      paintOpacity: 1,
      // Procreate 间距允许 >100%（印章笔样本 121%），不要钳到 100
      plotSpacing: Math.max(0.001, Math.min(10, (brush.spacingPct || 10) / 100)),
      // PS 圆度 0% 是合法值（扁线），不要抬到 5%
      shapeRoundness: Math.max(0, Math.min(1, (brush.roundness === undefined ? 100 : brush.roundness) / 100)),
      shapeAngle: ((brush.angle || 0) * Math.PI / 180),
      shapeScatter: Math.max(0, Math.min(2, (brush.procreateRotationScatterPct === undefined ? (brush.angleJitterDeg || 0) : brush.procreateRotationScatterPct) / 50)),
      // shapeCount 在 Procreate 里是 ×16 的归一化值（0.625 = 10 个）
      shapeCount: Math.max(0, Math.min(1, (brush.scatterCount || 0) / 16)),
      shapeCountJitter: Math.max(0, Math.min(1, (brush.countJitterPct || 0) / 100)),
      plotJitter: Math.max(0, Math.min(10, (brush.scatterOn ? (brush.scatterPct || 0) : 0) / 10)),
      plotSmoothing: Math.max(0, Math.min(1, brush.smoothingStrength === undefined ? 0 : brush.smoothingStrength)),
      grainDepthJitter: Math.max(0, Math.min(1, brush.grainDepthJitter || 0)),
      textureScale: Math.max(0.01, Math.min(20, brush.textureScale === undefined ? 1 : brush.textureScale)),
      textureBrightness: Math.max(0, Math.min(1, (brush.textureBrightness === undefined ? 51 : brush.textureBrightness) / 100)),
      textureContrast: Math.max(0, Math.min(1, (brush.textureContrast === undefined ? 100 : brush.textureContrast) / 100)),
      textureRotation: brush.textureRotation || 0,
      shapeOrientation: 1,
      previewSize: 0.08,
      dynamicsPressureSize: (brush.pressureSize === undefined ? brush.pressure : brush.pressureSize) ? 1 : 0,
      dynamicsPressureOpacity: brush.pressureOpacity ? 1 : 0,
      dynamicsJitterSize: Math.max(0, Math.min(1, (brush.sizeJitterPct || 0) / 100)),
      dynamicsTiltSize: Math.max(0, Math.min(1, brush.tiltSizeDyn === undefined ? Math.max((brush.tiltJitterPct || 0) / 100, brush.dynamicsControlSize === 3 ? 1 - (brush.minSizeRatio === undefined ? 0 : brush.minSizeRatio) : 0) : brush.tiltSizeDyn)),
      dynamicsTiltOpacity: Math.max(0, Math.min(1, brush.tiltOpacityDyn === undefined ? (brush.dynamicsControlOpacity === 3 ? 1 - (brush.minOpacityRatio === undefined ? 0 : brush.minOpacityRatio) : 0) : brush.tiltOpacityDyn)),
      dynamicsTiltAngle: Math.max(0, Math.min(1, Math.max(brush.tiltAngleDyn || 0, brush.dynamicsControlAngle === 3 ? (brush.angleJitterDeg || 0) / 180 : 0))),
      dynamicsTiltShapeRoundness: Math.max(0, Math.min(1, Math.max(brush.tiltRoundnessDyn || 0, brush.dynamicsControlRoundness === 3 ? (brush.roundnessJitterPct || 0) / 100 : 0))),
      dynamicsSpeedSize: Math.max(0, Math.min(1, brush.speedSizeDyn || 0)),
      dynamicsSpeedOpacity: Math.max(0, Math.min(1, brush.speedOpacityDyn || 0)),
      minOpacity: brush.minOpacityRatio === undefined ? 0 : Math.max(0, Math.min(1, brush.minOpacityRatio)),
      grainDepth: brush.hasTexture ? Math.max(0, Math.min(1, brush.textureDepth === undefined ? (brush.grainStrength === undefined ? 0.6 : brush.grainStrength) : brush.textureDepth)) : 0,
      grainBlendMode: brush.grainBlendMode === undefined ? (brush.hasTexture ? 0 : 1) : brush.grainBlendMode,
      textureInverted: !!brush.textureInverted,
      taperSize: brush.taperOn ? Math.max(0, Math.min(1, brush.taperSize === undefined ? 0.5 : brush.taperSize)) : 0,
      taperOpacity: brush.taperOn ? Math.max(0, Math.min(1, brush.taperOpacity === undefined ? 0.5 : brush.taperOpacity)) : 0,
      taperStartLength: brush.taperOn ? Math.max(0, Math.min(1, brush.taperStartLength === undefined ? 0.2 : brush.taperStartLength)) : 0,
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
          const map = { nrml: 0, normal: 0, drkn: 1, darken: 1, mltp: 2, multiply: 2,
            cbrn: 3, colorburn: 3, linearburn: 4, lghn: 5, lighten: 5, scrn: 6, screen: 6,
            hmix: 7, hardmix: 7, ovrl: 8, overlay: 8, sftl: 9, softlight: 9,
            hrdl: 10, hardlight: 10, dfrn: 11, difference: 11 };
        return map[nm] || 0;
      })(),
      importedFromABR: brush.source === 'abr',
      name: brush.name || 'brush'
    });
    return params;
  }
  function buildArchive(brush, opts) {
    return bplist.writeKeyedArchive(archiveParams(brush,opts), 'SilicaBrush', ['SilicaBrush', 'ValkyrieBrush', 'NSObject']);
  }

  function unchanged(brush,opts) {
    opts=opts||{};
    return opts.fidelity!==false && !opts.forceRebuild && !!brush._rawArchive &&
      brush._rawBrushState===util.brushFingerprint(brush) &&
      brush._rawGrainState===util.brushFingerprint({tip:brush._grainRgba});
  }

  function patchArchive(brush,opts) {
    const before=brush._rawNormalized||{},params=archiveParams(brush,opts),changes={};
    const mapping={sizePx:['paintSize'],spacingPct:['plotSpacing'],name:['name'],opacity:['maxOpacity','paintOpacity'],
      minSizeRatio:['minSize'],minOpacityRatio:['minOpacity'],angle:['shapeAngle'],roundness:['shapeRoundness'],
      pressure:['dynamicsPressureSize'],pressureSize:['dynamicsPressureSize'],pressureOpacity:['dynamicsPressureOpacity'],
      scatterOn:['shapeScatter','shapeCount'],scatterPct:['shapeScatter'],scatterCount:['shapeCount'],
      countJitterPct:['shapeCountJitter'],spacingJitterPct:['plotJitter'],smoothingStrength:['plotSmoothing'],
      sizeJitterPct:['dynamicsJitterSize'],tiltSizeDyn:['dynamicsTiltSize'],tiltOpacityDyn:['dynamicsTiltOpacity'],
      tiltAngleDyn:['dynamicsTiltAngle'],tiltRoundnessDyn:['dynamicsTiltShapeRoundness'],speedSizeDyn:['dynamicsSpeedSize'],
      speedOpacityDyn:['dynamicsSpeedOpacity'],hasTexture:['grainDepth'],textureDepth:['grainDepth'],textureScale:['textureScale'],
      textureBrightness:['textureBrightness'],textureContrast:['textureContrast'],textureRotation:['textureRotation'],
      textureInverted:['textureInverted'],grainBlendMode:['grainBlendMode'],dualBlendMode:['dualBlendMode'],
      taperOn:['taperSize','taperOpacity','taperStartLength','taperEndLength'],taperSize:['taperSize'],taperOpacity:['taperOpacity'],
      wetEdgesOn:['wetEdgesAmount'],wetEdgesAmount:['wetEdgesAmount'],smudgeOn:['smudgeSize','smudgeOpacity'],
      smudgeAmount:['smudgeSize','smudgeOpacity'],colorJitterHue:['dynamicsJitterHue'],colorJitterSat:['dynamicsJitterSaturation'],
      colorJitterVal:['dynamicsJitterLightness']};
    Object.keys(mapping).forEach(function(key){if(brush[key]!==before[key])mapping[key].forEach(k=>{changes[k]=params[k];});});
    if(changes.paintSize!==undefined){const old=plist.unarchive(brush._rawArchive);if(old.maxSize<changes.paintSize)changes.maxSize=changes.paintSize;}
    return bplist.patchKeyedArchive(brush._rawArchive,changes);
  }

  function convGrainNoise(w, h, seed, scale) {
    if (isNode) return require('./convert.js').grainNoise(w, h, seed, scale);
    return root.BC.convert.grainNoise(w, h, seed, scale);
  }

  function secondaryBrush(brush) {
    const sub = brush.dualSubBrush || {};
    const info = brush.dualBrush || {};
    return Object.assign({}, info, sub, {
      name: info.name || sub.name || (brush.name + ' 2'),
      tip: brush.dualTip,
      sizePx: info.diameter === undefined ? (sub.sizePx || brush.sizePx || 100) : info.diameter,
      spacingPct: info.spacing === undefined ? (sub.spacingPct === undefined ? 25 : sub.spacingPct) : info.spacing,
      scatterOn: info.useScatter === undefined ? !!(sub.scatterOn || info.scatterOn) : !!info.useScatter,
      scatterCount: info.count === undefined ? (sub.scatterCount || info.scatterCount || 1) : info.count,
      scatterBothAxes: info.bothAxes === undefined ? !!(sub.scatterBothAxes || info.scatterBothAxes) : !!info.bothAxes,
      scatterPct: info.scatterPct === undefined ? sub.scatterPct : info.scatterPct,
      dualOn: false, dualTip: undefined, dualSubBrush: undefined,
      _rawArchive: sub._rawArchive || brush._rawSubArchive,
      _rawShape: sub._rawShape || brush._rawSubShape,
      _rawGrain: sub._rawGrain || brush._rawSubGrain
    });
  }

  function writeBrush(brush, opts) {
    opts = opts || {};
    function subBrush(){const b=secondaryBrush(brush);
      if(opts.spacingOverride>0)b.spacingPct=opts.spacingOverride;
      if(opts.pressure!==undefined){b.pressureSize=!!opts.pressure;b.pressureOpacity=opts.pressure===false?false:!!b.pressureOpacity;b.pressure=b.pressureSize||b.pressureOpacity;}
      return b;}
    // 还原优先：源就是 Procreate 且没有改过参数时，原样复用 archive/Shape/Grain
    if (opts.fidelity !== false && brush._rawArchive && !opts.forceRebuild) {
      const entries = (brush._rawEntries||[]).filter(e=>!['Brush.archive','Shape.png','Grain.png','QuickLook/Thumbnail.png'].includes(e.name)&&!e.name.startsWith('Sub01/'));
      entries.push({name:'Brush.archive',data:patchArchive(brush,opts)});
      const sameTip=brush._rawTipState===util.brushFingerprint({tip:brush.tip});
      if(sameTip && brush._rawShape)entries.push({name:'Shape.png',data:new Uint8Array(brush._rawShape)});
      else if(!sameTip && brush.tip)entries.push({name:'Shape.png',data:shapePng(tipRGBA(brush,opts),opts.maxTipSize||512).png});
      const sameGrain=brush._rawGrainState===util.brushFingerprint({tip:brush._grainRgba});
      if(sameGrain && brush._rawGrain)entries.push({name:'Grain.png',data:new Uint8Array(brush._rawGrain)});
      else if(brush.hasTexture)entries.push({name:'Grain.png',data:grainPng(brush)});
      if(brush.dualOn && brush.dualTip)zip.read(writeBrush(subBrush(),opts)).forEach(e=>entries.push({name:'Sub01/'+e.name,data:e.data()}));
      let tipRaw = brush.tip ? tipRGBA(brush,opts) : null;
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
      zip.read(writeBrush(subBrush(), opts)).forEach(function (e) {
        entries.push({ name: 'Sub01/' + e.name, data: e.data() });
      });
    }
    return zip.write(entries);
  }

  function writeBrushset(brushList, opts) {
    opts = opts || {};
    const files = [];
    brushList.forEach(function (brush, i) {
      const uuid = proUuid();
      const folder = uuid + '/';
      zip.read(writeBrush(brush, opts)).forEach(function (e) {
        files.push({ name: folder + e.name, data: e.data() });
      });
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

  const api = { isProcreate, parse, writeBrush, writeBrushset, buildArchive, shapePng, thumbPng, unchanged };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { procreate: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
