/* MyPaint brush format: .myb (JSON settings document) */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;

  function isMyb(bytes) {
    if (!bytes || bytes.length < 8) return false;
    // JSON object with a "settings" object
    let txt;
    try {
      txt = util.utf8Decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
    } catch (e) {
      return false;
    }
    const t = txt.replace(/^\uFEFF/, '').trim();
    if (t.charAt(0) !== '{') return false;
    return /"settings"\s*:/.test(txt) && /"(version|parent_brush_name|comment)"\s*:/.test(txt);
  }

  function num(settings, key, fallback) {
    const item = settings && settings[key];
    if (!item) return fallback;
    const v = typeof item === 'number' ? item : (item && typeof item.base_value === 'number' ? item.base_value : NaN);
    return isFinite(v) ? v : fallback;
  }

  function curveRange(settings, key) {
    const item = settings && settings[key];
    const inputs = item && item.inputs;
    const pressure = inputs && inputs.pressure;
    if (!pressure || !pressure.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const pt of pressure) {
      if (!pt || pt.length < 2) continue;
      if (pt[1] < lo) lo = pt[1];
      if (pt[1] > hi) hi = pt[1];
    }
    if (!isFinite(lo) || !isFinite(hi)) return null;
    return { lo: lo, hi: hi };
  }

  // libmypaint adds each input's curve value to base_value.
  function pressurePoints(settings, key) {
    const item=settings && settings[key], pts=item && item.inputs && item.inputs.pressure;
    return Array.isArray(pts) ? pts.filter(function(p){return Array.isArray(p) && p.length>=2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);}) : [];
  }
  function atPressure(settings, key, p, fallback) {
    const base=num(settings,key,fallback), pts=pressurePoints(settings,key);
    if(pts.length<2)return base;
    let i=1;
    while(i<pts.length-1 && p>pts[i][0])i++;
    const a=pts[i-1],b=pts[i];
    return base+(a[0]===b[0]?a[1]:a[1]+(b[1]-a[1])*(p-a[0])/(b[0]-a[0]));
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function parseMyb(bytes, fileName) {
    const warnings = [];
    let doc;
    try {
      doc = JSON.parse(util.utf8Decode(bytes));
    } catch (e) {
      throw new Error('MyPaint 笔刷 JSON 解析失败：' + e.message);
    }
    const settings = doc.settings || {};
    const radiusLog = num(settings, 'radius_logarithmic', 1.0);
    const radius = Math.exp(radiusLog);
    let sizePx = clamp(radius * 2, 1, 4000);
    const hardness = clamp(num(settings, 'hardness', 0.5), 0, 1);
    const opacityPoints=pressurePoints(settings,'opaque'), multiplyPoints=pressurePoints(settings,'opaque_multiply');
    // A tiny initial ramp is only a pen-up gate, not opacity dynamics.
    const gate=multiplyPoints.length>=3 && multiplyPoints[0][0]===0 && multiplyPoints[0][1]===0 &&
      multiplyPoints[1][0]>0 && multiplyPoints[1][0]<=0.0001;
    const minPressure=gate?multiplyPoints[1][0]:0;
    const pressures=[minPressure,1].concat(opacityPoints.concat(multiplyPoints).map(function(p){return p[0];}))
      .filter(function(p){return p>=minPressure && p<=1;});
    const opacities=pressures.map(function(p){return clamp(Math.max(0,atPressure(settings,'opaque',p,1))*atPressure(settings,'opaque_multiply',p,1),0,1);});
    const opacity=Math.max.apply(null,opacities), minOpacity=Math.min.apply(null,opacities);
    const dabs = num(settings, 'dabs_per_actual_radius', 5.82)+num(settings,'dabs_per_basic_radius',0);
    const spacingPct = clamp(100 / (2 * Math.max(0.05, dabs)), 1, 200);
    const smudge = num(settings, 'smudge', 0);
    const eraser = num(settings, 'eraser', 0);
    const ratio = num(settings, 'elliptical_dab_ratio', 1);
    const angle = num(settings, 'elliptical_dab_angle', 90);
    const roundness = clamp(100 / Math.max(1,ratio), 5, 100);
    const sizeCurve = curveRange(settings, 'radius_logarithmic');
    const opacityVaries = opacity-minOpacity>0.000001;
    let minSizeRatio = 1;
    let minOpacityRatio = 1;
    let pressure = false;
    if (sizeCurve) {
      const loR = Math.exp(sizeCurve.lo), hiR = Math.exp(sizeCurve.hi);
      if (hiR > loR) {
        minSizeRatio = clamp(loR / hiR, 0.02, 1);
        pressure = true;
      }
      sizePx=clamp(Math.exp(radiusLog+sizeCurve.hi)*2,1,4000);
    }
    if (opacityVaries) {
      minOpacityRatio = opacity>0 ? clamp(minOpacity/opacity,0,1) : 1;
      pressure = true;
    }
    // 本工具导出的文件用 parent_brush_name='brushconv/<名字>' 存显示名；真实 MyPaint 文件里
    // parent_brush_name 是内置父笔刷名（如 ink），应以文件名为主，避免整批被冠成同一个名字。
    const parentRaw = doc.parent_brush_name ? String(doc.parent_brush_name) : '';
    const parentName = parentRaw.split('/').pop();
    const name = (/^brushconv\//.test(parentRaw) ? parentName : (fileName || parentName || 'mypaint'))
      .replace(/\.[^.]+$/, '');
    if (smudge > 0.2) warnings.push('该 MyPaint 笔刷含涂抹/混色(smudge=' + smudge.toFixed(2) + ')，转换为普通笔刷时只保留基础形状');
    if (eraser > 0.5) warnings.push('该 MyPaint 笔刷是橡皮(eraser)，导入后需自行切换为橡皮模式');
    if(num(settings,'dabs_per_second',0)>0)warnings.push('该 MyPaint 笔刷含按时间喷点，静态间距只按基础/实际半径采样密度估算');
    const result = {
      brushes: [{
        name: name,
        tip: null,
        sizePx: sizePx,
        spacingPct: spacingPct,
        opacity: opacity,
        hardness: hardness,
        angle: angle,
        roundness: roundness,
        pressure: pressure,
        pressureSize: !!sizeCurve && sizeCurve.hi>sizeCurve.lo,
        minSizeRatio: minSizeRatio,
        pressureOpacity: opacityVaries,
        minOpacityRatio: minOpacityRatio,
        _rawMyb: bytes,
        source: 'mypaint'
      }],
      warnings: warnings
    };
    result.brushes[0]._rawBrushState = util.brushFingerprint(result.brushes[0]);
    return result;
  }

  function setting(base, inputs) {
    return { base_value: base, inputs: inputs || {} };
  }

  /* Write a minimal .myb from normalized brush params. */
  function writeMyb(brush) {
    const sizePx = Math.max(1, Math.min(4000, brush.sizePx || 40));
    const radius = sizePx / 2;
    const spacingPct = Math.max(1, Math.min(200, brush.spacingPct || 10));
    const dabs = 100 / (2 * spacingPct);
    const hardness = Math.max(0, Math.min(1, brush.hardness === undefined ? 0.7 : brush.hardness));
    const opacity = Math.max(0, Math.min(1, brush.opacity === undefined ? 1 : brush.opacity));
    const settings = {
      anti_aliasing: setting(1.0),
      change_color_h: setting(brush.colorDynamicsOn ? Math.max(0, Math.min(1, brush.colorJitterHue || 0)) : 0.0),
      change_color_hsl_s: setting(brush.colorDynamicsOn ? Math.max(0, Math.min(1, brush.colorJitterSat || 0)) : 0.0),
      change_color_hsv_s: setting(0.0),
      change_color_l: setting(0.0),
      change_color_v: setting(brush.colorDynamicsOn ? Math.max(0, Math.min(1, brush.colorJitterVal || 0)) : 0.0),
      color_h: setting(0.0),
      color_s: setting(0.0),
      color_v: setting(0.0),
      colorize: setting(0.0),
      custom_input: setting(0.0),
      custom_input_slowness: setting(0.0),
      dabs_per_actual_radius: setting(dabs),
      dabs_per_basic_radius: setting(0.0),
      dabs_per_second: setting(0.0),
      direction_filter: setting(2.0),
      elliptical_dab_angle: setting(brush.angle === undefined ? 90 : brush.angle),
      elliptical_dab_ratio: setting(100 / Math.max(10, Math.min(100, brush.roundness === undefined ? 100 : brush.roundness))),
      eraser: setting(0.0),
      hardness: setting(hardness),
      lock_alpha: setting(0.0),
      offset_by_random: setting(brush.scatterOn ? Math.max(0, Math.min(1, (brush.scatterPct || 0) / 100)) : 0.0),
      offset_by_speed: setting(0.0),
      offset_by_speed_slowness: setting(1.0),
      opaque: setting(opacity),
      opaque_linearize: setting(0.0),
      opaque_multiply: setting(0.0,{pressure:[[0,0],[0.0001,1],[1,1]]}),
      radius_by_random: setting(Math.max(0, Math.min(1, (brush.sizeJitterPct || 0) / 100))),
      radius_logarithmic: setting(Math.log(radius)),
      restore_color: setting(0.0),
      slow_tracking: setting(0.0),
      slow_tracking_per_dab: setting(0.0),
      smudge: setting(brush.smudgeOn ? Math.max(0.05, Math.min(1, brush.smudgeAmount === undefined ? 0.4 : brush.smudgeAmount)) : 0.0),
      smudge_length: setting(0.5),
      smudge_radius_log: setting(0.0),
      speed1_gamma: setting(1.0),
      speed1_slowness: setting(0.0),
      speed2_gamma: setting(1.0),
      speed2_slowness: setting(0.0),
      stroke_duration_logarithmic: setting(4.0),
      stroke_holdtime: setting(0.0),
      stroke_threshold: setting(0.0),
      tracking_noise: setting(0.0)
    };
    // pressure mapping for size / opacity
    if (brush.pressureSize === undefined ? brush.pressure : brush.pressureSize) {
      const lo = Math.log(Math.max(0.2, radius * Math.max(0.02, Math.min(1, brush.minSizeRatio === undefined ? 0.3 : brush.minSizeRatio))));
      const hi = Math.log(radius);
      if (hi > lo) {
        settings.radius_logarithmic.inputs = {
          pressure: [[0.0, lo-hi], [1.0, 0]]
        };
      }
    }
    if (brush.pressureOpacity) {
      const lo = Math.max(0, Math.min(1, brush.minOpacityRatio === undefined ? 0.3 : brush.minOpacityRatio));
      settings.opaque_multiply.inputs.pressure = [[0,0],[0.0001,lo],[0.5,1],[1,1]];
    }
    const doc = {
      comment: 'BrushConv exported MyPaint brush',
      group: '',
      parent_brush_name: 'brushconv/' + (brush.name || 'brush'),
      settings: settings,
      version: 3
    };
    return util.utf8Encode(JSON.stringify(doc, null, 1));
  }

  const api = { isMyb, parseMyb, writeMyb };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { mypaint: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
