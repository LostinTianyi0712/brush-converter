/* Krita paint-op preset (.kpp): PNG container carrying the preset XML in a
   text chunk (key "preset") plus a 200x200 preview image.

   Krita 5 expects the modern preset schema:
     <Preset name="..." paintopid="paintbrush">
       <param name="paintop" type="string"><![CDATA[paintbrush]]></param>
       <param name="brush_definition" type="string"><![CDATA[<Brush ...>
            <MaskGenerator type="circle" diameter=".." ratio=".." hfade=".." vfade=".."/></Brush>]]></param>
       ... more params ...
     </Preset>
   The old (v2.3) writer emitted Krita-2 style params ("Brush/radius" ...) plus a
   non-standard embedded GBR resource, which Krita imports but cannot paint with. */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const png = isNode ? require('./png.js') : root.BC.png;
  const gimp = isNode ? require('./gimp.js') : root.BC.gimp;

  const PREVIEW = 200;
  function asciiEntities(str) {
    return String(str).replace(/[\u0080-\uffff]/g, function (c) { return '&#x' + c.codePointAt(0).toString(16).toUpperCase() + ';'; });
  }


  function isKpp(bytes) {
    if (!png.isPng(bytes)) return false;
    try {
      const t = png.readTextChunks(bytes);
      return !!(t && t.preset && /<Preset\b/.test(t.preset));
    } catch (e) {
      return false;
    }
  }

  function b64ToBytes(s) {
    s = String(s || '').replace(/\s+/g, '');
    if (!s) return null;
    try {
      if (isNode) return new Uint8Array(Buffer.from(s, 'base64'));
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) {
      return null;
    }
  }

  /* Collect <param name="..." type="...">value</param> entries (flat text scan). */
  function collectParams(xml) {
    const params = {};
    const re = /<param\s+([^>]*?)\/?>([\s\S]*?)<\/param>/g;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = m[1];
      const body = m[2];
      const nameM = /name="([^"]+)"/.exec(attrs);
      if (!nameM) continue;
      const name = nameM[1];
      const typeM = /type="([^"]+)"/.exec(attrs);
      const type = typeM ? typeM[1] : '';
      const raw = body.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
      const text = body.replace(/<!\[CDATA\[|\]\]>/g, ' ').replace(/<[^>]+>/g, ' ').trim();
      const nums = [];
      const numRe = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;
      let nm;
      while ((nm = numRe.exec(text))) nums.push(parseFloat(nm[0]));
      params[name] = { type: type, text: text, raw: raw, nums: nums, value: nums.length ? nums[0] : NaN };
    }
    return params;
  }

  function pick(params, patterns) {
    for (const key of Object.keys(params)) {
      for (const pat of patterns) {
        if (pat.test(key)) return { key: key, value: params[key].value, item: params[key] };
      }
    }
    return null;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function parseBrushDefinition(raw) {
    if (!raw) return null;
    const brushM = /<Brush\b([^>]*?)(?:\s*\/>|>([\s\S]*?)<\/Brush>)/.exec(raw);
    if (!brushM) return null;
    const attrs = brushM[1];
    const inner = brushM[2] || '';
    const maskM = /<MaskGenerator\b([^>]*)\/?>/.exec(inner);
    const maskAttrs = maskM ? maskM[1] : '';
    function attr(s, name) {
      const m = new RegExp(name + '="([^"]*)"').exec(s || '');
      return m ? m[1] : null;
    }
    return {
      spacing: attr(attrs, 'spacing'),
      angle: attr(attrs, 'angle'),
      density: attr(attrs, 'density'),
      randomness: attr(attrs, 'randomness'),
      type: attr(maskAttrs, 'type') || attr(attrs, 'type'),
      diameter: attr(maskAttrs, 'diameter'),
      ratio: attr(maskAttrs, 'ratio'),
      hfade: attr(maskAttrs, 'hfade'),
      vfade: attr(maskAttrs, 'vfade'),
      filename: attr(attrs, 'filename') || attr(maskAttrs, 'filename'),
      scale: attr(attrs, 'scale')
    };
  }

  function parseKpp(bytes, fileName, resourceMap) {
    const warnings = [];
    const chunks = png.readTextChunks(bytes);
    const xml = chunks.preset || '';
    const rawXml = xml;
    const rootM = /<Preset\b([^>]*)>/.exec(xml);
    const rootAttrs = rootM ? rootM[1] : '';
    const nameAttr = /name="([^"]*)"/.exec(rootAttrs);
    const paintop = /paintopid="([^"]*)"/.exec(rootAttrs);
    const params = collectParams(xml);
    const bd = parseBrushDefinition(params.brush_definition ? params.brush_definition.raw : '');

    let sizePx = bd && bd.diameter ? parseFloat(bd.diameter) : 0;
    let spacingPct = bd && bd.spacing ? parseFloat(bd.spacing) * 100 : NaN;
    let angle = bd && bd.angle !== null && isFinite(parseFloat(bd.angle)) ? parseFloat(bd.angle) * 180 / Math.PI : NaN;
    let roundnessPct = bd && bd.ratio ? parseFloat(bd.ratio) * 100 : NaN;
    let hardness = bd && bd.hfade !== null && isFinite(parseFloat(bd.hfade)) ? parseFloat(bd.hfade) : NaN;

    if (!isFinite(sizePx) || !sizePx) {
      const radiusHit = pick(params, [/brush.*radius/i, /^radius$/i, /diameter/i, /size/i]);
      sizePx = radiusHit && isFinite(radiusHit.value) ? radiusHit.value : 0;
      if (/radius/i.test(radiusHit ? radiusHit.key : '')) sizePx = sizePx * 2;
    }
    if (!isFinite(sizePx) || !sizePx) sizePx = 40;
    sizePx = clamp(sizePx, 1, 4000);

    if (!isFinite(spacingPct)) {
      const spacingHit = pick(params, [/spacing/i]);
      spacingPct = spacingHit && isFinite(spacingHit.value) ? spacingHit.value : 25;
      if (spacingPct > 0 && spacingPct <= 1.5) spacingPct = spacingPct * 100;
    }
    spacingPct = clamp(spacingPct, 1, 1000);

    const opacityHit = pick(params, [/^OpacityValue$/i]) || pick(params, [/^opacity$/i]);
    let opacity = opacityHit && isFinite(opacityHit.value) ? opacityHit.value : 1;
    if (opacity > 1.5) opacity = opacity / 100;
    opacity = clamp(opacity, 0, 1);
    const flowHit = pick(params, [/^FlowValue$/i]) || pick(params, [/^flow$/i]);
    let flowPct = flowHit && isFinite(flowHit.value) ? flowHit.value : 1;
    if (flowPct > 1.5) flowPct /= 100;
    flowPct = clamp(flowPct, 0, 1);

    if (!isFinite(hardness)) {
      const softHit = pick(params, [/softness/i, /sharpness/i]);
      hardness = 1;
      if (softHit && isFinite(softHit.value)) {
        hardness = /softness/i.test(softHit.key) ? 1 - softHit.value : softHit.value;
        if (hardness > 1.5) hardness = hardness / 100;
      }
    }
    hardness = clamp(hardness, 0, 1);
    if (!isFinite(angle)) {
      const angleHit = pick(params, [/angle/i, /rotation/i]);
      angle = angleHit && isFinite(angleHit.value) ? angleHit.value : 0;
    }
    if (!isFinite(roundnessPct)) {
      const ratioHit = pick(params, [/ratio/i, /roundness/i]);
      let r = ratioHit && isFinite(ratioHit.value) ? ratioHit.value : 1;
      if (r > 1.5) r = r / 100;
      roundnessPct = clamp(r, 0.05, 1) * 100;
    }
    roundnessPct = clamp(roundnessPct, 5, 100);

    function pressureEnabled(flag, useCurve, sensor) {
      const explicit=params[flag];
      if(explicit)return /^(true|1)$/i.test(explicit.text.trim());
      return !!(params[useCurve] && /^(true|1)$/i.test(params[useCurve].text.trim()) &&
        params[sensor] && /pressure/i.test(params[sensor].raw));
    }
    const sizeDyn = pressureEnabled('PressureSize','SizeUseCurve','SizeSensor');
    const opDyn = pressureEnabled('PressureOpacity','OpacityUseCurve','OpacitySensor');

    // brush tip: embedded brush resource (Krita 4/5), else preview image
    let tip = null;
    const resRe = /<resource\b([^>]*)>([\s\S]*?)<\/resource>/g;
    let rm;
    while ((rm = resRe.exec(xml))) {
      const attrs = rm[1];
      const typeM = /type="([^"]*)"/.exec(attrs);
      const type = typeM ? typeM[1] : '';
      if (!/brush/i.test(type)) continue;
      const data = b64ToBytes(rm[2].replace(/<!\[CDATA\[|\]\]>/g, ''));
      if (!data) continue;
      if (gimp.isGbr(data)) {
        try {
          const parsed = gimp.parseGbr(data, fileName);
          if (parsed.brushes[0] && parsed.brushes[0].tip) { tip = parsed.brushes[0].tip; break; }
        } catch (e) { /* try next */ }
      } else if (png.isPng(data)) {
        try {
          const img = png.decode(data);
          tip = { w: img.width, h: img.height, rgba: png.toMaskRgba(img.rgba) };
          break;
        } catch (e) { /* try next */ }
      }
    }
    if (!tip && resourceMap) {
      // 资源包（.bundle）：按 requiredBrushFile 从包内其它条目找笔尖
      const wanted = [];
      const nameRe = /name="requiredBrushFiles?(?:List)?"[^>]*>\s*<!\[CDATA\[([^\]]*)\]\]/g;
      let mm;
      while ((mm = nameRe.exec(xml))) {
        String(mm[1] || '').split(/[,;]/).forEach(function (n) { n = n.trim(); if (n) wanted.push(n); });
      }
      for (const name2 of wanted) {
        const raw = resourceMap[name2] || resourceMap[name2.replace(/^.*\//, '')];
        if (!raw) continue;
        try {
          if (gimp.isGbr(raw)) {
            const parsed2 = gimp.parseGbr(raw, name2);
            if (parsed2.brushes[0] && parsed2.brushes[0].tip) { tip = parsed2.brushes[0].tip; break; }
          } else if (png.isPng(raw)) {
            const img = png.decode(raw);
            tip = { w: img.width, h: img.height, rgba: png.toMaskRgba(img.rgba) };
            break;
          }
        } catch (e) { /* next */ }
      }
    }
    if (!tip) {
      try {
        const img = png.decode(bytes);
        tip = { w: img.width, h: img.height, rgba: png.toMaskRgba(img.rgba) };
        warnings.push('该 KPP 未内嵌笔尖资源，使用预设缩略图作为笔尖（可能偏小）');
      } catch (e) { /* no tip */ }
    }
    if (tip && bd && /^(png|gbr)_brush$/.test(bd.type) && Number(bd.scale)>0) {
      sizePx=clamp(Math.max(tip.w,tip.h)*Number(bd.scale),1,4000);
    }
    if (!bd) warnings.push('未找到 Krita 5 的 brush_definition，按旧版参数尽力解析');
    return {
      _rawXml: rawXml,
      _rawKppName: (fileName || 'brush.kpp'),
      brushes: [{
        _rawXml: rawXml,
        _rawKppName: (fileName || 'brush.kpp'),
        name: (nameAttr ? nameAttr[1] : (fileName || '').replace(/\.[^.]+$/, '')) || 'krita brush',
        tip: tip,
        sizePx: sizePx,
        spacingPct: spacingPct,
        opacity: opacity,
        flowPct: flowPct,
        hardness: hardness,
        angle: angle,
        roundness: roundnessPct,
        pressure: !!(sizeDyn || opDyn),
        pressureSize: !!sizeDyn,
        minSizeRatio: sizeDyn ? 0.2 : 1,
        pressureOpacity: !!opDyn,
        minOpacityRatio: opDyn ? 0.3 : 1,
        source: 'krita',
        paintop: paintop ? paintop[1] : ''
      }],
      warnings: warnings
    };
  }

  function maskRgbaFromTip(tip) {
    if (tip.rgba) return { rgba: tip.rgba, w: tip.w, h: tip.h };
    const w = tip.w, h = tip.h;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = tip.data[i];
    }
    return { rgba: rgba, w: w, h: h };
  }

  /* 200x200 preview: the brush tip shown dark on transparent. */
  let previewBaseCache = null;
  function previewBase() {
    if (!previewBaseCache) {
      const b64 = isNode ? require('./kritaPreview.js') : root.BC.kritaPreview;
      const bytes = isNode ? new Uint8Array(Buffer.from(b64, 'base64')) : (function () {
        const bin = atob(b64); const a = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        return a;
      })();
      previewBaseCache = png.decode(bytes);
    }
    return previewBaseCache;
  }

  /* Preview must never be blank: start from a real Krita preset preview and draw
     the converted brush tip (or a sample stroke) on top. */
  function makePreview(tip) {
    const base = previewBase();
    const rgba = new Uint8Array(base.rgba);
    return rgba; // NOTE: plain real-preview pixels register reliably in Krita 5.3
    const W = base.width, H = base.height;
    const src = (tip && (tip.rgba || tip.data)) ? maskRgbaFromTip(tip) : null;
    if (src) {
      const box = Math.round(W * 0.6);
      const scale = Math.min(box / src.w, box / src.h, 1);
      const dw = Math.max(1, Math.round(src.w * scale));
      const dh = Math.max(1, Math.round(src.h * scale));
      const tmp = png.resize(src.rgba, src.w, src.h, dw, dh);
      const ox = Math.round((W - dw) / 2), oy = Math.round((H - dh) / 2);
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          const a = tmp[(y * dw + x) * 4 + 3];
          if (!a) continue;
          const di = ((oy + y) * W + (ox + x)) * 4;
          const f = a / 255;
          rgba[di] = Math.round(rgba[di] * (1 - f));
          rgba[di + 1] = Math.round(rgba[di + 1] * (1 - f));
          rgba[di + 2] = Math.round(rgba[di + 2] * (1 - f));
        }
      }
    } else {
      for (let y = Math.round(H * 0.25); y < H * 0.75; y++) {
        const t = (y - H * 0.25) / (H * 0.5);
        const cx = Math.round(W * (0.2 + 0.6 * t));
        const r = Math.max(2, Math.round(W * 0.03 * Math.sin(Math.PI * t)));
        for (let x = cx - r; x <= cx + r; x++) {
          if (x < 0 || x >= W) continue;
          const o = (y * W + x) * 4;
          rgba[o] = 30; rgba[o + 1] = 30; rgba[o + 2] = 30;
        }
      }
    }
    return rgba;
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, ' ').slice(0, 80); }
  function num(v, d) { return (isFinite(v) ? v : d).toFixed(3); }

  /* Krita 5 preset writer: modern schema, circle/ellipse mask from brush params. */
  function writeKpp(brush) {
    const name = esc(brush.name || 'brush');
    const diameter = Math.max(1, Math.min(4000, brush.sizePx || 40));
    const spacing = Math.max(0.01, Math.min(5, (brush.spacingPct || 10) / 100));
    const opacity = Math.max(0, Math.min(1, brush.opacity === undefined ? 1 : brush.opacity));
    const hardness = Math.max(0, Math.min(1, brush.hardness === undefined ? 1 : brush.hardness));
    const angleRad = (isFinite(brush.angle) ? brush.angle : 0) * Math.PI / 180;
    let ratio = brush.roundness === undefined ? 1 : brush.roundness / 100;
    ratio = Math.max(0.05, Math.min(1, ratio));
    const pressureSize = !!brush.pressureSize;
    const pressureOpacity = !!brush.pressureOpacity;
    const soft = Math.max(0, Math.min(1, 1 - hardness));

    const cdata = function (s) { return '<![CDATA[' + s + ']]>'; };
    const curve = '<![CDATA[<!DOCTYPE params> <params id="pressure"> <curve>0,0;1,1;</curve> </params> ]]>';

    const brushDef = '<Brush spacing="' + num(spacing, 0.1) + '" autoSpacingCoeff="1" angle="' + angleRad.toFixed(6) +
      '" BrushVersion="2" type="auto_brush" density="1" useAutoSpacing="1" randomness="0"> ' +
      '<MaskGenerator ratio="' + num(ratio, 1) + '" antialiasEdges="1" spikes="2" vfade="' + num(hardness, 1) +
      '" diameter="' + num(diameter, 40) + '" id="default" hfade="' + num(hardness, 1) + '" type="circle"/> </Brush> ';

    const params = [
      ['paintop', 'string', cdata('paintbrush')],
      ['brush_definition', 'string', cdata(brushDef)],
      ['Texture/Pattern/Enabled', 'string', cdata('false')],
      ['CompositeOp', 'string', cdata('normal')],
      ['EraserMode', 'string', cdata(brush.eraser ? 'true' : 'false')],
      ['OpacityValue', 'string', cdata(num(opacity, 1))],
      ['FlowValue', 'string', cdata(num(brush.flowPct === undefined ? 1 : brush.flowPct, 1))],
      ['PaintOpSettings/ignoreSpacing', 'string', cdata('false')],
      ['Sharpness/softness', 'string', cdata(num(soft, 0))],
      ['PressureSize', 'string', cdata(pressureSize ? 'true' : 'false')],
      ['PressureOpacity', 'string', cdata(pressureOpacity ? 'true' : 'false')],
      ['PressureSpacing', 'string', cdata('false')],
      ['SizeSensor', 'string', curve],
      ['SizeUseCurve', 'string', cdata('true')],
      ['SizeValue', 'string', cdata(pressureSize ? num(0.2, 0.2) : '1')],
      ['OpacitySensor', 'string', curve],
      ['OpacityUseCurve', 'string', cdata('true')],
      ['requiredBrushFile', 'string', cdata('')],
      ['requiredBrushFilesList', 'string', cdata('')]
    ];
    let xml = '<Preset name="' + name + '" paintopid="paintbrush"> ';
    for (const p of params) {
      xml += '<param name="' + p[0] + '" type="' + p[1] + '">' + p[2] + '</param> ';
    }
    xml += '</Preset>';

    let tip = brush.tip || null;
    const preview = png.encode(PREVIEW, PREVIEW, makePreview(tip));
    return png.injectText(preview, { version: '2.2', preset: asciiEntities(xml) });
  }

  function xmlEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function grayTip(tip) {
    if (!tip) return null;
    if (tip.data && tip.w && tip.h) return { w: tip.w, h: tip.h, data: tip.data };
    const w = tip.w, h = tip.h, rgba = tip.rgba;
    if (!w || !h || !rgba) return null;
    const gray = new Uint8Array(w * h);
    let hasAlpha = false;
    for (let i = 0; i < w * h; i++) { if (rgba[i * 4 + 3]) { hasAlpha = true; break; } }
    for (let i = 0; i < w * h; i++) {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
      const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      gray[i] = hasAlpha ? a : lum;
    }
    return { w: w, h: h, data: gray };
  }

  /* Preset XML using a procedural circle/ellipse mask (no external resource). */
  function circlePresetXml(brush) {
    const diameter = Math.max(1, Math.min(4000, brush.sizePx || 40));
    const spacing = Math.max(0.01, Math.min(5, (brush.spacingPct || 10) / 100));
    const opacity = Math.max(0, Math.min(1, brush.opacity === undefined ? 1 : brush.opacity));
    const hardness = Math.max(0, Math.min(1, brush.hardness === undefined ? 1 : brush.hardness));
    const angleRad = ((isFinite(brush.angle) ? brush.angle : 0) * Math.PI / 180).toFixed(6);
    let ratio = brush.roundness === undefined ? 1 : brush.roundness / 100;
    ratio = Math.max(0.05, Math.min(1, ratio));
    const pressureSize = !!brush.pressureSize;
    const pressureOpacity = !!brush.pressureOpacity;
    const cdata = function (s) { return '<![CDATA[' + s + ']]>'; };
    const curve = '<![CDATA[<!DOCTYPE params> <params id="pressure"> <curve>0,0;1,1;</curve> </params> ]]>';
    const brushDef = '<Brush spacing="' + spacing.toFixed(4) + '" autoSpacingCoeff="1" angle="' + angleRad +
      '" BrushVersion="2" type="auto_brush" density="1" useAutoSpacing="1" randomness="0"> ' +
      '<MaskGenerator ratio="' + ratio.toFixed(3) + '" antialiasEdges="1" spikes="2" vfade="' + hardness.toFixed(3) +
      '" diameter="' + diameter.toFixed(3) + '" id="default" hfade="' + hardness.toFixed(3) + '" type="circle"/> </Brush> ';
    const params = [
      ['paintop', 'string', cdata('paintbrush')],
      ['brush_definition', 'string', cdata(brushDef)],
      ['Texture/Pattern/Enabled', 'string', cdata('false')],
      ['CompositeOp', 'string', cdata('normal')],
      ['EraserMode', 'string', cdata(brush.eraser ? 'true' : 'false')],
      ['OpacityValue', 'string', cdata(opacity.toFixed(3))],
      ['FlowValue', 'string', cdata(Math.max(0, Math.min(1, brush.flowPct === undefined ? 1 : brush.flowPct)).toFixed(3))],
      ['ColorRateValue', 'string', cdata(Math.max(0, Math.min(1, brush.smudgeOn ? (brush.smudgeAmount === undefined ? 0.3 : brush.smudgeAmount) : 0)).toFixed(3))],
      ['ScatterValue', 'string', cdata((brush.scatterOn ? Math.max(0, Math.min(1, (brush.scatterPct || 0) / 100)) : 0).toFixed(3))],
      ['PaintOpSettings/ignoreSpacing', 'string', cdata('false')],
      ['PressureSize', 'string', cdata(pressureSize ? 'true' : 'false')],
      ['PressureOpacity', 'string', cdata(pressureOpacity ? 'true' : 'false')],
      ['PressureSpacing', 'string', cdata('false')],
      ['SizeSensor', 'string', curve],
      ['SizeUseCurve', 'string', cdata('true')],
      ['SizeValue', 'string', cdata((pressureSize ? Math.max(0.01, Math.min(1, brush.minSizeRatio === undefined ? 0.2 : brush.minSizeRatio)) : 1).toFixed(3))],
      ['OpacitySensor', 'string', curve],
      ['OpacityUseCurve', 'string', cdata('true')],
      ['requiredBrushFile', 'string', cdata('')],
      ['requiredBrushFilesList', 'string', cdata('')]
    ];
    let xml = '<Preset name="' + xmlEsc(brush.name || 'brush') + '" paintopid="paintbrush"> ';
    for (const p of params) xml += '<param name="' + p[0] + '" type="' + p[1] + '">' + p[2] + '</param> ';
    xml += '</Preset>';
    return asciiEntities(xml);
  }

  /* Preset XML for a bundle preset that references an image-brush resource. */
  function bundlePresetXml(brush, gbrName) {
    const spacing = Math.max(0.005, Math.min(5, (brush.spacingPct || 10) / 100));
    const opacity = Math.max(0, Math.min(1, brush.opacity === undefined ? 1 : brush.opacity));
    const angleRad = ((isFinite(brush.angle) ? brush.angle : 0) * Math.PI / 180).toFixed(6);
    const pressureSize = !!brush.pressureSize;
    const pressureOpacity = !!brush.pressureOpacity;
    const cdata = function (s) { return '<![CDATA[' + s + ']]>'; };
    const curve = '<![CDATA[<!DOCTYPE params> <params id="pressure"> <curve>0,0;1,1;</curve> </params> ]]>';
    const brushDef = '<Brush type="gbr_brush" BrushVersion="2" ColorAsMask="1" spacing="' + spacing.toFixed(4) +
      '" BrightnessAdjustment="0" AdjustmentMidPoint="127" useAutoSpacing="0" filename="' + xmlEsc(gbrName) +
      '" angle="' + angleRad + '" scale="1" brushApplication="0" ContrastAdjustment="0" autoSpacingCoeff="1"/>';
    const params = [
      ['paintop', 'string', cdata('paintbrush')],
      ['brush_definition', 'string', cdata(brushDef)],
      ['Texture/Pattern/Enabled', 'string', cdata('false')],
      ['CompositeOp', 'string', cdata('normal')],
      ['EraserMode', 'string', cdata(brush.eraser ? 'true' : 'false')],
      ['OpacityValue', 'string', cdata(opacity.toFixed(3))],
      ['FlowValue', 'string', cdata(Math.max(0, Math.min(1, brush.flowPct === undefined ? 1 : brush.flowPct)).toFixed(3))],
      ['PaintOpSettings/ignoreSpacing', 'string', cdata('false')],
      ['PressureSize', 'string', cdata(pressureSize ? 'true' : 'false')],
      ['PressureOpacity', 'string', cdata(pressureOpacity ? 'true' : 'false')],
      ['PressureSpacing', 'string', cdata('false')],
      ['SizeSensor', 'string', curve],
      ['SizeUseCurve', 'string', cdata('true')],
      ['SizeValue', 'string', cdata(pressureSize ? '0.200' : '1')],
      ['OpacitySensor', 'string', curve],
      ['OpacityUseCurve', 'string', cdata('true')],
      ['requiredBrushFile', 'string', cdata(gbrName)],
      ['requiredBrushFilesList', 'string', cdata(gbrName)]
    ];
    let xml = '<Preset name="' + xmlEsc(brush.name || 'brush') + '" paintopid="paintbrush"> ';
    for (const p of params) xml += '<param name="' + p[0] + '" type="' + p[1] + '">' + p[2] + '</param> ';
    xml += '</Preset>';
    return asciiEntities(xml);
  }


  /* PNG brush tip: Krita supports png_brush presets that reference a PNG resource. */
  /* Nearest-neighbour resize: keeps hard, jagged tip edges (bilinear
     resampling is what made the pencil look smooth in Krita). */
  function nearestResize(tip, n) {
    const { w, h, data } = tip;
    const out = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) {
      const sy = Math.min(h - 1, Math.floor(y * h / n));
      for (let x = 0; x < n; x++) {
        const sx = Math.min(w - 1, Math.floor(x * w / n));
        out[y * n + x] = data[sy * w + sx];
      }
    }
    return { w: n, h: n, data: out };
  }

  // Source speckles and low-alpha fibres may be intentional. Preserve them,
  // along with the source canvas and offset; do not guess which pixels are dirt.
  function prepareTipMask(tip) {
    return {w:tip.w,h:tip.h,data:new Uint8Array(tip.data)};
  }

  function pngTipPng(tip) {
    // Native AlphaMask applies inverse luminance as well as alpha: white RGB
    // produces no ink. Keep coverage in alpha and use black RGB (MASK3 native
    // import/stroke verified). Do not infer this from our alpha-only reader.
    const w = tip.w, h = tip.h;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 0; rgba[i * 4 + 1] = 0; rgba[i * 4 + 2] = 0;
      rgba[i * 4 + 3] = tip.data[i];
    }
    return png.encode(w, h, rgba);
  }

  function loadPresetTemplate() {
    if (pngPresetXml.tpl) return pngPresetXml.tpl;
    const xml = isNode ? require('./kritaPresetTemplate.js') : root.BC.kritaPresetTemplate;
    pngPresetXml.tpl = xml;
    return xml;
  }

  function loadPencilTemplate() {
    if (loadPencilTemplate.tpl) return loadPencilTemplate.tpl;
    const xml = isNode ? require('./kritaPresetTemplatePencil.js') : root.BC.kritaPresetTemplatePencil;
    loadPencilTemplate.tpl = xml;
    return xml;
  }

  function setParam(xml, name, value) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('<param\\b[^>]*name="' + esc + '"[^>]*>[\\s\\S]*?</param>');
    const repl = '<param type="string" name="' + name + '"><![CDATA[' + value + ']]></param>';
    if (re.test(xml)) return xml.replace(re, repl);
    return xml.replace('</Preset>', repl + '</Preset>');
  }

  /* Clone a real Krita png_brush preset and swap tip file / scale / spacing / opacity. */
  function pngPresetXml(brush, tipName, tipWidth, tipHeight, patternName) {
    const tpl = loadPresetTemplate();
    const spacing = Math.max(0.005, Math.min(5, (brush.spacingPct || 10) / 100));
    const opacity = Math.max(0, Math.min(1, brush.opacity === undefined ? 1 : brush.opacity));
    const angleRad = ((isFinite(brush.angle) ? brush.angle : 0) * Math.PI / 180).toFixed(6);
    const tipSide = Math.max(1, tipWidth || 200, tipHeight || tipWidth || 200);
    const scale = Math.max(0.01, Math.min(10, (brush.sizePx || 40) / tipSide));
    const def = '<Brush type="png_brush" brushApplication="0" ColorAsMask="1" BrushVersion="2" filename="' + tipName + '" scale="' + scale.toFixed(6) +
      '" spacing="' + spacing.toFixed(4) + '" angle="' + angleRad + '" useAutoSpacing="0"/>';
    let xml = tpl.replace(/name="[^"]*"/, 'name="' + xmlEsc(brush.name || 'brush') + '"');
    xml = setParam(xml, 'brush_definition', def);
    xml = setParam(xml, 'requiredBrushFile', tipName);
    xml = setParam(xml, 'requiredBrushFilesList', tipName);
    xml = setParam(xml, 'EraserMode', brush.eraser ? 'true' : 'false');
    xml = setParam(xml, 'CompositeOp', 'normal');
    xml = setParam(xml, 'OpacityValue', opacity.toFixed(3));
    xml = setParam(xml, 'FlowValue', Math.max(0, Math.min(1, brush.flowPct === undefined ? 1 : brush.flowPct)).toFixed(3));
    const pressureSize=brush.pressureSize===undefined?!!brush.pressure:!!brush.pressureSize;
    const pressureOpacity=!!brush.pressureOpacity;
    xml = setParam(xml,'PressureSize',String(pressureSize));
    xml = setParam(xml,'SizeUseCurve',String(pressureSize));
    xml = setParam(xml,'PressureOpacity',String(pressureOpacity));
    xml = setParam(xml,'OpacityUseCurve',String(pressureOpacity));
    if (brush.scatterOn) {
      xml = setParam(xml, 'ScatterValue', Math.max(0, Math.min(10, (brush.scatterPct || 0) / 100)).toFixed(3));
      xml = setParam(xml, 'Scatter/Enabled', 'true');
      xml = setParam(xml, 'Scatter/X', '1');
      xml = setParam(xml, 'Scatter/Y', brush.scatterBothAxes === false ? '0' : '1');
      if ((brush.scatterCount || 1) > 1) xml = setParam(xml, 'Scatter/Count', String(Math.round(brush.scatterCount)));
    }
    if (patternName) {
      xml = setParam(xml, 'Texture/Pattern/Enabled', 'true');
      xml = setParam(xml, 'Texture/Pattern/FileName', patternName);
      xml = setParam(xml, 'Texture/Pattern/Scale', (brush.textureScale === undefined ? 1 : brush.textureScale).toFixed(3));
      xml = setParam(xml, 'Texture/Pattern/Depth', (brush.textureDepth === undefined ? 0.5 : brush.textureDepth).toFixed(3));
      xml = setParam(xml, 'Texture/Pattern/Brightness', String(Math.round(brush.textureBrightness === undefined ? 51 : brush.textureBrightness)));
      xml = setParam(xml, 'Texture/Pattern/Contrast', String(Math.round(brush.textureContrast === undefined ? 100 : brush.textureContrast)));
    }
    return asciiEntities(xml);
  }

  function makePatternPng(seed, size) {
    const n = size || 512;
    const rgba = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let h = (x * 374761393 + y * 668265263 + seed * 2147483647) ^ 0x5bf03635;
        h = (h ^ (h >> 13)) * 1274126177; h = h ^ (h >> 16);
        const nz = ((h >>> 0) % 1000) / 999;
        const v = Math.round(255 * (0.55 + 0.45 * nz));
        const o = (y * n + x) * 4;
        rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
      }
    }
    return png.encode(n, n, rgba);
  }

  function presetPreviewPng(tip) {
    return png.encode(PREVIEW, PREVIEW, makePreview(tip));
  }

  /* Krita resource bundle (.bundle) containing brush tips (GBR) + presets. */
  function writeBundle(brushList, opts) {
    opts = opts || {};
    const zip = isNode ? require('./zip.js') : root.BC.zip;
    const list = brushList || [];
    const files = [];
    const manifest = [];
    const seen = {};
    let bundleIndex = 0;
    function unique(base, ext) {
      let n = base || 'brush';
      n = n.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'brush';
      let name = n + ext, i = 2;
      while (seen[name.toLowerCase()]) { name = n + '_' + i + ext; i++; }
      seen[name.toLowerCase()] = true;
      return name;
    }
    const previewTip = list.find(function (b) { return b && (b.tip || b.tipData); });
    const previewBrush = previewTip || list[0] || null;
    let previewPng;
    try { previewPng = presetPreviewPng(previewBrush && previewBrush.tip ? previewBrush.tip : null); }
    catch (e) { previewPng = png.encode(PREVIEW, PREVIEW, makePreview(null)); }

    for (const brush of list) {
      const base = brush.name || 'brush';
      const resourceId = util.md5(util.utf8Encode(util.brushFingerprint(brush))).slice(0, 20);
      const asciiBase = 'bc_mask3_' + resourceId + '_' + (++bundleIndex);
      // 还原优先：源是 .kpp 时直接复用它的预设 XML（只替换笔尖文件名）
      if (opts.fidelity !== false && !opts.forceRebuild && brush._rawXml && brush.tip) {
        const tipName = asciiBase + '_tip.png';
        const tipBytes = pngTipPng(prepareTipMask(grayTip(brush.tip)));
        files.push({ name: 'brushes/' + tipName, data: tipBytes });
        manifest.push({ path: 'brushes/' + tipName, type: 'brushes', md5: util.md5(tipBytes) });
        let xml = brush._rawXml;
        // Apply only explicit export overrides; retain other native XML fields.
        const scaleOverride=Number.isFinite(opts.sizeScale) && opts.sizeScale>0 && opts.sizeScale!==1;
        const spacingOverride=Number.isFinite(opts.spacingOverride) && opts.spacingOverride>0;
        const definition=collectParams(xml).brush_definition;
        if(definition) {
          const patched=definition.raw.replace(/<(?:Brush|MaskGenerator)\b[^>]*>/g,function(tag){
            if(scaleOverride){
              tag=tag.replace(/(\bdiameter=")([0-9.eE+-]+)(")/g,function(_,a,n,c){return a+(Number(n)*opts.sizeScale).toFixed(3)+c;});
              tag=tag.replace(/(\bscale=")([0-9.eE+-]+)(")/g,function(_,a,n,c){return a+(Number(n)*opts.sizeScale).toFixed(6)+c;});
            }
            if(spacingOverride){
              tag=tag.replace(/(\bspacing=")[^"]*(")/g,function(_,a,c){return a+(opts.spacingOverride/100).toFixed(4)+c;});
              tag=tag.replace(/\buseAutoSpacing="[^"]*"/g,'useAutoSpacing="0"');
            }
            tag=tag.replace(/\bfilename="[^"]*"/g,'filename="'+tipName+'"');
            return tag;
          });
          xml=setParam(xml,'brush_definition',patched);
        }
        if(opts.pressure!==undefined) {
          xml=setParam(xml,'PressureSize',String(!!brush.pressureSize));
          xml=setParam(xml,'SizeUseCurve',String(!!brush.pressureSize));
          xml=setParam(xml,'PressureOpacity',String(!!brush.pressureOpacity));
          xml=setParam(xml,'OpacityUseCurve',String(!!brush.pressureOpacity));
        }
        const oldName = (function () {
          const m = /requiredBrushFile">\s*<!\[CDATA\[([^\]]*)\]\]/.exec(xml) || /requiredBrushFile">([^<]*)</.exec(xml);
          return m ? m[1].trim() : '';
        })();
        if (oldName) xml = xml.split(oldName).join(tipName);
        const kppNameRaw = asciiBase + '.kpp';
        const kppBytesRaw = png.injectText(presetPreviewPng(brush.tip), { version: '2.2', preset: asciiEntities(xml) });
        files.push({ name: 'paintoppresets/' + kppNameRaw, data: kppBytesRaw });
        manifest.push({ path: 'paintoppresets/' + kppNameRaw, type: 'paintoppresets', md5: util.md5(kppBytesRaw) });
        continue;
      }
      const rawTip = grayTip(brush.tip);
      // Faithful conversion: keep the original tip resolution and orientation,
      // only remove stray specks + crop/center (fixes the thin-line artifact).
      const tip = rawTip ? prepareTipMask(rawTip) : null;
      let xml;
      if (tip) {
        const tipName = asciiBase + '_tip.png';
        const tipBytes = pngTipPng(tip);
        files.push({ name: 'brushes/' + tipName, data: tipBytes });
        manifest.push({ path: 'brushes/' + tipName, type: 'brushes', md5: util.md5(tipBytes) });
        let patternName = null;
        if (brush.hasTexture && opts.noTextureBake !== true) {
          patternName = asciiBase + '_tex.png';
          const patBytes = makePatternPng(bundleIndex + 17);
          files.push({ name: 'patterns/' + patternName, data: patBytes });
          manifest.push({ path: 'patterns/' + patternName, type: 'patterns', md5: util.md5(patBytes) });
        }
        xml = pngPresetXml(brush, tipName, tip.w, tip.h, patternName);
      } else {
        xml = circlePresetXml(brush);
      }
      const kppName = asciiBase + '.kpp';
      const kppBytes = png.injectText(presetPreviewPng(brush.tip), { version: '2.2', preset: xml });
      files.push({ name: 'paintoppresets/' + kppName, data: kppBytes });
      manifest.push({ path: 'paintoppresets/' + kppName, type: 'paintoppresets', md5: util.md5(kppBytes) });
    }

    const meta = '<?xml version="1.0" encoding="UTF-8"?>\n<meta:meta>\n <meta:generator>' + xmlEsc(opts.generator || 'BrushConverter') + '</meta:generator>\n <meta:bundle-version>1</meta:bundle-version>\n <dc:author>' + xmlEsc(opts.author || '') + '</dc:author>\n <dc:description>' + xmlEsc(opts.description || 'Converted brushes') + '</dc:description>\n</meta:meta>';
    let man = '<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">\n <manifest:file-entry manifest:media-type="application/x-krita-resourcebundle" manifest:full-path="/"/>\n';
    for (const m of manifest) {
      if (m.type === 'paintoppresets') {
        man += ' <manifest:file-entry manifest:media-type="paintoppresets" manifest:full-path="' + m.path + '" manifest:md5sum="' + m.md5 + '">\n' +
          '  <manifest:tags>\n   <manifest:tag>BrushConverter</manifest:tag>\n  </manifest:tags>\n </manifest:file-entry>\n';
      } else {
        man += ' <manifest:file-entry manifest:media-type="' + m.type + '" manifest:full-path="' + m.path + '" manifest:md5sum="' + m.md5 + '"/>\n';
      }
    }
    man += ' <manifest:file-entry manifest:media-type="image/png" manifest:full-path="preview.png" manifest:md5sum="' + util.md5(previewPng) + '"/>\n</manifest:manifest>';

    const head = [
      { name: 'mimetype', data: util.utf8Encode('application/x-krita-resourcebundle') },
      { name: 'meta.xml', data: util.utf8Encode(meta) },
      { name: 'META-INF/manifest.xml', data: util.utf8Encode(man) },
      { name: 'preview.png', data: previewPng }
    ];
    const all = head.concat(files);
    const bytes = zip.write(all);
    return { bytes: bytes, count: list.length, files: all.length };
  }

  const api = { isKpp, parseKpp, writeKpp, writeBundle };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { krita: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
