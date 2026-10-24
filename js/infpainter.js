/* Infinite Painter brush: .prbr = zip { preview (PNG), properties.json }
   properties.json layout (observed on real files):
     display-name, head-properties{spacing, softness, angle, flow, structure, ...},
     stroke-properties{paint-size, paint-opacity, size-maximum, ...},
     blend-properties{flow, strength, smudge-amount, mix-in}, dynamics-properties{pressure profiles} */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const zip = isNode ? require('./zip.js') : root.BC.zip;
  const png = isNode ? require('./png.js') : root.BC.png;

  function isPrbr(bytes) {
    if (!bytes || !zip.isZip(bytes)) return false;
    try {
      const entries = zip.read(bytes);
      const hasProps = entries.some(function (e) { return /(^|\/)properties\.json$/i.test(e.name); });
      const hasPreview = entries.some(function (e) { return /(^|\/)preview$/i.test(e.name) || /preview\.png$/i.test(e.name); });
      return hasProps;
    } catch (e) {
      return false;
    }
  }

  function num(obj, path, fallback) {
    let cur = obj;
    for (const key of path) {
      if (!cur || typeof cur !== 'object') return fallback;
      cur = cur[key];
    }
    return (typeof cur === 'number' && isFinite(cur)) ? cur : fallback;
  }

  function bool(obj, path, fallback) {
    let cur = obj;
    for (const key of path) {
      if (!cur || typeof cur !== 'object') return fallback;
      cur = cur[key];
    }
    return typeof cur === 'boolean' ? cur : fallback;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* Pressure profile = flat [x0,y0,x1,y1,...] in 0..1. Return min/max y. */
  function profileRange(profile) {
    if (!profile || !profile.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < profile.length; i += 2) {
      const y = profile[i];
      if (typeof y !== 'number' || !isFinite(y)) continue;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    if (!isFinite(lo) || !isFinite(hi)) return null;
    return { lo: lo, hi: hi };
  }

  function parsePrbr(bytes, fileName) {
    const entries = zip.read(bytes);
    const warnings = [];
    let props = null;
    let preview = null;
    for (const e of entries) {
      if (e.dir) continue;
      if (/properties\.json$/i.test(e.name)) {
        try { props = JSON.parse(util.utf8Decode(e.data())); } catch (err) { throw new Error('.prbr 的 properties.json 解析失败'); }
      } else if (/preview$/i.test(e.name) || /preview\.png$/i.test(e.name)) {
        preview = e.data();
      }
    }
    if (!props) throw new Error('.prbr 缺少 properties.json');
    const head = props['head-properties'] || {};
    const stroke = props['stroke-properties'] || {};
    const blend = props['blend-properties'] || {};
    const dyn = props['dynamics-properties'] || {};

    const name = String(props['display-name'] || (fileName || '').replace(/\.[^.]+$/, '') || 'infinite painter brush');
    const sizeRaw = num(stroke, ['paint-size'], 0);
    const sizeMax = num(stroke, ['size-maximum'], 0);
    let sizePx = sizeRaw > 0 ? sizeRaw : (sizeMax > 0 ? sizeMax : 40);
    // very large values are likely relative units; clamp to sane brush px
    sizePx = clamp(sizePx, 1, 2000);
    let spacing = num(head, ['spacing'], 0.1);
    if (spacing > 0 && spacing <= 2) spacing = spacing * 100; // always a fraction -> percent
    const spacingPct = clamp(spacing || 10, 1, 1000);
    const opacityRaw = num(stroke, ['paint-opacity'], 1);
    const blendOpacity = num(stroke, ['blend-opacity'], 1);
    const opacity = clamp((opacityRaw > 0 ? opacityRaw : 1) * (blendOpacity > 0 ? Math.max(0.1, blendOpacity) : 1), 0.02, 1);
    const softness = clamp(num(head, ['softness'], 0), 0, 1);
    const hardness = 1 - softness;
    const angleRad = num(head, ['angle'], 0);
    const angle = angleRad * 180 / Math.PI;
    const pressureSize = bool(dyn, ['pressure - effects size'], false);
    const pressureFlow = bool(dyn, ['pressure - effects flow'], false);
    const sizeProfile = profileRange(dyn['pressure profile - size']);
    const flowProfile = profileRange(dyn['pressure profile - flow']);
    let minSizeRatio = 1;
    if (pressureSize && sizeProfile && sizeProfile.hi > sizeProfile.lo) {
      minSizeRatio = clamp(sizeProfile.lo / Math.max(0.001, sizeProfile.hi), 0.02, 1);
    }
    let minOpacityRatio = 1;
    if (pressureFlow && flowProfile && flowProfile.hi > flowProfile.lo) {
      minOpacityRatio = clamp(flowProfile.lo / Math.max(0.001, flowProfile.hi), 0, 1);
    }
    // Infinite Painter brush heads are built-in shapes (round/bristle/charcoal...);
    // they are not embedded in .prbr, so synthesize a round tip from hardness/softness.
    const headName = (props['source-properties'] && props['source-properties'].head) || 'round';
    warnings.push('Infinite Painter 笔尖是内置形状（' + headName + '），未随文件保存；转换时用硬度/柔边参数生成圆头笔尖');
    const wet = num(blend, ['smudge-amount'], 0);
    if (wet > 0.5) warnings.push('该 Infinite Painter 笔刷含较强混色/涂抹（smudge=' + wet.toFixed(2) + '），转换后只保留基础笔迹');
    return {
      brushes: [{
        name: name,
        tip: null,
        sizePx: sizePx,
        spacingPct: spacingPct,
        opacity: opacity,
        hardness: hardness,
        angle: angle,
        roundness: 100,
        pressure: pressureSize || pressureFlow,
        pressureSize: pressureSize,
        minSizeRatio: minSizeRatio,
        pressureOpacity: pressureFlow,
        minOpacityRatio: minOpacityRatio,
        source: 'infpainter',
        headName: headName
      }],
      warnings: warnings
    };
  }

  /* ---------- write ---------- */
  function defaultProps() {
    return {
      'blend-properties': { 'flow': 1, 'mix-in': 0, 'mix-in dilution': 0, 'mix-wet': false, 'smudge-amount': 0, 'strength': 0.2 },
      'display-name': 'brush',
      'dynamics-properties': {
        'pressure - effects dilution': false,
        'pressure - effects flow': false,
        'pressure - effects head depth': false,
        'pressure - effects scatter': false,
        'pressure - effects size': false,
        'pressure - effects texture': false,
        'pressure profile - dilution': [0, 0, 0.5, 0.5, 1, 1],
        'pressure profile - flow': [0, 0, 0.5, 0.5, 1, 1],
        'pressure profile - head depth': [0, 0, 0.5, 0.5, 1, 1],
        'pressure profile - scatter': [0, 0, 0.5, 0.5, 1, 1],
        'pressure profile - size': [0, 1, 0.5, 0.5, 1, 0],
        'pressure profile - texture': [0, 0, 0.5, 0.5, 1, 1],
        'tilt - effects dilution': false,
        'tilt - effects flow': false,
        'tilt - effects head depth': false,
        'tilt - effects scatter': false,
        'tilt - effects size': false,
        'tilt - effects texture': false,
        'tilt - gradation': 0,
        'tilt - offset': 0,
        'tilt profile - dilution': [0, 0, 0.5, 0.5, 1, 1],
        'tilt profile - flow': [0, 0, 0.5, 0.5, 1, 1],
        'tilt profile - head depth': [0, 0, 0.5, 0.5, 1, 1],
        'tilt profile - scatter': [0, 0, 0.5, 0.5, 1, 1],
        'tilt profile - size': [0, 0, 0.5, 0.5, 1, 1],
        'tilt profile - texture': [0, 0, 0.5, 0.5, 1, 1],
        'velocity - effects dilution': false,
        'velocity - effects flow': false,
        'velocity - effects head depth': false,
        'velocity - effects scatter': false,
        'velocity - effects size': false,
        'velocity - effects texture': false,
        'velocity profile - dilution': [0, 0, 0.5, 0.5, 1, 1],
        'velocity profile - flow': [0, 0, 0.5, 0.5, 1, 1],
        'velocity profile - head depth': [0, 0, 0.5, 0.5, 1, 1],
        'velocity profile - scatter': [0, 0, 0.5, 0.5, 1, 1],
        'velocity profile - size': [0, 0, 0.5, 0.5, 1, 1],
        'velocity profile - texture': [0, 0, 0.5, 0.5, 1, 1]
      },
      'head-properties': {
        'angle': 0, 'depth': 0, 'flow': 1, 'rotation': 0, 'screen-aligned': false,
        'softness': 0, 'spacing': 0.1, 'structure': 0, 'style': 0, 'use-trajectory': false
      },
      'jitter-properties': {
        'angle': 0, 'color-brightness': 0, 'color-hue': 0, 'color-saturation': 0,
        'color-start brightness': 0, 'color-start hue': 0, 'color-start saturation': 0,
        'flow': 0, 'scatter': 0, 'size': 0, 'start-angle': 0, 'texture-angle': 0,
        'texture-position': 0, 'texture-scale': 0, 'texture-start-position': 0
      },
      'parent': 2,
      'source-properties': {
        'custom-head': '', 'custom-stroke texture': '', 'head': '', 'head - color': false,
        'head - colorize': 1, 'head - profile': [0, 1, 1, 0], 'stroke texture': '',
        'stroke texture - color': false, 'stroke texture - colorize': 1, 'stroke texture - profile': [0, 1, 1, 0]
      },
      'stroke-properties': {
        'adhesion': 0, 'blend-opacity': 1, 'blend-size': 1, 'blendmode': 0, 'blendmode-intensity': 1,
        'erase-opacity': 1, 'erase-size': 1, 'flow-profile': [], 'glaze-strokes': 0,
        'has-flow-profile': false, 'has-size-profile': false, 'lazy-stroke': 0, 'paint-opacity': 1,
        'paint-size': 16, 'size-maximum': 1, 'size-profile': [], 'wet-edges': 0
      },
      'texture-properties': {
        'angle': 0, 'invert': false, 'pressure': 0, 'scale': 1, 'scale-size': 1,
        'softness': 0, 'stretch': 0, 'structure': 0, 'style': 0
      }
    };
  }

  function writePrbr(brush) {
    const props = defaultProps();
    props['display-name'] = String(brush.name || 'brush');
    const sizePx = clamp(brush.sizePx || 16, 1, 2000);
    props['stroke-properties']['paint-size'] = sizePx;
    props['stroke-properties']['size-maximum'] = 1;
    props['stroke-properties']['paint-opacity'] = (brush.opacity === undefined ? 1 : brush.opacity);
    props['stroke-properties']['blend-opacity'] = 1;
    props['head-properties']['spacing'] = Math.max(0.001, Math.min(2, (brush.spacingPct || 10) / 100));
    props['head-properties']['softness'] = Math.max(0, Math.min(1, 1 - (brush.hardness === undefined ? 1 : brush.hardness)));
    props['head-properties']['angle'] = ((brush.angle || 0) * Math.PI / 180);
    const pressureSize = !!brush.pressureSize;
    props['dynamics-properties']['pressure - effects size'] = pressureSize;
    if (pressureSize) {
      const min = Math.max(0.02, Math.min(1, brush.minSizeRatio === undefined ? 0.3 : brush.minSizeRatio));
      props['dynamics-properties']['pressure profile - size'] = [0, 1, 0.5, (1 + min) / 2, 1, min];
    }
    const pressureFlow = !!brush.pressureOpacity;
    props['dynamics-properties']['pressure - effects flow'] = pressureFlow;
    if (pressureFlow) {
      const min = Math.max(0, Math.min(1, brush.minOpacityRatio === undefined ? 0.3 : brush.minOpacityRatio));
      props['dynamics-properties']['pressure profile - flow'] = [0, 1, 0.5, (1 + min) / 2, 1, min];
    }
    // preview: render a simple stroke from the brush tip
    const tip = brush.tip;
    let previewPng = null;
    if (tip && tip.rgba) {
      try { previewPng = renderPreview(tip); } catch (e) { previewPng = null; }
    }
    const entries = [{ name: 'properties.json', data: util.utf8Encode(JSON.stringify(props, null, 3)) }];
    if (previewPng) entries.push({ name: 'preview', data: previewPng });
    return zip.write(entries);
  }

  function renderPreview(tip) {
    const W = 256, H = 128;
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255; }
    const maxSide = 56;
    const sc = Math.min(1, maxSide / Math.max(tip.w, tip.h));
    const sw = Math.max(1, Math.round(tip.w * sc)), sh = Math.max(1, Math.round(tip.h * sc));
    const stamp = png.resize(tip.rgba, tip.w, tip.h, sw, sh);
    const step = Math.max(2, sw * 0.25);
    for (let x = 10; x < W - 10; x += step) {
      const t = (x - 10) / Math.max(1, W - 20);
      const cy = H / 2 + Math.sin(t * Math.PI * 1.6) * 22;
      const s = 0.5 + 0.5 * Math.sin(t * Math.PI);
      const dw = Math.max(1, Math.round(sw * s)), dh = Math.max(1, Math.round(sh * s));
      for (let yy = 0; yy < dh; yy++) {
        const dy = Math.round(cy - dh / 2 + yy);
        if (dy < 0 || dy >= H) continue;
        for (let xx = 0; xx < dw; xx++) {
          const dx = Math.round(x - dw / 2 + xx);
          if (dx < 0 || dx >= W) continue;
          const sx = Math.min(sw - 1, Math.floor(xx * sw / dw));
          const sy = Math.min(sh - 1, Math.floor(yy * sh / dh));
          const a = stamp[(sy * sw + sx) * 4 + 3] / 255;
          if (a <= 0) continue;
          const o = (dy * W + dx) * 4;
          rgba[o] = Math.round(rgba[o] * (1 - a) + 30 * a);
          rgba[o + 1] = Math.round(rgba[o + 1] * (1 - a) + 30 * a);
          rgba[o + 2] = Math.round(rgba[o + 2] * (1 - a) + 30 * a);
        }
      }
    }
    return png.encode(W, H, rgba);
  }

  const api = { isPrbr, parsePrbr, writePrbr };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { infpainter: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
