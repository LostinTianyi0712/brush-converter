/* Procreate .brush / .brushset parser -> normalized brushes */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const zip = isNode ? require('./zip.js') : root.BC.zip;
  const png = isNode ? require('./png.js') : root.BC.png;
  const jpeg = isNode ? require('./jpeg.js') : root.BC.jpeg;
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

  // BRU values without a native Procreate control travel in a namespaced
  // scalar for reimport into the converter, leaving native switches intact.
  function readBruPressure(params) {
    const raw = params.brushConvBruPressure;
    if (typeof raw !== 'string' || raw.length > 512) return null;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data.legacyMinWidth !== 'boolean') return null;
      if (![data.minOpacity, data.nativeMinOpacity, data.flow, data.minFlow].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) return null;
      if (data.smallFlow !== undefined && (!Number.isFinite(data.smallFlow) || data.smallFlow < 0 || data.smallFlow > 1)) return null;
      const nativeMinOpacity = Number.isFinite(params.minOpacity) ? Math.max(0, Math.min(1, params.minOpacity)) : data.nativeMinOpacity;
      // Only a change to the native minimum replaces the original BRU
      // minimum. The maximum and the pressure switch are independent.
      const minOpacity = nativeMinOpacity === data.nativeMinOpacity ? data.minOpacity : nativeMinOpacity;
      return { legacyMinWidth: data.legacyMinWidth, minOpacity, flow: data.flow,
        minFlow: data.minFlow, smallFlow: data.smallFlow, nativeMinOpacity };
    } catch (e) { return null; }
  }

  // 5.3.8 (50521) native lerpAndClampSize + particleQuad: radius is
  // 128 * lerp(min,max,slider); the nominal tip side/diameter is 2 * radius.
  // Default shape rotation cancels the quad's pi/4 basis. AA padding is not size.
  function nativeSizeRange(params) {
    const limit = 1 + 15 * Math.max(0, Math.min(1, toRatio(params.plotSpacing, 0) / 0.02));
    return {
      low: Math.max(0, Math.min(limit, toRatio(params.minSize, 0.05))),
      high: Math.max(0, Math.min(limit, toRatio(params.maxSize, 1))),
      slider: Math.max(0, toRatio(params.paintSize, 0.25))
    };
  }
  function nativeSizeDiameter(range, factor) {
    const radius = Math.min(range.high * 128, Math.max(range.low,
      128 * (range.low + (range.high - range.low) * range.slider * factor)));
    return Math.max(0, radius * 2);
  }
  function sizeArchiveParams(brush) {
    const spacing = Math.max(0, Math.min(10, (brush.spacingPct === undefined ? 10 : brush.spacingPct) / 100));
    const limit = 1 + 15 * Math.min(1, spacing / 0.02);
    const size = typeof brush.sizePx === 'number' && isFinite(brush.sizePx) && brush.sizePx > 0 ? brush.sizePx : 100;
    const high = Math.min(limit, Math.max(0.2, size) / 256);
    const pressure = brush.pressureSize === undefined ? brush.pressure : brush.pressureSize;
    const ratio = Math.max(0, Math.min(1, brush.minSizeRatio === undefined ? 0.05 : brush.minSizeRatio));
    return {paintSize: 1, maxSize: high, minSize: pressure ? high * ratio : 0};
  }
  function roundnessArchiveParam(brush, range) {
    const span = (range.high - range.low) * range.slider;
    if (!(span > 0)) return 1;
    const ratio = Math.max(0, Math.min(1, (brush.roundness === undefined ? 100 : brush.roundness) / 100));
    return Math.max(0, Math.min(1, (ratio * nativeSizeDiameter(range, 1) / 256 - range.low) / span));
  }
  function rotationArchiveParam(brush) {
    const before = brush._rawNormalized;
    const aliasEdited = before && brush.procreateRotationScatterPct !== before.procreateRotationScatterPct && brush.angleJitterDeg === before.angleJitterDeg;
    const raw = aliasEdited || brush.angleJitterDeg === undefined
      ? (brush.procreateRotationScatterPct || 0) / 50
      : brush.angleJitterDeg / (brush.source === 'abr' ? 100 : 180);
    return Math.max(0, Math.min(2, raw));
  }
  // Brush options call ValkyrieDocument.angleFromOrientation:, not UIKit's
  // same-named helpers: 1/2/3/4 -> 0/180/90/-90 degrees (5.3.8 native code).
  function orientationDegrees(params) {
    return ({2:180,3:90,4:-90})[params.shapeOrientation] || 0;
  }
  function directionArchiveParams(brush) {
    const before=brush._rawNormalized;
    const modeEdited=before && brush.bruRotationMode!==before.bruRotationMode;
    const controlEdited=before && brush.dynamicsControlAngle!==before.dynamicsControlAngle;
    if (!modeEdited && !controlEdited && brush.source==='procreate' && brush._params) {
      return {shapeRotation:toRatio(brush._params.shapeRotation,0),shapeAzimuth:!!brush._params.shapeAzimuth};
    }
    const follows=modeEdited ? brush.bruRotationMode===1 : controlEdited ? brush.dynamicsControlAngle===6
      : brush.bruRotationMode===1 || brush.dynamicsControlAngle===6;
    return {shapeRotation:follows?1:0,shapeAzimuth:false};
  }

  function luminanceToTip(im, inverted) {
    // Procreate shape: white = opaque, black = transparent (luminance as coverage)
    // shapeInverted（笔刷工作室 → 形状 → 反转）翻转明暗，透明底仍保持透明
    const w = im.width, h = im.height;
    const rgba = new Uint8Array(w * h * 4);
    const src = im.rgba;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      let l = Math.max(src[o], src[o + 1], src[o + 2]);
      if (inverted) l = 255 - l;
      const a = src[o + 3] === 255 ? l : Math.round((l * src[o + 3]) / 255);
      rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255; rgba[o + 3] = a;
    }
    return { w, h, rgba };
  }

  function decodeShape(entry, inverted) {
    if (!entry) return null;
    try {
      const im = png.decode(entry.data());
      return luminanceToTip(im, !!inverted);
    } catch (e) { return null; }
  }

  /* 从内置图库里按文件名找一张图（Shape 或 Grain 共用）：支持 .png/.jpg 同 stem、
     预先解码的 rgba（浏览器 canvas 解 progressive JPEG 后传入）与原始字节两种。 */
  function lookupLibraryImage(bundledPath, shapeResources) {
    if (!bundledPath || !shapeResources) return null;
    const base = String(bundledPath).split(/[\\/]/).pop().toLowerCase();
    const stem = base.replace(/\.[a-z0-9]+$/i, '');
    const keys = [base, stem + '.png', stem + '.jpg', stem + '.jpeg', stem];
    if (shapeResources.keys) {
      for (const k of shapeResources.keys()) {
        if (String(k).toLowerCase().replace(/\.[a-z0-9]+$/i, '') === stem) keys.push(k);
      }
    }
    const seen = new Set();
    for (const k of keys) {
      if (seen.has(k)) continue;
      seen.add(k);
      const lib = shapeResources.get ? shapeResources.get(k) : shapeResources[k];
      if (!lib) continue;
      try {
        if (lib.rgba && lib.w && lib.h && lib.rgba.length >= lib.w * lib.h * 4) {
          return { w: lib.w, h: lib.h, rgba: lib.rgba };
        }
        const bytes = lib.data ? lib.data() : lib;
        if (!bytes || !bytes.length) continue;
        const im = jpeg && jpeg.isJpeg(bytes) ? jpeg.decode(bytes) : png.decode(bytes);
        return { w: im.width, h: im.height, rgba: im.rgba };
      } catch (e) { /* 这张解不开就换下一个候选 */ }
    }
    return null;
  }

  function readBrushFolder(entries, prefix, shapeResources, entryByName, folderEntries, initialPixelHashes) {
    // Only share fingerprints while initializing this brush and its sub-brush.
    // Export must hash again to detect in-place pixel edits.
    initialPixelHashes = initialPixelHashes || new WeakMap();
    // prefix like 'UUID/' ('' for single-file .brush)
    // brushset 解析时传入一次性索引，避免每支笔刷都扫描整个 ZIP。
    const pool = folderEntries || entries;
    const find = suffix => entryByName ? entryByName.get(prefix + suffix) : entries.find(e => e.name === prefix + suffix);
    const arcEntry = find('Brush.archive');
    if (!arcEntry) return null;
    let params = {};
    try { params = plist.unarchive(arcEntry.data()) || {}; } catch (e) { params = {}; }
    let name = typeof params.name === 'string' ? params.name.trim() : '';
    if (!name || name === '$null') name = '';
    let subArcEntry = null, subShapeEntry = null;
    const subArcCandidates = pool.filter(function (e) {
      return e.name.indexOf(prefix) === 0 && /^Sub\d+\/Brush\.archive$/.test(e.name.slice(prefix.length));
    });
    if (subArcCandidates.length) {
      const subPrefix = subArcCandidates[0].name.replace(/Brush\.archive$/, '');
      subArcEntry = subArcCandidates[0];
      subShapeEntry = (entryByName ? entryByName.get(subPrefix + 'Shape.png') : pool.find(function (e) { return e.name === subPrefix + 'Shape.png'; })) || null;
    }
    let shapeEntry = find('Shape.png');
    const bundledShapePath = typeof params.bundledShapePath === 'string' && params.bundledShapePath !== '$null' ? params.bundledShapePath : '';
    let resolvedShapePath = '';
    let shapeFromLibrary = false;
    const shapeInverted = params.shapeInverted === true;
    let tipFromShape = decodeShape(shapeEntry, shapeInverted);
    if (!tipFromShape && bundledShapePath && !/(^|[\\/])(?:\.\.|QuickLook|Signature)([\\/]|$)|(^|[\\/])Grain\.png$/i.test(bundledShapePath)) {
      // Resolve only an explicit source reference, never a thumbnail or Grain.
      const resource = find(bundledShapePath) || (entryByName ? entryByName.get(bundledShapePath) : entries.find(e=>e.name===bundledShapePath));
      if (resource) {
        try {
          const bytes=resource.data();
          const im=jpeg && jpeg.isJpeg(bytes) ? jpeg.decode(bytes) : png.decode(bytes);
          const raw=(jpeg && jpeg.isJpeg(bytes)) || im.width > 2048 || im.height > 2048 ? sourceShapePng(im.width,im.height,im.rgba) : bytes;
          shapeEntry={name:prefix+'Shape.png',data:()=>raw};
          tipFromShape=decodeShape(shapeEntry,shapeInverted);
          resolvedShapePath=bundledShapePath;
        } catch(e) { /* retain the unresolved reference; no substitute image */ }
      }
      // 用户自带的内置笔尖图库（Procreate App 内置资源，导出笔刷包时不会被打包）
      if (!tipFromShape && shapeResources) {
        const image = lookupLibraryImage(bundledShapePath, shapeResources);
        if (image) {
          const raw = sourceShapePng(image.w, image.h, image.rgba);
          shapeEntry = { name: prefix + 'Shape.png', data: () => raw };
          tipFromShape = decodeShape(shapeEntry, shapeInverted);
          resolvedShapePath = bundledShapePath;
          shapeFromLibrary = true;
        }
      }
    }
    const grainEntry = find('Grain.png');
    // Grain is an independent texture, never a substitute for a bundled Shape.
    const tipFromGrain = null;
    const tip = tipFromShape || tipFromGrain;
    /* Procreate 自带纹理（bundledGrainPath）：导出 brushset 时不会打包，只留文件名
       （如 Brush-Artery-Willow-Grain.jpg / European-Paper.jpg）。以前只解析 Shape 的
       内置图引用，漏了 Grain，导致这类笔刷转出来全是实心笔画（用户截图「左实心、右有颗粒」）。 */
    const bundledGrainPath = typeof params.bundledGrainPath === 'string' && params.bundledGrainPath !== '$null' ? params.bundledGrainPath : '';
    let grainFromLibrary = false;
    let grainRgba = null;
    if (grainEntry) {
      try {
        const im = png.decode(grainEntry.data());
        grainRgba = { w: im.width, h: im.height, rgba: im.rgba };
      } catch (e) { grainRgba = null; }
    }
    if (!grainRgba && bundledGrainPath && shapeResources) {
      const fromLib = lookupLibraryImage(bundledGrainPath, shapeResources);
      if (fromLib) { grainRgba = fromLib; grainFromLibrary = true; }
    }
    const tipSource = tipFromShape ? (shapeFromLibrary ? 'library' : 'shape') : (tipFromGrain ? 'grain' : 'none');
    const sizeRange = nativeSizeRange(params);
    const pressSize = toRatio(params.dynamicsPressureSize, 0);
    const pressOpacity = toRatio(params.dynamicsPressureOpacity, 0);
    const maxOpacity = toRatio(params.maxOpacity, 1);
    const paintOpacity = toRatio(params.paintOpacity, 1);
    const minOpacity = toRatio(params.minOpacity, 0);
    const spacing = toRatio(params.plotSpacing, 0);
    const fullSize = nativeSizeDiameter(sizeRange, 1);
    const sizePx = Math.max(0.2, Math.min(4096, Math.round(fullSize)));
    // Native scaledOpacity interpolates BOTH bounds, then clamps to 1%..100%.
    // This is the nominal alpha parameter, not the renderer's final pixel alpha.
    const opacity = Math.max(0.01, Math.min(1, minOpacity + (maxOpacity - minOpacity) * paintOpacity));
    const minSizeRatio = pressSize > 0.05 && fullSize > 0 ? Math.max(0, Math.min(1,
      nativeSizeDiameter(sizeRange, 1 - Math.min(1, pressSize)) / fullSize)) : 1;
    const minOpacityRatio = pressOpacity > 0.05 ? Math.max(0, Math.min(1, minOpacity / opacity)) : 1;
    const nv = function (k, d) { const raw = params[k]; if (raw === null || raw === undefined || raw === '') return d === undefined ? 0 : d; const v = Number(raw); return isFinite(v) ? v : (d === undefined ? 0 : d); };
    // Procreate 的 shapeAngle 存的是弧度（真实样本 -1.5708 = -90°）
    const angleDeg = nv('shapeAngle') * 180 / Math.PI + orientationDegrees(params);
    // Native image rotation is shapeRotation * tangent. Stylus azimuth
    // suppresses the tangent input, so it must never enable direction mode.
    const followsDirection = !params.shapeAzimuth && Math.abs(nv('shapeRotation') - 1) < 0.000001;
    const roundnessPct = fullSize > 0 ? Math.max(0, Math.min(100,
      nativeSizeDiameter(sizeRange, Math.max(0, Math.min(1, nv('shapeRoundness', 1)))) / fullSize * 100)) : 100;
    const taperOn = nv('taperSize') > 0.001 || nv('taperOpacity') > 0.001;
    const taperSizeV = nv('taperSize'), taperOpacityV = nv('taperOpacity');
    const taperStartLen = nv('taperStartLength'), taperEndLen = nv('taperEndLength');
    const wetAmount = nv('wetEdgesAmount');
    const smudgeSizeV = nv('smudgeSize'), smudgeOpacityV = nv('smudgeOpacity');
    // Paint/Smudge/Erase are separate tools. Their remembered size/opacity
    // does not select the Smudge tool or make this a pure smudging brush.
    const smudgeOnV = false;
    const smudgeAmount = 0;
    const wetAccum = nv('dynamicsWetAccumulation');
    const grainDepthV = nv('grainDepth', 0);
    const grainDepthJitter = nv('grainDepthJitter');
    const grainDepthMin = nv('grainDepthMinimum');
    const texScaleV = nv('textureScale', 1);
    const texBrightV = nv('textureBrightness', 0.51);
    const texContrastV = nv('textureContrast', 1);
    const plotJitterV = nv('plotJitter');
    const smoothingV = nv('plotSmoothing');
    const hueDyn = Math.max(nv('dynamicsPressureHue'), nv('dynamicsJitterHue'), nv('dynamicsJitterStrokeHue'));
    const satDyn = Math.max(nv('dynamicsPressureSaturation'), nv('dynamicsJitterSaturation'), nv('dynamicsJitterStrokeSaturation'));
    const briDyn = Math.max(nv('dynamicsPressureBrightness'), nv('dynamicsJitterLightness'), nv('dynamicsJitterStrokeLightness'));
    const fgBgDyn = Math.max(nv('jitterSecondary'), nv('jitterStrokeSecondary'));
    const hasPerTipColor = nv('dynamicsJitterHue') > 0.001 || nv('dynamicsJitterSaturation') > 0.001 || nv('dynamicsJitterLightness') > 0.001 || nv('jitterSecondary') > 0.001;
    const hasStrokeColor = nv('dynamicsJitterStrokeHue') > 0.001 || nv('dynamicsJitterStrokeSaturation') > 0.001 || nv('dynamicsJitterStrokeLightness') > 0.001 || nv('jitterStrokeSecondary') > 0.001;
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
        subBrush = readBrushFolder(entries, subArcEntry.name.slice(0, -'Brush.archive'.length), shapeResources, null, null, initialPixelHashes);
        dualOn = true;
        dualSubName = typeof subParams.name === 'string' ? subParams.name : '';
        dualBlendNum = Number(params.dualBlendMode) || 0;
        if (subBrush) dualTip = subBrush.tip;
        if (!dualTip && subShapeEntry) dualTip = decodeShape(subShapeEntry, subParams.shapeInverted === true);
        if (!dualTip) dualTip = roundTip(96);
        brushSubRaw = { archive: subArcEntry.data(), shape: subShapeEntry ? subShapeEntry.data() : null };
      } catch (e) { /* ignore */ }
    }
    // plotJitter 内部刻度约 0–10（样本最高 7.02 = 约 70%），换算成百分比
    const scatterPct = Math.max(0, Math.min(1000, plotJitterRaw * 10));
    const rotationScatterPct = Math.max(0, Math.min(100, shapeScatterRaw * 50));
    // Native options count = trunc(float32(raw * 15)); plotting adds one stamp.
    const scatterCount = Math.max(1, Math.min(16, Math.floor(Math.fround(Math.fround(shapeCountRaw) * 15)) + 1));
    const brush = {
      name,
      tip,
      tipSource,
      bundledShapePath,
      bundledGrainPath,
      grainFromLibrary,
      shapeFromLibrary,
      resolvedShapePath,
      _rawArchive: arcEntry.data(),
      _rawShape: shapeEntry ? shapeEntry.data() : null,
      _rawGrain: grainEntry ? grainEntry.data() : null,
      _grainRgba: grainRgba,
      sizePx,
      maxSizePx: Math.max(sizePx, Math.round(sizeRange.high * 256)),
      spacingPct: Math.max(0, Math.min(1000, spacing * 100)),
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
      hasGrain: !!(grainEntry || grainFromLibrary),
      hardness: tip ? undefined : 0.8,
      hasTexture: !!(grainEntry || grainFromLibrary) && grainDepthV > 0,
      angle: angleDeg,
      dynamicsControlAngle: followsDirection ? 6 : undefined,
      bruRotationMode: followsDirection ? 1 : 0,
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
      procreateSmudgeAccumulation: nv('dynamicsSmudgeAccumulation', 0.5),
      smudgeAmount: smudgeAmount,
      textureDepth: Math.max(0, Math.min(1, grainDepthV)),
      grainDepthMinimum: grainDepthMin,
      grainDepthJitter: grainDepthJitter,
      textureScale: texScaleV > 0 ? texScaleV : 1,
      textureBrightness: texBrightV * 100,
      textureContrast: texContrastV * 100,
      spacingJitterPct: Math.max(0, Math.min(100, nv('plotSpacingJitter') * 100)),
      falloffPct: Math.max(0, Math.min(100, nv('dynamicsFalloff') * 100)),
      smoothingStrength: smoothingV,
      colorDynamicsOn: hueDyn > 0.001 || satDyn > 0.001 || briDyn > 0.001 || fgBgDyn > 0.001,
      colorJitterFgBg: fgBgDyn,
      colorPerTip: hasStrokeColor && !hasPerTipColor ? false : (hasPerTipColor ? true : undefined),
      colorJitterHue: hueDyn,
      colorJitterSat: satDyn,
      colorJitterVal: briDyn,
      sizeJitterPct: sizeJitV * 100,
      opacityJitterPct: Math.max(0, Math.min(100, nv('dynamicsJitterOpacity') * 100)),
      roundnessJitterPct: Math.max(0, Math.min(100, nv('jitterShapeRoundness') * 100)),
      minRoundnessRatio: Math.max(0, Math.min(1, nv('dynamicsPressureShapeRoundnessMinimum', 0.25))),
      roundnessDynamics: pressureRound,
      flipXJitter: !!params.shapeFlipXJitter,
      flipYJitter: !!params.shapeFlipYJitter,
      wetEdgesAccumulation: wetAccum,
      burntEdgesAmount: nv('burntEdgesAmount'),
      grainBlendMode: params.grainBlendMode,
      textureRotation: nv('textureRotation'),
      textureInverted: !!params.textureInverted,
      // 源笔刷的「反转」已烘焙进 tip 像素（见 luminanceToTip），跨格式输出直接用它
      shapeInverted: shapeInverted || undefined,
      dynamicsLoad: nv('dynamicsLoad'),
      dynamicsGlazedFlow: nv('dynamicsGlazedFlow'),
      dynamicsMix: nv('dynamicsMix'),
      dynamicsMixSoftening: nv('dynamicsMixSoftening'),
      dynamicsJitterDarkness: nv('dynamicsJitterDarkness'),
      dynamicsJitterStrokeHue: nv('dynamicsJitterStrokeHue'),
      dynamicsJitterStrokeSaturation: nv('dynamicsJitterStrokeSaturation'),
      dynamicsJitterStrokeLightness: nv('dynamicsJitterStrokeLightness'),
      dynamicsJitterStrokeDarkness: nv('dynamicsJitterStrokeDarkness'),
      jitterSecondary: nv('jitterSecondary'),
      jitterStrokeSecondary: nv('jitterStrokeSecondary'),
      blendMode: params.blendMode,
      _params: params,
      _bruPressure: readBruPressure(params),
      scatterOn: scatterPct > 0.01 || scatterCount > 1,
      angleJitterDeg: Math.max(0, Math.min(360, shapeScatterRaw * 180)),
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
    brush._rawTipState=util.brushFingerprint({tip:brush.tip}, initialPixelHashes);
    brush._rawDualTipState=util.brushFingerprint({tip:brush.dualTip}, initialPixelHashes);
    brush._rawGrainState=util.brushFingerprint({tip:brush._grainRgba}, initialPixelHashes);
    brush._rawBrushState=util.brushFingerprint(brush, initialPixelHashes);
    brush._rawEntries=pool.filter(e=>!e.dir && e.name.startsWith(prefix)).map(e=>({name:e.name.slice(prefix.length),data:e.data()}));
    return brush;
  }

  function xmlUnescape(s) {
    return String(s || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }

  function xmlEscape(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function parseBrushsetPlist(bytes) {
    if (!bytes || !bytes.length) return null;
    try {
      if (plist.isBinaryPlist(bytes)) {
        const obj = plist.parse(bytes);
        if (obj && typeof obj === 'object') {
          return {
            name: typeof obj.name === 'string' ? obj.name : '',
            brushes: Array.isArray(obj.brushes) ? obj.brushes.filter(x => typeof x === 'string') : []
          };
        }
      }
    } catch (e) { /* try XML plist below */ }
    try {
      const txt = util.utf8Decode(bytes);
      if (txt.indexOf('<plist') < 0) return null;
      const nameMatch = /<key>\s*name\s*<\/key>\s*<string>([\s\S]*?)<\/string>/i.exec(txt);
      const arrMatch = /<key>\s*brushes\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i.exec(txt);
      const list = [];
      if (arrMatch) {
        const re = /<string>([\s\S]*?)<\/string>/gi;
        let m;
        while ((m = re.exec(arrMatch[1])) !== null) {
          const id = xmlUnescape(m[1]).trim();
          if (id) list.push(id);
        }
      }
      return { name: nameMatch ? xmlUnescape(nameMatch[1]).trim() : '', brushes: list };
    } catch (e) { return null; }
  }

  function buildBrushsetPlist(name, uuids) {
    const safeName = xmlEscape(name || 'Procreate Brushes');
    const items = (uuids || []).map(u => '\t\t<string>' + xmlEscape(u) + '</string>').join('\n');
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0">\n<dict>\n\t<key>brushes</key>\n\t<array>\n' +
      (items ? items + '\n' : '') +
      '\t</array>\n\t<key>name</key>\n\t<string>' + safeName + '</string>\n</dict>\n</plist>\n';
    return util.utf8Encode(xml);
  }

  function* parseSteps(bytes, fileName, opts) {
    opts = opts || {};
    yield 0;
    if (!zip.isZip(bytes)) throw new Error('不是 Procreate 笔刷文件（ZIP 容器）');
    const entries = zip.read(bytes);
    const brushes = [];
    const warnings = [];
    const baseName = (fileName || 'brush').replace(/\.(brush|brushset)$/i, '');
    const entryByName = new Map();
    for (const e of entries) {
      // 与 Array.find 一样保留首个同名条目，避免重名 ZIP 的行为变化。
      if (!entryByName.has(e.name)) entryByName.set(e.name, e);
    }

    // single .brush: Brush.archive at root
    if (entryByName.has('Brush.archive')) {
      const b = readBrushFolder(entries, '', opts.shapeResources, entryByName, entries);
      if (b) {
        if (!b.name) b.name = baseName;
        if (!b.tip) warnings.push(b.bundledShapePath ? '缺少内置笔尖原图 '+b.bundledShapePath+'；Procreate原生导出保留引用，跨软件圆头仅为近似' : '该笔刷没有可解码Shape图；跨软件只能生成近似圆头，原笔尖未确认');
        brushes.push(b);
      }
      return { brushes, warnings, kind: 'brush' };
    }

    // .brushset: top-level folders (ordered by brushset.plist when present)
    const discoveredFolders = new Set();
    const entriesByFolder = new Map();
    for (const e of entries) {
      const m = /^([^/]+)\//.exec(e.name);
      if (m && !m[1].startsWith('.')) {
        discoveredFolders.add(m[1]);
        if (!entriesByFolder.has(m[1])) entriesByFolder.set(m[1], []);
        entriesByFolder.get(m[1]).push(e);
      }
    }
    const plistEntry = entryByName.get('brushset.plist');
    const plistInfo = plistEntry ? parseBrushsetPlist(plistEntry.data()) : null;
    const orderedFolders = [];
    const seenFolders = new Set();
    if (plistInfo && Array.isArray(plistInfo.brushes)) {
      for (const id of plistInfo.brushes) {
        if (discoveredFolders.has(id) && !seenFolders.has(id)) {
          orderedFolders.push(id);
          seenFolders.add(id);
        }
      }
    }
    for (const f of discoveredFolders) {
      if (!seenFolders.has(f)) {
        orderedFolders.push(f);
        seenFolders.add(f);
      }
    }
    const setName = (plistInfo && plistInfo.name) ? plistInfo.name : baseName;
    let autoIndex = 0;
    for (const folder of orderedFolders) {
      autoIndex++;
      const prefix = folder + '/';
      try {
        const b = readBrushFolder(entries, prefix, opts.shapeResources, entryByName, entriesByFolder.get(folder));
        if (b) {
          if (!b.name) b.name = /^[0-9A-Fa-f-]{20,}$/.test(folder) ? (setName + ' ' + autoIndex) : folder;
          // 整包组名：导出 .brushset 时写回 brushset.plist（否则会退回第一支笔刷名）
          b._brushsetName = setName;
          if (!b.tip) warnings.push(b.name + ': ' + (b.bundledShapePath ? '缺少内置笔尖原图 '+b.bundledShapePath+'；Procreate原生导出保留引用，跨软件圆头仅为近似' : '没有可解码Shape图；跨软件圆头仅为近似'));
          brushes.push(b);
        }
      } catch (e) {
        warnings.push('解析失败 ' + folder + ': ' + e.message);
      }
      if (autoIndex < orderedFolders.length) yield autoIndex / orderedFolders.length;
    }
    if (!brushes.length) {
      warnings.push('brushset 中没有可转换的笔刷（可能全部使用默认圆头，或只含参数设置）');
    }
    return { brushes, warnings, kind: 'brushset', name: setName };
  }

  function parse(bytes, fileName, opts) {
    const steps = parseSteps(bytes, fileName, opts);
    const report = opts && opts.onProgress;
    let step = steps.next();
    for (; !step.done; step = steps.next()) {
      if (report) report(step.value, '解析 Procreate 笔刷');
    }
    if (report) report(1, '解析 Procreate 笔刷');
    return step.value;
  }

  async function parseAsync(bytes, fileName, opts) {
    opts = opts || {};
    const report = opts.onProgress;
    const steps = parseSteps(bytes, fileName, opts);
    let deadline = Date.now();
    let step = steps.next();
    for (; !step.done; step = steps.next()) {
      if (report) report(step.value, '解析 Procreate 笔刷');
      if (Date.now() >= deadline) {
        await new Promise(resolve => setTimeout(resolve, 0));
        deadline = Date.now() + 12;
      }
      if (opts.shouldCancel && opts.shouldCancel()) throw new Error('已停止本次导入');
    }
    // Keep the terminal notification after parsing, including for single brushes.
    if (report) report(1, '解析 Procreate 笔刷');
    return step.value;
  }

  /* ================= Procreate writer ================= */

  function synthRoundTip(brush, n) {
    n = n || 256;
    const hard = Math.max(0.05, Math.min(1, brush.hardness === undefined ? 0.75 : brush.hardness));
    // Shape geometry is applied by shapeRoundness/shapeAngle in the archive.
    const round = 1;
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

  // Procreate's flip-jitter flags are random options, not fixed mirrors.
  // Bake a requested fixed mirror into the resource without cropping its canvas.
  function fixedTipFlip(tip, brush) {
    if (!tip || (!brush.flipX && !brush.flipY)) return tip;
    const w=tip.w,h=tip.h,rgba=new Uint8Array(tip.rgba.length);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=((brush.flipY?h-1-y:y)*w+(brush.flipX?w-1-x:x))*4;
      rgba.set(tip.rgba.subarray(i,i+4),(y*w+x)*4);
    }
    return {w,h,rgba};
  }

  function tipRGBA(brush, opts) {
    const tip = brush.tip;
    if (!tip) return synthRoundTip(brush, 256, opts);
    if (tip.rgba) return fixedTipFlip({ w: tip.w, h: tip.h, rgba: tip.rgba }, brush);
    if (tip.data) {
      const w = tip.w, h = tip.h, bpp = tip.bpp || 1;
      const rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const a = bpp === 2 ? tip.data[i * 2] : tip.data[i];
        rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = a;
      }
      return fixedTipFlip({ w, h, rgba }, brush);
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
    const alpha = Math.max(0, Math.min(1, opts.opacity === undefined ? 1 : opts.opacity));
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

  function readPngHeader(bytes) {
    if (!bytes || bytes.length < 29 || !png.isPng(bytes)) return null;
    if (util.ascii(bytes, 12, 4) !== 'IHDR') return null;
    return {
      width: util.u32(bytes, 16),
      height: util.u32(bytes, 20),
      bitDepth: bytes[24],
      colorType: bytes[25]
    };
  }

  // Source lookup must retain its alpha separately from luminance until the
  // archive's inversion is applied. Gray normalization happens in the writer.
  function sourceShapePng(w, h, rgba) {
    const scale=Math.min(1,2048/Math.max(w,h));
    const width=Math.max(1,Math.round(w*scale)),height=Math.max(1,Math.round(h*scale));
    return png.encode(width,height,png.resize(rgba,w,h,width,height));
  }

  function encodeNormalizedGrain(w, h, rgba) {
    // Every texture follows the same square, <=2048px grayscale resource rule.
    const side = Math.max(1, Math.min(2048, Math.max(w, h)));
    const buf = (w === side && h === side) ? rgba : png.resize(rgba, w, h, side, side);
    const gray = new Uint8Array(side * side);
    for (let i = 0; i < side * side; i++) {
      const o = i * 4;
      const lum = Math.round((buf[o] + buf[o + 1] + buf[o + 2]) / 3);
      const a = buf[o + 3];
      gray[i] = a === 255 ? lum : Math.round((lum * a) / 255);
    }
    return png.encodeGray(side, side, gray);
  }

  function normalizeRawGrain(rawBytes) {
    if (!rawBytes || !rawBytes.length) return null;
    const hdr = readPngHeader(rawBytes);
    if (hdr && hdr.width === hdr.height && hdr.width >= 1 && hdr.width <= 2048 && hdr.bitDepth === 8 && hdr.colorType === 0) {
      return new Uint8Array(rawBytes);
    }
    try {
      const im = jpeg && jpeg.isJpeg(rawBytes) ? jpeg.decode(rawBytes) : png.decode(rawBytes);
      return encodeNormalizedGrain(im.width, im.height, im.rgba);
    } catch (e) {
      return new Uint8Array(rawBytes);
    }
  }

  function normalizeRawShape(rawBytes, maxSize, inverted) {
    if (!rawBytes || !rawBytes.length) return null;
    const hdr = readPngHeader(rawBytes);
    if (hdr && hdr.width >= 1 && hdr.height >= 1 && hdr.width <= 2048 && hdr.height <= 2048 && hdr.bitDepth === 8 && hdr.colorType === 0) {
      return { bytes: new Uint8Array(rawBytes), inverted: !!inverted };
    }
    try {
      const im = jpeg && jpeg.isJpeg(rawBytes) ? jpeg.decode(rawBytes) : png.decode(rawBytes);
      return { bytes: shapePng(luminanceToTip(im, inverted), maxSize || 2048).png, inverted: false };
    } catch (e) {
      return { bytes: new Uint8Array(rawBytes), inverted: !!inverted };
    }
  }

  /* Grain.png：优先用源笔刷真实纹理（Procreate Grain / ABR 图案），否则程序化噪声 */
  function grainPng(brush) {
    if (brush._grainRgba && brush._grainRgba.w > 0) {
      const g = brush._grainRgba;
      return encodeNormalizedGrain(g.w, g.h, g.rgba);
    }
    if (brush.grain && brush.grain.w > 0 && brush.grain.h > 0 && brush.grain.rgba && brush.grain.rgba.length === brush.grain.w * brush.grain.h * 4) {
      const g = brush.grain;
      return encodeNormalizedGrain(g.w, g.h, g.rgba);
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
      return encodeNormalizedGrain(w, h, out);
    }
    // A missing source image cannot be reconstructed from a texture flag.
    if (brush._rawGrain) return normalizeRawGrain(brush._rawGrain);
    /* 【第194轮】第四级兜底：走 convert 的 textureGray 收口。
       实测 楠.bru 的 46 支带纹理笔刷里，有 8 支 texAssetId 是 ptN（画世界内置库能解出像素），
       但上面三级都取不到，于是 Grain.png 一个都没写出来（Grain 数 = 0），
       转出的 brushset 在 Procreate 里就等于「无纹理」——用户看到的就是笔尖发糊/发花。
       第187轮已经在 textureGray 里接了内置纹理库，这里没接上，属于漏掉的一环。
       无法还原的更彻底：另 38 支的 texAssetId 是 32 位 UUID（画世界私有材质，不在库里），
       只能由上层给「纹理缺失」警告，不在这里伪造。 */
    try {
      const conv = isNode ? require('./convert.js') : root.BC.convert;
      const t = conv && typeof conv.textureGray === 'function' ? conv.textureGray(brush) : null;
      if (t && t.w > 0 && t.h > 0 && t.gray && t.gray.length === t.w * t.h) {
        const out = new Uint8Array(t.w * t.h * 4);
        for (let i = 0; i < t.gray.length; i++) {
          const v = t.gray[i];
          out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
        }
        return encodeNormalizedGrain(t.w, t.h, out);
      }
    } catch (e) { /* 收口不可用：保持原行为（无 Grain） */ }
    return null;
  }

  // Procreate 的纹理缩放上限；越界时它自己的 UI 也不会给出这种值
  const PROCREATE_TEXTURE_SCALE_MAX = 4;
  const PROCREATE_EPOCH = 978307200; // 2001-01-01T00:00:00Z（NSDate 纪元）

  function archiveParams(brush, opts) {
    const D = defaultsApi.defaults();
    const sizeParams = sizeArchiveParams(brush);
    const directionParams = directionArchiveParams(brush);
    const params = Object.assign(D, {
      version: 2,
      plotSpacingVersion: 1,
      paintSize: sizeParams.paintSize,
      maxSize: sizeParams.maxSize,
      minSize: sizeParams.minSize,
      maxOpacity: Math.max(0, Math.min(1, brush.opacity === undefined ? 1 : brush.opacity)),
      paintOpacity: 1,
      // Procreate 间距允许 >100%（印章笔样本 121%），不要钳到 100
      plotSpacing: Math.max(0, Math.min(10, (brush.spacingPct === undefined ? 10 : brush.spacingPct) / 100)),
      // PS 圆度 0% 是合法值（扁线），不要抬到 5%
      shapeRoundness: roundnessArchiveParam(brush, {low:sizeParams.minSize, high:sizeParams.maxSize, slider:sizeParams.paintSize}),
      shapeAngle: ((brush.angle || 0) * Math.PI / 180),
      shapeRotation: directionParams.shapeRotation,
      shapeAzimuth: directionParams.shapeAzimuth,
      shapeScatter: rotationArchiveParam(brush),
      // Native value represents 0..15 additional stamps, plus the base stamp.
      shapeCount: (Math.max(1, Math.min(16, Math.round(brush.scatterCount || 1))) - 1) / 15,
      shapeCountJitter: Math.max(0, Math.min(1, (brush.countJitterPct || 0) / 100)),
      shapeFlipXJitter: !!brush.flipXJitter,
      shapeFlipYJitter: !!brush.flipYJitter,
      plotJitter: Math.max(0, Math.min(10, (brush.scatterOn ? (brush.scatterPct || 0) : 0) / 10)),
      plotSpacingJitter: Math.max(0, Math.min(1, (brush.spacingJitterPct || 0) / 100)),
      plotSmoothing: Math.max(0, Math.min(1, brush.smoothingStrength === undefined ? 0 : brush.smoothingStrength)),
      dynamicsFalloff: Math.max(0, Math.min(1, (brush.falloffPct || 0) / 100)),
      grainDepthMinimum: Math.max(0, Math.min(1, brush.grainDepthMinimum === undefined ? 0 : brush.grainDepthMinimum)),
      grainDepthJitter: Math.max(0, Math.min(1, brush.grainDepthJitter || 0)),
      // Procreate 自身纹理缩放范围是 0.01..4（IPA 内置 18 支 + 真实导出 1 支，最大值正好 4.000）
      textureScale: Math.max(0.01, Math.min(PROCREATE_TEXTURE_SCALE_MAX, brush.textureScale === undefined ? 1 : brush.textureScale)),
      textureBrightness: Math.max(0, Math.min(1, (brush.textureBrightness === undefined ? 51 : brush.textureBrightness) / 100)),
      textureContrast: Math.max(0, Math.min(1, (brush.textureContrast === undefined ? 100 : brush.textureContrast) / 100)),
      textureRotation: brush.textureRotation || 0,
      // 新建 archive 的 Shape.png 写的是已烘焙像素（含源「反转」），不能再让 Procreate 反相一次
      shapeInverted: false,
      shapeOrientation: 1,
      previewSize: 0.08,
      dynamicsPressureSize: (brush.pressureSize === undefined ? brush.pressure : brush.pressureSize) ? 1 : 0,
      dynamicsPressureOpacity: brush.pressureOpacity ? 1 : 0,
      dynamicsJitterSize: Math.max(0, Math.min(1, (brush.sizeJitterPct || 0) / 100)),
      dynamicsJitterOpacity: Math.max(0, Math.min(1, (brush.opacityJitterPct || 0) / 100)),
      jitterShapeRoundness: Math.max(0, Math.min(1, (brush.roundnessJitterPct || 0) / 100)),
      dynamicsPressureShapeRoundnessMinimum: brush.minRoundnessRatio === undefined ? D.dynamicsPressureShapeRoundnessMinimum : Math.max(0, Math.min(1, brush.minRoundnessRatio)),
      dynamicsTiltSize: Math.max(0, Math.min(1, brush.tiltSizeDyn === undefined ? Math.max((brush.tiltJitterPct || 0) / 100, brush.dynamicsControlSize === 3 ? 1 - (brush.minSizeRatio === undefined ? 0 : brush.minSizeRatio) : 0) : brush.tiltSizeDyn)),
      dynamicsTiltOpacity: Math.max(0, Math.min(1, brush.tiltOpacityDyn === undefined ? (brush.dynamicsControlOpacity === 3 ? 1 - (brush.minOpacityRatio === undefined ? 0 : brush.minOpacityRatio) : 0) : brush.tiltOpacityDyn)),
      dynamicsTiltAngle: Math.max(0, Math.min(1, Math.max(brush.tiltAngleDyn || 0, brush.dynamicsControlAngle === 3 ? (brush.angleJitterDeg || 0) / 180 : 0))),
      dynamicsTiltShapeRoundness: Math.max(0, Math.min(1, Math.max(brush.tiltRoundnessDyn || 0, brush.dynamicsControlRoundness === 3 ? (brush.roundnessJitterPct || 0) / 100 : 0))),
      dynamicsSpeedSize: Math.max(0, Math.min(1, brush.speedSizeDyn || 0)),
      dynamicsSpeedOpacity: Math.max(0, Math.min(1, brush.speedOpacityDyn || 0)),
      minOpacity: brush.pressureOpacity ? (brush.opacity === undefined ? 1 : Math.max(0, Math.min(1, brush.opacity))) * (brush.minOpacityRatio === undefined ? 0 : Math.max(0, Math.min(1, brush.minOpacityRatio))) : 0,
      grainDepth: brush.hasTexture ? Math.max(0, Math.min(1, brush.textureDepth === undefined ? (brush.grainStrength === undefined ? 0.6 : brush.grainStrength) : brush.textureDepth)) : 0,
      /* 【第198轮】画世界纹理层与 PS 纹理都按画布坐标采样，对应 Procreate 的「纹理化」颗粒
         （textureApplication=1；鱼鱼鱼/吹石样本里背景质感、杂色纹理、质感叠加这类全是 1）。
         默认的「移动」(0) 会让网点/方格纹理跟着每个笔尖挪，间距 8% 时相邻笔尖错位叠加，糊成一坨。 */
      textureApplication: brush.hasTexture && (brush.textureCanvasSpace || brush.source === 'bru' || brush.source === 'abr') ? 1 : D.textureApplication,
      grainBlendMode: (typeof brush.grainBlendMode === 'number' && isFinite(brush.grainBlendMode) && brush.grainBlendMode >= 1 && brush.grainBlendMode <= 28) ? Math.round(brush.grainBlendMode) : 1,
      textureInverted: !!brush.textureInverted,
      taperSize: brush.taperOn ? Math.max(0, Math.min(1, brush.taperSize === undefined ? 0.5 : brush.taperSize)) : 0,
      taperOpacity: brush.taperOn ? Math.max(0, Math.min(1, brush.taperOpacity === undefined ? 0.5 : brush.taperOpacity)) : 0,
      taperStartLength: brush.taperOn ? Math.max(0, Math.min(1, brush.taperStartLength === undefined ? 0.2 : brush.taperStartLength)) : 0,
      taperEndLength: brush.taperOn ? Math.max(0, Math.min(1, brush.taperEndLength === undefined ? 0.3 : brush.taperEndLength)) : 0,
      wetEdgesAmount: brush.wetEdgesOn ? Math.max(0, Math.min(1, brush.wetEdgesAmount === undefined ? 0.4 : brush.wetEdgesAmount)) : 0,
      smudgeSize: brush.smudgeSize === undefined ? (brush.smudgeOn ? Math.max(0, Math.min(1, brush.smudgeAmount === undefined ? 0.3 : brush.smudgeAmount)) : 0) : brush.smudgeSize,
      smudgeOpacity: brush.smudgeOpacity === undefined ? (brush.smudgeOn ? Math.max(0, Math.min(1, brush.smudgeAmount === undefined ? 0.3 : brush.smudgeAmount)) : 0) : brush.smudgeOpacity,
      dynamicsSmudgeAccumulation: brush.procreateSmudgeAccumulation === undefined ? (brush.smudgeAmount === undefined ? 0.5 : brush.smudgeAmount) : brush.procreateSmudgeAccumulation,
      dynamicsMix: brush.dynamicsMix !== undefined ? Math.max(0, Math.min(1, Number(brush.dynamicsMix) || 0)) : (brush.smudgeOn && brush.source !== 'procreate' ? Math.max(0, Math.min(1, brush.smudgeAmount === undefined ? 0.3 : brush.smudgeAmount)) : D.dynamicsMix),
      dynamicsJitterHue: brush.colorPerTip === false ? 0 : Math.max(0, Math.min(1, brush.colorJitterHue || 0)),
      dynamicsJitterSaturation: brush.colorPerTip === false ? 0 : Math.max(0, Math.min(1, brush.colorJitterSat || 0)),
      dynamicsJitterLightness: brush.colorPerTip === false ? 0 : Math.max(0, Math.min(1, brush.colorJitterVal || 0)),
      dynamicsJitterStrokeHue: brush.colorPerTip === false ? Math.max(0, Math.min(1, brush.colorJitterHue || 0)) : D.dynamicsJitterStrokeHue,
      dynamicsJitterStrokeSaturation: brush.colorPerTip === false ? Math.max(0, Math.min(1, brush.colorJitterSat || 0)) : D.dynamicsJitterStrokeSaturation,
      dynamicsJitterStrokeLightness: brush.colorPerTip === false ? Math.max(0, Math.min(1, brush.colorJitterVal || 0)) : D.dynamicsJitterStrokeLightness,
      jitterSecondary: brush.colorPerTip === false ? D.jitterSecondary : Math.max(0, Math.min(1, brush.colorJitterFgBg || 0)),
      jitterStrokeSecondary: brush.colorPerTip === false ? Math.max(0, Math.min(1, brush.colorJitterFgBg || 0)) : D.jitterStrokeSecondary,
      blendMode: (typeof brush.blendMode === 'number' && isFinite(brush.blendMode) && brush.blendMode >= 0 && brush.blendMode <= 30) ? Math.round(brush.blendMode) : 0,
      dualBlendMode: (function () {
        if (typeof brush.dualBlendMode === 'number' && isFinite(brush.dualBlendMode) && brush.dualBlendMode >= 0 && brush.dualBlendMode <= 30) return Math.round(brush.dualBlendMode);
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
    // Preserve already parsed native fields without inventing cross-engine
    // mappings. Leave template defaults intact when the source lacks a field.
    Object.keys(nativeFields).forEach(function(key){
      if(brush[key] !== undefined) params[nativeFields[key]]=brush[key];
    });
    // 真实画笔的 creationDate 是 NSDate 秒；没有它就少一个 Procreate 自己会写的字段
    params.creationDate = { 'NS.time': Math.round((Date.now() / 1000 - PROCREATE_EPOCH) * 1000) / 1000 };
    return params;
  }
  function buildArchive(brush, opts) {
    const params = archiveParams(brush, opts);
    if (brush.source === 'bru' && Number.isFinite(brush.minOpacityRatio) && Number.isFinite(brush.flowPct) && Number.isFinite(brush.minFlowRatio)) {
      params.brushConvBruPressure = JSON.stringify({ legacyMinWidth: !!brush.bruLegacyMinWidth && !!brush.pressureSize,
        minOpacity: brush.minOpacityRatio, flow: brush.flowPct, minFlow: brush.minFlowRatio,
        smallFlow: brush.bruSmallFlow, nativeMinOpacity: params.minOpacity });
    } else if (brush._bruPressure) {
      params.brushConvBruPressure = JSON.stringify(brush._bruPressure);
    }
    return bplist.writeKeyedArchive(params, 'SilicaBrush', ['SilicaBrush', 'ValkyrieBrush', 'NSObject']);
  }

  function isValidNativeArchive(rawBytes) {
    if (!rawBytes || rawBytes.length < 40) return false;
    try {
      const p = plist.unarchive(rawBytes);
      if (!p || typeof p !== 'object') return false;
      if (p.__class && p.__class !== 'SilicaBrush') return false;
      if (typeof p.maxSize !== 'number' || typeof p.paintSize !== 'number') return false;
      if (!p.dynamicsPressureOpacityCurve || typeof p.dynamicsPressureOpacityCurve !== 'object') return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function unchanged(brush,opts) {
    opts=opts||{};
    function imageKept(bytes,grain) {
      if(!bytes)return true;
      const h=readPngHeader(bytes);
      return !!(h&&h.bitDepth===8&&h.colorType===0&&h.width>=1&&h.height>=1&&h.width<=2048&&h.height<=2048&&(!grain||h.width===h.height));
    }
    return opts.fidelity!==false && !opts.forceRebuild && isValidNativeArchive(brush._rawArchive) &&
      !brush.resolvedShapePath && !brush.shapeFromLibrary && !brush.grainFromLibrary &&
      imageKept(brush._rawShape,false) && imageKept(brush._rawGrain,true) &&
      (!brush.dualSubBrush || unchanged(brush.dualSubBrush, opts)) &&
      brush._rawBrushState===util.brushFingerprint(brush) &&
      brush._rawGrainState===util.brushFingerprint({tip:brush._grainRgba});
  }

  const nativeFields={wetEdgesAccumulation:'dynamicsWetAccumulation',burntEdgesAmount:'burntEdgesAmount',
    dynamicsLoad:'dynamicsLoad',dynamicsGlazedFlow:'dynamicsGlazedFlow',dynamicsMix:'dynamicsMix',
    dynamicsMixSoftening:'dynamicsMixSoftening',blendMode:'blendMode',
    roundnessDynamics:'dynamicsPressureShapeRoundness',
    dynamicsJitterDarkness:'dynamicsJitterDarkness',
    dynamicsJitterStrokeHue:'dynamicsJitterStrokeHue',
    dynamicsJitterStrokeSaturation:'dynamicsJitterStrokeSaturation',
    dynamicsJitterStrokeLightness:'dynamicsJitterStrokeLightness',
    dynamicsJitterStrokeDarkness:'dynamicsJitterStrokeDarkness',
    jitterSecondary:'jitterSecondary',
    jitterStrokeSecondary:'jitterStrokeSecondary'};
  function patchArchive(brush, opts, extraChanges) {
    const before=brush._rawNormalized||{},params=archiveParams(brush,opts),changes={};
    const mapping={sizePx:['paintSize'],spacingPct:['plotSpacing'],name:['name'],opacity:['maxOpacity','paintOpacity'],
      minSizeRatio:['minSize'],minOpacityRatio:['minOpacity'],angle:['shapeAngle'],roundness:['shapeRoundness'],
      dynamicsControlAngle:['shapeRotation','shapeAzimuth'],bruRotationMode:['shapeRotation','shapeAzimuth'],
      pressure:['dynamicsPressureSize'],pressureSize:['dynamicsPressureSize'],pressureOpacity:['dynamicsPressureOpacity'],
      scatterOn:['plotJitter'],scatterPct:['plotJitter'],scatterCount:['shapeCount'],
      angleJitterDeg:['shapeScatter'],procreateRotationScatterPct:['shapeScatter'],
      countJitterPct:['shapeCountJitter'],spacingJitterPct:['plotSpacingJitter'],falloffPct:['dynamicsFalloff'],
      flipXJitter:['shapeFlipXJitter'],flipYJitter:['shapeFlipYJitter'],smoothingStrength:['plotSmoothing'],
      sizeJitterPct:['dynamicsJitterSize'],opacityJitterPct:['dynamicsJitterOpacity'],
      roundnessJitterPct:['jitterShapeRoundness'],minRoundnessRatio:['dynamicsPressureShapeRoundnessMinimum'],
      tiltSizeDyn:['dynamicsTiltSize'],tiltOpacityDyn:['dynamicsTiltOpacity'],
      tiltAngleDyn:['dynamicsTiltAngle'],tiltRoundnessDyn:['dynamicsTiltShapeRoundness'],speedSizeDyn:['dynamicsSpeedSize'],
      speedOpacityDyn:['dynamicsSpeedOpacity'],hasTexture:['grainDepth'],textureDepth:['grainDepth'],textureScale:['textureScale'],
      grainDepthMinimum:['grainDepthMinimum'],grainDepthJitter:['grainDepthJitter'],
      textureBrightness:['textureBrightness'],textureContrast:['textureContrast'],textureRotation:['textureRotation'],
      textureInverted:['textureInverted'],grainBlendMode:['grainBlendMode'],dualBlendMode:['dualBlendMode'],
      taperOn:['taperSize','taperOpacity','taperStartLength','taperEndLength'],taperSize:['taperSize'],taperOpacity:['taperOpacity'],
      taperStartLength:['taperStartLength'],taperEndLength:['taperEndLength'],
      wetEdgesOn:['wetEdgesAmount'],wetEdgesAmount:['wetEdgesAmount'],smudgeOn:['smudgeSize','smudgeOpacity'],
      smudgeAmount:['smudgeSize','smudgeOpacity'],smudgeSize:['smudgeSize'],smudgeOpacity:['smudgeOpacity'],
      procreateSmudgeAccumulation:['dynamicsSmudgeAccumulation'],
      colorJitterFgBg:['jitterSecondary','jitterStrokeSecondary'],
      colorPerTip:['dynamicsJitterHue','dynamicsJitterSaturation','dynamicsJitterLightness','dynamicsJitterStrokeHue','dynamicsJitterStrokeSaturation','dynamicsJitterStrokeLightness','jitterSecondary','jitterStrokeSecondary'],
      colorJitterHue:['dynamicsJitterHue','dynamicsJitterStrokeHue'],colorJitterSat:['dynamicsJitterSaturation','dynamicsJitterStrokeSaturation'],
      colorJitterVal:['dynamicsJitterLightness','dynamicsJitterStrokeLightness']};
    Object.keys(nativeFields).forEach(key=>{mapping[key]=[nativeFields[key]];});
    Object.keys(mapping).forEach(function(key){if(brush[key]!==before[key])mapping[key].forEach(k=>{changes[k]=params[k];});});
    if(changes.shapeAngle!==undefined)changes.shapeAngle-=orientationDegrees(plist.unarchive(brush._rawArchive))*Math.PI/180;
    // Native slider and bounds are coupled. Never patch normalized slider units
    // with pixels / 400 while leaving bounds from the source archive behind.
    if(changes.paintSize!==undefined || changes.minSize!==undefined){
      Object.assign(changes,sizeArchiveParams(brush));
      changes.shapeRoundness=params.shapeRoundness;
    } else if(changes.shapeRoundness!==undefined) {
      changes.shapeRoundness=roundnessArchiveParam(brush,nativeSizeRange(plist.unarchive(brush._rawArchive)));
    }
    if(changes.maxOpacity!==undefined || changes.minOpacity!==undefined) {
      Object.assign(changes,{paintOpacity:params.paintOpacity,maxOpacity:params.maxOpacity,minOpacity:params.minOpacity});
    }
    if(extraChanges)Object.assign(changes,extraChanges);
    return bplist.patchKeyedArchive(brush._rawArchive,changes);
  }


  function secondaryBrush(brush) {
    const sub = brush.dualSubBrush || {};
    const info = brush.dualBrush || {};
    // Parsed dualBrush aliases are snapshots of the secondary. Do not let an
    // unchanged snapshot erase a later edit of the actual secondary brush.
    // Explicitly changed aliases still take priority, as for imported ABR data.
    function value(alias,key,fallback) {
      const before=sub._rawNormalized;
      if (before && sub[key] !== undefined && sub[key] !== before[key] && info[alias] === before[key]) return sub[key];
      return info[alias] === undefined ? (sub[key] === undefined ? fallback : sub[key]) : info[alias];
    }
    function nameValue() {
      // ABR 双笔副刷缺 `Nm  ` 时解析结果是空串（不是 undefined），
      // 直接用 value() 会把旧的「<主刷名> 2」回退链跳掉（#270）。
      // 规则：显式改过的二次解析名 > 非空快照名 > 非空二次解析名 > 主刷名 + " 2"。
      const fromInfo = info.name;
      const fromSub = sub.name;
      const before = sub._rawNormalized;
      const nonEmpty = function (v) { return v !== undefined && v !== null && String(v).trim() !== ''; };
      if (before && fromSub !== undefined && fromSub !== before.name && fromInfo === before.name && nonEmpty(fromSub)) return fromSub;
      if (nonEmpty(fromInfo)) return fromInfo;
      if (nonEmpty(fromSub)) return fromSub;
      return brush.name + ' 2';
    }
    return Object.assign({}, info, sub, {
      name: nameValue(),
      // The parent dualTip can be a cross-format round fallback or an older
      // snapshot. Until explicitly replaced, prefer the actual native child.
      tip: sub._rawArchive && brush._rawDualTipState===util.brushFingerprint({tip:brush.dualTip}) ? sub.tip : brush.dualTip,
      sizePx: value('diameter','sizePx',brush.sizePx || 100),
      spacingPct: value('spacing','spacingPct',25),
      scatterOn: info.useScatter === undefined ? (sub.scatterOn === undefined ? !!info.scatterOn : !!sub.scatterOn) : !!info.useScatter,
      scatterCount: info.count === undefined ? (sub.scatterCount || info.scatterCount || 1) : info.count,
      scatterBothAxes: info.bothAxes === undefined ? !!(sub.scatterBothAxes || info.scatterBothAxes) : !!info.bothAxes,
      scatterPct: value('scatterPct','scatterPct',undefined),
      dualOn: false, dualTip: undefined, dualSubBrush: undefined,
      _rawArchive: sub._rawArchive || brush._rawSubArchive,
      _rawShape: sub._rawShape || brush._rawSubShape,
      _rawGrain: sub._rawGrain || brush._rawSubGrain
    });
  }

  function writeBrush(brush, opts) {
    opts = opts || {};
    // Fresh/rebuilt archives must agree with the resources actually included.
    // Native raw archives retain their existing resource/parameter semantics,
    // unless the raw archive is a broken legacy converter artifact.
    const rawPath = opts.fidelity !== false && isValidNativeArchive(brush._rawArchive) && !opts.forceRebuild;
    const grain = !rawPath && brush.hasTexture && !opts.noTextureBake ? grainPng(brush) : null;
    if (!rawPath && brush.hasTexture && !grain) brush = Object.assign({}, brush, {hasTexture:false, textureDepth:0});
    function subBrush(){const b=secondaryBrush(brush);
      if(opts.spacingOverride>0)b.spacingPct=opts.spacingOverride;
      if(opts.pressure!==undefined){b.pressureSize=!!opts.pressure;b.pressureOpacity=opts.pressure===false?false:!!b.pressureOpacity;b.pressure=b.pressureSize||b.pressureOpacity;}
      return b;}
    // 还原优先：源就是 Procreate 且没有改过参数时，原样复用 archive/Shape/Grain
    if (rawPath) {
      const entries = (brush._rawEntries||[]).filter(e=>!['Brush.archive','Shape.png','Grain.png','QuickLook/Thumbnail.png'].includes(e.name)&&!e.name.startsWith('Sub01/')&&!e.name.startsWith('Reset/'));
      const samePixels=brush._rawTipState===util.brushFingerprint({tip:brush.tip});
      const sameTip=samePixels && !brush.flipX && !brush.flipY;
      const rawShape=brush._rawShape&&brush._rawShape.length?brush._rawShape:null;
      const keepRawShape=sameTip&&rawShape;
      const normalizedShape=keepRawShape ? normalizeRawShape(brush._rawShape,opts.maxTipSize||2048,brush.shapeInverted) : null;
      // 重生成 Shape.png 时像素已烘焙反转，archive 必须关掉以免二次反相；
      // 像素没变、只切换标志时则尊重新值，并继续复用原 Shape.png。
      let archiveChanges=null;
      if(!keepRawShape&&((!sameTip&&brush.tip)||(!rawShape&&!brush.bundledShapePath)))archiveChanges={shapeInverted:false};
      else if(keepRawShape&&!!brush.shapeInverted!==!!(brush._rawNormalized||{}).shapeInverted)
        archiveChanges={shapeInverted:!!brush.shapeInverted};
      if(normalizedShape && normalizedShape.inverted!==!!brush.shapeInverted)archiveChanges={shapeInverted:normalizedShape.inverted};
      const recoveredGrain = brush.grainFromLibrary && brush._grainRgba;
      if(brush._rawGrain&&brush._rawGrain.length===0&&!recoveredGrain)archiveChanges=Object.assign({},archiveChanges,{grainDepth:0});
      entries.push({name:'Brush.archive',data:patchArchive(brush,opts,archiveChanges)});
      if(keepRawShape)entries.push({name:'Shape.png',data:normalizedShape.bytes});
      else if((!sameTip && brush.tip) || (!rawShape && !brush.bundledShapePath)){
        let rebuilt=tipRGBA(brush,opts);
        // The decoded pixels include the original inversion. If only scalar
        // edits changed it, apply that delta before freezing it into Shape.
        if(samePixels && !!brush.shapeInverted!==!!(brush._rawNormalized||{}).shapeInverted){
          // Decode the original luminance and alpha together: complementing
          // normalized coverage would fill originally transparent pixels.
          const decoded=brush._rawShape && decodeShape({data:function(){return brush._rawShape;}},brush.shapeInverted);
          if(decoded)rebuilt=fixedTipFlip(decoded,brush);
        }
        entries.push({name:'Shape.png',data:shapePng(rebuilt,opts.maxTipSize||512).png});
      }
      const sameGrain=brush._rawGrainState===util.brushFingerprint({tip:brush._grainRgba});
      if(sameGrain && !recoveredGrain && brush._rawGrain && brush._rawGrain.length)entries.push({name:'Grain.png',data:normalizeRawGrain(brush._rawGrain)});
      else if(brush.hasTexture){const g=grainPng(brush);if(g)entries.push({name:'Grain.png',data:g});}
      if(brush.dualOn && brush.dualTip)zip.read(writeBrush(subBrush(),opts)).forEach(e=>entries.push({name:'Sub01/'+e.name,data:e.data()}));
      /* 【第188轮】缩略图优先复用源包的，不再因为有笔尖就重画。
         实测源包主笔 Thumbnail 是 327×100 灰度+alpha(ct4)、副笔 1060×324 RGBA(ct6)；
         我们重画成 256×128 RGBA(ct6)，是整包与原生唯一的实质差异。
         缩略图只是 Procreate 笔刷条里的预览，复用原图最安全（Procreate 会按需重算）。 */
      const originalThumb = (brush._rawEntries || []).find(e=>e.name==='QuickLook/Thumbnail.png');
      if (originalThumb) entries.push({name:'QuickLook/Thumbnail.png',data:new Uint8Array(originalThumb.data)});
      else {
        let tipRaw = brush.tip ? tipRGBA(brush,opts) : null;
        if (!tipRaw) tipRaw = roundTip(brush.sizePx || 128);
        entries.push({ name: 'QuickLook/Thumbnail.png', data: thumbPng(tipRaw, { spacingPct: brush.spacingPct, opacity: brush.opacity }) });
      }
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
    if (grain) entries.push({ name: 'Grain.png', data: grain });
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
    const uuids = [];
    brushList.forEach(function (brush) {
      const uuid = proUuid();
      uuids.push(uuid);
      const folder = uuid + '/';
      zip.read(writeBrush(brush, opts)).forEach(function (e) {
        files.push({ name: folder + e.name, data: e.data() });
      });
    });
    if (!files.length) throw new Error('没有可写入 Procreate 的笔刷（都缺少笔尖图像）');
    const setName = opts.setName || opts.name || (brushList[0] && brushList[0]._brushsetName) || (brushList[0] && brushList[0].name) || 'Procreate Brushes';
    /* 与原生样本一致：brushset.plist 放在包**末尾**（实测源包位置 496/630，
       原来 unshift 到首位是唯一与原生不同的结构差异）。 */
    files.push({ name: 'brushset.plist', data: buildBrushsetPlist(setName, uuids) });
    return zip.write(files);
  }

  function proUuid() {
    const hex = '0123456789ABCDEF';
    const b = util.randomBytes(16);
    /* 【第188轮】必须生成合法的 RFC 4122 UUID v4。
       原来 16 字节纯随机，第 3 段首字符（version）和第 4 段首字符（variant）
       不受约束：实测源 .brushset 的 53 个目录 UUID 里 version 位 100% 是 '4'，
       而我们生成的是 0~F 乱分布（只有约 1/16 碰巧是 4）。
       Procreate 读 brushset 时按 UUID 语义处理这些键值，拿到非法值会崩，
       所以表现为「转出 Procreate 有概率崩溃」。 */
    b[6] = (b[6] & 0x0f) | 0x40;  // version 4
    b[8] = (b[8] & 0x3f) | 0x80;  // variant 10xx
    let s = '';
    for (let i = 0; i < 16; i++) {
      if (i === 4 || i === 6 || i === 8 || i === 10) s += '-';
      s += hex[b[i] >> 4] + hex[b[i] & 15];
    }
    return s;
  }

  const api = { isProcreate, parse, parseAsync, writeBrush, writeBrushset, buildArchive, shapePng, thumbPng, unchanged, secondaryBrush: secondaryBrush };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { procreate: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
