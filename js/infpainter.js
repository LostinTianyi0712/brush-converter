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
    const jitter = props['jitter-properties'] || {};
    const tex = props['texture-properties'] || {};

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
    const opacity = clamp(opacityRaw * (blendOpacity > 0 ? Math.max(0.1, blendOpacity) : 1), 0, 1);
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
    /* 【minor-fix】smudge-amount 过去只出现在告警文案里，值本身没有进 brush：
       「读了但没落到任何字段」等于跨格式必然丢。这里落到通用的混色字段上，
       写侧再按同一个键写回（见 writePrbr），本格式往返与跨格式都能带上。 */
    const wet = clamp(num(blend, ['smudge-amount'], 0), 0, 1);
    if (wet > 0.5) warnings.push('该 Infinite Painter 笔刷含较强混色/涂抹（smudge=' + wet.toFixed(2) + '），转换后只保留基础笔迹');
    /* 【minor-fix】以下四组同属「源里有、过去一律不读」：
       head.flow（0..1 流量）、stroke.wet-edges（0..1 湿边）、
       jitter.size/angle/scatter（抖动，0..1 与角度制）、texture.structure（纹理强度）。
       写回键与读键一一对应，单位按已观测样本（见 _probe/minor-fix/report.md）。 */
    const headFlow = num(head, ['flow'], 1);
    const wetEdges = num(stroke, ['wet-edges'], 0);
    const jitSize = num(jitter, ['size'], 0);
    const jitAngle = num(jitter, ['angle'], 0);
    const jitScatter = num(jitter, ['scatter'], 0);
    return {
      brushes: [{
        name: name,
        tip: null,
        sizePx: sizePx,
        spacingPct: spacingPct,
        opacity: opacity,
        flowPct: clamp(headFlow, 0, 1),
        hardness: hardness,
        angle: angle,
        roundness: 100,
        pressure: pressureSize || pressureFlow,
        pressureSize: pressureSize,
        minSizeRatio: minSizeRatio,
        pressureOpacity: pressureFlow,
        minOpacityRatio: minOpacityRatio,
        smudgeOn: wet > 0.001,
        smudgeAmount: wet,
        wetEdgesOn: wetEdges > 0.001,
        wetEdgesAmount: clamp(wetEdges, 0, 1),
        sizeJitterPct: clamp(jitSize, 0, 1) * 100,
        angleJitterDeg: clamp(Math.abs(jitAngle), 0, 360),
        scatterOn: jitScatter > 0.001,
        scatterPct: clamp(jitScatter, 0, 1) * 100,
        textureDepth: clamp(num(tex, ['structure'], 0), 0, 1),
        source: 'infpainter',
        headName: headName,
        /* 【minor-fix】源 properties.json 全量快照：写侧只覆盖自己映射过的键，
           其余原样写回（第 232 轮纪律：只透传未知、不覆盖已知）。 */
        _rawPrbrProps: props
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
        'pressure - effects dilution': false,        'pressure - effects flow': false,
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
        'head - colorize': 1, 'head - conversion format': 1, 'head - profile': [0, 1, 1, 0], 'stroke texture': '',
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

  /* 【minor-fix】写侧基座过去恒是 defaultProps()：106 个 properties 叶子只有 8 个
     会被覆写，其余全部退回模板默认值（.prbr→.prbr 往返实测 72/218 失真，
     smudge-amount / 6 条压力曲线 / texture.structure / parent 等全灭）。
     现在改成「默认值打底 + 源快照只透传未知键」：
       · MANAGED 里的键 = 本工具真正映射的键，写侧用 brush 值覆盖（行为与过去一致）；
       · 其余键（含 source-properties 全部子键、parent、blend-properties.strength、
         stroke-properties.blend-size/erase-size/lazy-stroke …）原样沿用源值；
       · 源里没有快照（非 .prbr 来源）时与过去完全一致。 */
  const MANAGED = {
    'blend-properties': ['smudge-amount'],
    'dynamics-properties': [
      'pressure - effects size', 'pressure - effects flow',
      'pressure profile - size', 'pressure profile - flow'
    ],
    'head-properties': ['angle', 'flow', 'softness', 'spacing'],
    'jitter-properties': ['angle', 'scatter', 'size'],
    'stroke-properties': ['blend-opacity', 'paint-opacity', 'paint-size', 'wet-edges']
  };

  function cloneProps(p) {
    try { return JSON.parse(JSON.stringify(p)); } catch (e) { return null; }
  }
  function overlayUnknown(target, source) {
    if (!source || typeof source !== 'object') return target;
    for (const section of Object.keys(source)) {
      const val = source[section];
      if (val === null || typeof val !== 'object' || Array.isArray(val)) {
        /* 顶层标量（display-name / parent）不受 MANAGED 段落表约束：
           只要源里有就沿用，写侧真正要改的键在下面显式赋新值。 */
        if (section !== 'display-name') target[section] = val;
        continue;
      }
      if (!target[section] || typeof target[section] !== 'object' || Array.isArray(target[section])) {
        target[section] = cloneProps(val) || {};
        continue;
      }
      const managed = MANAGED[section] || [];
      for (const key of Object.keys(val)) {
        if (managed.indexOf(key) >= 0) continue;
        target[section][key] = cloneProps(val[key]);
      }
    }
    return target;
  }
  /* 把源曲线按新的下限等比缩放：形状（中间控制点）保留，端点落到 min..1。
     源曲线缺失或退化时退回过去的两点近似，保证行为与旧版一致。 */
  function rescaleProfile(profile, min) {
    if (!Array.isArray(profile) || profile.length < 6) return null;
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < profile.length; i += 2) {
      const y = profile[i];
      if (typeof y !== 'number' || !isFinite(y)) return null;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    if (!(hi > lo)) return null;
    const out = profile.slice();
    for (let i = 1; i < out.length; i += 2) out[i] = min + (out[i] - lo) / (hi - lo) * (1 - min);
    return out;
  }

  function writePrbr(brush) {
    const src = cloneProps(brush && brush._rawPrbrProps);
    const props = src ? overlayUnknown(defaultProps(), src) : defaultProps();
    /* 段落缺失（截断/外来文件）时补壳，避免下行直接抛错 */
    for (const section of ['blend-properties', 'dynamics-properties', 'head-properties', 'jitter-properties', 'source-properties', 'stroke-properties', 'texture-properties']) {
      if (!props[section] || typeof props[section] !== 'object') props[section] = defaultProps()[section];
    }
    props['display-name'] = String(brush.name || 'brush');
    const sizePx = clamp(brush.sizePx || 16, 1, 2000);
    props['stroke-properties']['paint-size'] = sizePx;
    /* size-maximum 是「最大尺寸倍数」，本工具不映射它：
       源里有就原样保留（不动源数值才谈得上往返一致），没有则用中性 1。 */
    if (!(src && src['stroke-properties'] && isFinite(Number(src['stroke-properties']['size-maximum'])))) {
      props['stroke-properties']['size-maximum'] = 1;
    }
    /* 不透明度在 .prbr 里是 paint-opacity × blend-opacity 两级：
       写侧过去把结果全塞进 paint-opacity 并把 blend-opacity 拉回 1，
       两级分解方式（Hard Airbrush 0.81×0.48）就此丢失。改成反解：
       blend-opacity 有源值就保留，paint-opacity = 目标 / 该值。 */
    const opacityTarget = clamp(brush.opacity === undefined ? 1 : brush.opacity, 0, 1);
    const srcBlendOpacity = src && src['stroke-properties'] ? Number(src['stroke-properties']['blend-opacity']) : NaN;
    const blendKeep = isFinite(srcBlendOpacity) && srcBlendOpacity > 0.001 ? clamp(srcBlendOpacity, 0.1, 1) : 1;
    props['stroke-properties']['blend-opacity'] = blendKeep;
    props['stroke-properties']['paint-opacity'] = clamp(opacityTarget / blendKeep, 0, 1);
    props['head-properties']['spacing'] = Math.max(0.001, Math.min(2, (brush.spacingPct || 10) / 100));
    props['head-properties']['softness'] = Math.max(0, Math.min(1, 1 - (brush.hardness === undefined ? 1 : brush.hardness)));
    props['head-properties']['angle'] = ((brush.angle || 0) * Math.PI / 180);
    props['head-properties']['flow'] = clamp(brush.flowPct === undefined ? 1 : brush.flowPct, 0, 1);
    props['stroke-properties']['wet-edges'] = clamp(brush.wetEdgesAmount === undefined ? (brush.wetEdgesOn ? 1 : 0) : brush.wetEdgesAmount, 0, 1);
    props['blend-properties']['smudge-amount'] = clamp(brush.smudgeOn === false ? 0 : (brush.smudgeAmount === undefined ? 0 : brush.smudgeAmount), 0, 1);
    props['jitter-properties']['size'] = clamp((brush.sizeJitterPct || 0) / 100, 0, 1);
    props['jitter-properties']['angle'] = clamp(brush.angleJitterDeg || 0, 0, 360);
    props['jitter-properties']['scatter'] = clamp(brush.scatterOn === false ? 0 : (brush.scatterPct || 0) / 100, 0, 1);
    /* 压力曲线：源的形状（中间控制点、点数）优先，只把端点缩放到新的下限；
       源没有曲线时才写过去的两点直线。开关关闭时曲线原样保留源值。 */
    const srcDyn = (src && src['dynamics-properties']) || {};
    function profileFor(key, on, min) {
      const source = srcDyn[key];
      if (!on) return Array.isArray(source) ? source.slice() : props['dynamics-properties'][key];
      return rescaleProfile(source, min) || [0, 1, 0.5, (1 + min) / 2, 1, min];
    }
    const pressureSize = !!brush.pressureSize;
    props['dynamics-properties']['pressure - effects size'] = pressureSize;
    props['dynamics-properties']['pressure profile - size'] = profileFor('pressure profile - size',
      pressureSize, Math.max(0.02, Math.min(1, brush.minSizeRatio === undefined ? 0.3 : brush.minSizeRatio)));
    const pressureFlow = !!brush.pressureOpacity;
    props['dynamics-properties']['pressure - effects flow'] = pressureFlow;
    props['dynamics-properties']['pressure profile - flow'] = profileFor('pressure profile - flow',
      pressureFlow, Math.max(0, Math.min(1, brush.minOpacityRatio === undefined ? 0.3 : brush.minOpacityRatio)));
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
