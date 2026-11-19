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
    if (item === undefined || item === null) return fallback;
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
    // 只剥本工具的前缀 'brushconv/'；不能 split('/').pop()，否则名字本身含 '/'（如「勾线/草稿」）会被截成后半截（#281）
    const parentName = parentRaw.replace(/^brushconv\//, '');
    const name = (/^brushconv\//.test(parentRaw) ? parentName : (fileName || parentName || 'mypaint'))
      .replace(/\.[^.]+$/, '');
    if (smudge > 0) warnings.push('MyPaint 混色比例已读取；跨引擎混色效果仍需验证');
    if (eraser > 0) warnings.push('MyPaint 橡皮模式已读取；不支持该模式的目标需手动切换橡皮工具');
    if(num(settings,'dabs_per_second',0)>0)warnings.push('该 MyPaint 笔刷含按时间喷点，静态间距只按基础/实际半径采样密度估算');
    const offsetRandom = Math.max(0, num(settings, 'offset_by_random', 0));
    const scatterPct = clamp(offsetRandom * 100, 0, 1000);
    const sizeJitterPct = clamp(Math.max(0, num(settings, 'radius_by_random', 0)) * 100, 0, 100);
    const colorJitterHue = clamp(Math.abs(num(settings, 'change_color_h', 0)), 0, 1);
    const colorJitterSat = clamp(Math.max(Math.abs(num(settings, 'change_color_hsl_s', 0)), Math.abs(num(settings, 'change_color_hsv_s', 0))), 0, 1);
    const colorJitterVal = clamp(Math.max(Math.abs(num(settings, 'change_color_v', 0)), Math.abs(num(settings, 'change_color_l', 0))), 0, 1);
    const colorDynamicsOn = colorJitterHue > 0.001 || colorJitterSat > 0.001 || colorJitterVal > 0.001;
    const smoothingStrength = clamp(Math.max(0, num(settings, 'slow_tracking', 0)) / 2, 0, 1);
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
        scatterOn: scatterPct > 0.01,
        scatterPct: scatterPct,
        sizeJitterPct: sizeJitterPct,
        colorDynamicsOn: colorDynamicsOn,
        colorJitterHue: colorJitterHue,
        colorJitterSat: colorJitterSat,
        colorJitterVal: colorJitterVal,
        smoothingStrength: smoothingStrength,
        smudgeOn: smudge > 0,
        smudgeAmount: clamp(smudge, 0, 1),
        eraser: eraser > 0,
        eraserAmount: eraser > 0 ? clamp(eraser, 0, 1) : undefined,
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

  function near(a, b, tol) {
    return Math.abs(a - b) <= (tol || 1e-4) * Math.max(1, Math.abs(a), Math.abs(b));
  }

  function deepEq(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (!a || !b || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return false;
      if (!deepEq(a[ka[i]], b[kb[i]])) return false;
    }
    return true;
  }

  /* 常数曲线不是「压感响应」而是固定偏移（或落笔门控）。关压感时把这类曲线
     一起摘掉会改笔刷外形，所以只在曲线真的随压感变化时才摘。 */
  function curveVaries(points) {
    if (!points || !points.length) return false;
    let lo = Infinity, hi = -Infinity;
    for (const p of points) {
      if (!p || p.length < 2 || !isFinite(p[1])) continue;
      if (p[1] < lo) lo = p[1];
      if (p[1] > hi) hi = p[1];
    }
    return isFinite(lo) && isFinite(hi) && hi - lo > 1e-9;
  }

  /* 【第302轮（作者：Claude）R302-04】Procreate 压感曲线工具：按 x 排序、折线求值、挑 ≤max 个采样点 */
  function procreateCurve(brush, key) {
    const all = brush && brush.procreatePressureCurves;
    const pts = all && all[key];
    if (!Array.isArray(pts) || pts.length < 2) return null;
    const out = pts.filter(function (p) { return Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]); })
      .map(function (p) { return [clamp(p[0], 0, 1), clamp(p[1], 0, 1)]; })
      .sort(function (a, b) { return a[0] - b[0]; });
    return out.length >= 2 ? out : null;
  }
  function curveAt(pts, x) {
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        const a = pts[i - 1], b = pts[i], span = b[0] - a[0];
        return span > 1e-12 ? a[1] + (b[1] - a[1]) * (x - a[0]) / span : b[1];
      }
    }
    return pts[pts.length - 1][1];
  }
  function curveXs(pts, max) {
    let xs = [0].concat(pts.map(function (p) { return p[0]; }), [1]);
    xs = xs.filter(function (x, i) { return xs.indexOf(x) === i; }).sort(function (a, b) { return a - b; });
    if (xs.length > max) {
      const keep = [];
      for (let i = 0; i < max; i++) keep.push(xs[Math.round(i * (xs.length - 1) / (max - 1))]);
      xs = keep.filter(function (x, i) { return keep.indexOf(x) === i; });
    }
    return xs;
  }

  function dropCurve(settings, key) {
    const cur = settings[key];
    if (cur && typeof cur === 'object' && cur.inputs && cur.inputs.pressure) delete cur.inputs.pressure;
  }

  function addCurve(settings, key, points) {
    const cur = settings[key];
    if (cur && typeof cur === 'object') {
      if (!cur.inputs) cur.inputs = {};
      cur.inputs.pressure = points;
    } else {
      settings[key] = { base_value: typeof cur === 'number' ? cur : 0, inputs: { pressure: points } };
    }
  }

  function setBase(settings, key, value) {
    const cur = settings[key];
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) { cur.base_value = value; return; }
    settings[key] = { base_value: value, inputs: {} };
  }

  /* 源文档缩进/结尾换行照抄，未改动时能逐字节还原 */
  function docLayout(text) {
    const m = /\n([ \t]+)/.exec(text);
    return {
      indent: m ? m[1] : '    ',
      eol: /\n$/.test(text) ? '\n' : '',
      /* MyPaint 自己的 writer 在逗号后留一个空格（`, \n`）：照抄这个习惯，
         改动过的笔刷重新导出时 diff 才只剩真正改了的字段 */
      commaSpace: /,\s\n/.test(text)
    };
  }

  /* 原位改写：源是 .myb 时只改「与 brush 参数对得上」的那几项，其余键（
     压感曲线、随机输入、元数据、MyPaint 新增设置）原样保留。
     直接整份重建会丢掉源文档 400+ 项（真实样本 Blender.myb 574 项只剩 154 项），
     压感/速度/角度曲线全没，等于把笔刷压扁成一个圆点。 */
  function patchMyb(brush, opts) {
    const raw = brush._rawMyb;
    const text = util.utf8Decode(raw);
    const doc = JSON.parse(text);
    if (!doc.settings || typeof doc.settings !== 'object') doc.settings = {};
    const settings = doc.settings;
    const src = parseMyb(raw).brushes[0];
    const layout = docLayout(text);

    /* 压感开关：pressureSize/pressureOpacity=false 表示「这次导出不要压感」，
       必须真把源曲线摘掉（否则强制关压感的导出会原样留下源曲线）。
       摘曲线时把曲线带来的偏移折进 base，否则尺寸/不透明度会跟着曲线一起飞。 */
    const sizePress = brush.pressureSize === undefined ? brush.pressure : brush.pressureSize;
    /* 不透明度这里只认「导出时明确要求关压感」：
       MyPaint 的 opaque_multiply 很多笔刷自带一个落笔门控曲线（0→1 立刻拉满），
       读侧算出来 pressureOpacity=false（因为整条笔刷不透明度不随压感变），
       拿它当「用户关掉了压感」去摘曲线，会把门控一起摘掉——落笔会多一个圆点。
       明确关压感只有一条可靠信号：调用方传了 opts.pressure === false。 */
    const opPress = (opts && opts.pressure === false) ? false : true;

    /* 半径：保留源曲线形状，只平移/缩放让顶部落在目标尺寸 */
    const sizePx = clamp(brush.sizePx === undefined ? src.sizePx : brush.sizePx, 1, 4000);
    const radius = sizePx / 2;
    const item = settings.radius_logarithmic;
    const pts = item && item.inputs && Array.isArray(item.inputs.pressure) && item.inputs.pressure.length
      ? item.inputs.pressure : null;
    let hi = 0, lo = 0;
    if (pts) {
      for (const p of pts) {
        if (!p || p.length < 2 || !isFinite(p[1])) continue;
        if (p[1] > hi) hi = p[1];
        if (p[1] < lo) lo = p[1];
      }
    }
    const baseOld = num(settings, 'radius_logarithmic', 1.0);
    const sizeCurveVaries = !!pts && hi - lo > 1e-9;
    /* 关压感且曲线确实在动：曲线摘掉，偏移折进 base。
       关压感但曲线是常数：曲线留着（那是固定偏移/门控），偏移照常折进 base。 */
    const baseNew = (sizePress === false && sizeCurveVaries)
      ? Math.log(radius)
      : Math.log(radius) - hi;
    /* 没改动就别碰：1e-16 的浮点噪声也算「改了」，会让未编辑的笔刷重新导出后
       与源文件不一致，还会把 diff 工具刷成红的。 */
    if (!near(baseNew, baseOld, 1e-12)) setBase(settings, 'radius_logarithmic', baseNew);
    if (pts && sizePress === false) {
      if (sizeCurveVaries) dropCurve(settings, 'radius_logarithmic');
    } else if (pts && hi - lo > 1e-9) {
      const minR = clamp(brush.minSizeRatio === undefined ? src.minSizeRatio : brush.minSizeRatio, 0.02, 1);
      const loNew = Math.log(radius * minR) - baseNew;
      const k = (hi - loNew) / (hi - lo);
      if (Math.abs(k - 1) > 1e-9 || Math.abs(loNew - lo) > 1e-9) {
        for (const p of pts) {
          if (p && p.length >= 2 && isFinite(p[1])) p[1] = loNew + (p[1] - lo) * k;
        }
      }
    } else if (!pts && sizePress === true) {
      const minR = clamp(brush.minSizeRatio === undefined ? src.minSizeRatio : brush.minSizeRatio, 0.02, 1);
      if (minR < 0.995) addCurve(settings, 'radius_logarithmic', [[0, Math.log(minR)], [1, 0]]);
    }

    /* 间距：dabs 总和换算，保留 dabs_per_basic_radius 原值 */
    const spacingPct = clamp(brush.spacingPct === undefined ? src.spacingPct : brush.spacingPct, 1, 200);
    const basic = num(settings, 'dabs_per_basic_radius', 0);
    const dabsNew = 100 / (2 * spacingPct) - basic;
    if (!near(dabsNew, num(settings, 'dabs_per_actual_radius', 5.82), 1e-9)) {
      setBase(settings, 'dabs_per_actual_radius', dabsNew);
    }

    /* 不透明度 */
    const opacity = clamp(brush.opacity === undefined ? src.opacity : brush.opacity, 0, 1);
    const minOp = clamp(brush.minOpacityRatio === undefined ? src.minOpacityRatio : brush.minOpacityRatio, 0, 1);
    if (opPress === false) {
      const mult = settings.opaque_multiply;
      const mp = mult && mult.inputs && Array.isArray(mult.inputs.pressure) ? mult.inputs.pressure : null;
      if (curveVaries(mp)) {
        dropCurve(settings, 'opaque_multiply');
        if (!near(num(settings, 'opaque_multiply', 1), 1, 1e-9)) setBase(settings, 'opaque_multiply', 1);
      }
      const op = settings.opaque;
      const opPts = op && op.inputs && Array.isArray(op.inputs.pressure) ? op.inputs.pressure : null;
      if (curveVaries(opPts)) dropCurve(settings, 'opaque');
      if (!near(num(settings, 'opaque', 1), opacity, 1e-9)) setBase(settings, 'opaque', opacity);
    } else {
      /* 按比例缩 base，曲线形状不动 */
      if (!near(opacity, src.opacity, 1e-4)) {
        const baseOp = num(settings, 'opaque', 1);
        const scaled = baseOp * (opacity / Math.max(1e-6, src.opacity));
        setBase(settings, 'opaque', clamp(scaled, 0, 1));
      }
      if (!near(minOp, src.minOpacityRatio, 2e-2) && src.minOpacityRatio > 1e-6) {
        const mult = settings.opaque_multiply;
        const mp = mult && mult.inputs && Array.isArray(mult.inputs.pressure) ? mult.inputs.pressure : null;
        const k = minOp / src.minOpacityRatio;
        if (mp && mp.length) {
          for (const p of mp) if (p && p.length >= 2 && isFinite(p[1])) p[1] = p[1] * k;
        } else if (mult && typeof mult === 'object') {
          addCurve(settings, 'opaque_multiply', [[0, 0], [0.0001, minOp], [0.5, 1], [1, 1]]);
        }
      }
    }

    const hardNew = clamp(brush.hardness === undefined ? src.hardness : brush.hardness, 0, 1);
    if (!near(hardNew, num(settings, 'hardness', src.hardness), 1e-12)) setBase(settings, 'hardness', hardNew);

    /* 散布：MyPaint 的 offset_by_random 是「半径倍数」，可以 >1（样本里 1.54），
       不能按百分比钳到 100 —— 那是重写路径的老 bug。 */
    const scatter = brush.scatterOn ? Math.max(0, Math.min(10, (brush.scatterPct || 0) / 100)) : 0;
    if (!near(scatter, num(settings, 'offset_by_random', 0), 1e-9)) setBase(settings, 'offset_by_random', scatter);
    const jitter = clamp(Math.max(0, brush.sizeJitterPct || 0) / 100, 0, 1);
    if (!near(jitter, num(settings, 'radius_by_random', 0), 1e-9)) setBase(settings, 'radius_by_random', jitter);

    if (brush.colorDynamicsOn !== undefined || brush.colorJitterHue !== undefined) {
      const hue = brush.colorDynamicsOn ? clamp(brush.colorJitterHue || 0, 0, 1) : 0;
      const sat = brush.colorDynamicsOn ? clamp(brush.colorJitterSat || 0, 0, 1) : 0;
      const val = brush.colorDynamicsOn ? clamp(brush.colorJitterVal || 0, 0, 1) : 0;
      setBase(settings, 'change_color_h', hue);
      setBase(settings, 'change_color_hsl_s', sat);
      setBase(settings, 'change_color_v', val);
    }
    if (brush.smoothingStrength !== undefined) {
      setBase(settings, 'slow_tracking', clamp(brush.smoothingStrength * 2, 0, 10));
    }
    if (brush.smudgeOn !== undefined) {
      setBase(settings, 'smudge', brush.smudgeOn ? clamp(brush.smudgeAmount === undefined ? 0.4 : brush.smudgeAmount, 0, 1) : 0);
    }
    if (brush.eraser !== undefined) {
      setBase(settings, 'eraser', brush.eraser ? clamp(brush.eraserAmount === undefined ? 1 : brush.eraserAmount, 0, 1) : 0);
    }
    if (brush.roundness !== undefined) {
      setBase(settings, 'elliptical_dab_ratio', 100 / Math.max(10, Math.min(100, brush.roundness)));
    }
    if (brush.angle !== undefined) setBase(settings, 'elliptical_dab_angle', brush.angle);

    /* parent_brush_name 在真实 MyPaint 文件里是「派生自哪支内置笔刷」（如 Dieterle/Blender），
       是分组语义，不能拿文件名覆盖。只有本工具自己写过前缀的文件才跟着改名。 */
    if (brush.name && brush.name !== src.name && /^brushconv\//.test(String(doc.parent_brush_name || ''))) {
      doc.parent_brush_name = 'brushconv/' + brush.name;
    }

    /* 语义没变就原样返回源字节：重排一次 JSON 会把 MyPaint 的 `0.0` 写成 `0`、
       浮点写成别的形式，未编辑的笔刷没必要承受这种噪声。 */
    if (deepEq(JSON.parse(text), doc)) return util.utf8Encode(text);

    let out = JSON.stringify(doc, null, layout.indent) + layout.eol;
    if (layout.commaSpace) out = out.replace(/,\n/g, ', \n');
    return util.utf8Encode(out);
  }

  /* Write a minimal .myb from normalized brush params. */
  function writeMyb(brush, opts) {
    if (brush && brush._rawMyb && brush._rawMyb.length) {
      try { return patchMyb(brush, opts); } catch (e) { /* 源文档结构异常：退回整份生成 */ }
    }
    return generateMyb(brush, opts);
  }

  function generateMyb(brush, opts) {
    const sizePx = Math.max(1, Math.min(4000, brush.sizePx || 40));
    const radius = sizePx / 2;
    const spacingPct = Math.max(1, Math.min(200, brush.spacingPct === undefined ? 10 : brush.spacingPct));
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
      eraser: setting(brush.eraser ? clamp(brush.eraserAmount === undefined ? 1 : brush.eraserAmount, 0, 1) : 0),
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
      slow_tracking: setting(Math.max(0, Math.min(10, (brush.smoothingStrength || 0) * 2))),
      slow_tracking_per_dab: setting(0.0),
      smudge: setting(brush.smudgeOn ? Math.max(0, Math.min(1, brush.smudgeAmount === undefined ? 0.4 : brush.smudgeAmount)) : 0.0),
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
    /* 【第302轮（作者：Claude）R302-04】源是 Procreate 且带自定义「压力 → 尺寸/不透明度」曲线时，
       按曲线形状取点（最多 8 点，MyPaint 每条输入的上限），否则保持原来的直线。
       语义按「最小值 + (1 - 最小值) × 曲线」近似，Procreate 曲线本身是平滑样条，这里按折线取样。 */
    const sizeCurve = procreateCurve(brush, 'dynamicsPressureSizeCurve');
    const opacityCurve = procreateCurve(brush, 'dynamicsPressureOpacityCurve');
    if (brush.pressureSize === undefined ? brush.pressure : brush.pressureSize) {
      const minR = Math.max(0.02, Math.min(1, brush.minSizeRatio === undefined ? 0.3 : brush.minSizeRatio));
      const lo = Math.log(Math.max(0.2, radius * minR));
      const hi = Math.log(radius);
      if (sizeCurve && hi > lo) {
        const floor = Math.exp(lo - hi);
        settings.radius_logarithmic.inputs = {
          pressure: curveXs(sizeCurve, 8).map(function (x) {
            return [x, Math.log(Math.max(floor, minR + (1 - minR) * curveAt(sizeCurve, x)))];
          })
        };
      } else if (hi > lo) {
        settings.radius_logarithmic.inputs = {
          pressure: [[0.0, lo-hi], [1.0, 0]]
        };
      }
    }
    if (brush.pressureOpacity) {
      const lo = Math.max(0, Math.min(1, brush.minOpacityRatio === undefined ? 0.3 : brush.minOpacityRatio));
      if (opacityCurve) {
        /* 第一个点 (0,0) 是落笔门控（压力为 0 不出墨），保留 */
        const xs = curveXs(opacityCurve, 7).map(function (x) { return x <= 0 ? 0.0001 : x; });
        settings.opaque_multiply.inputs.pressure = [[0, 0]].concat(xs.map(function (x) {
          return [x, Math.max(0, Math.min(1, lo + (1 - lo) * curveAt(opacityCurve, x)))];
        }));
      } else {
        settings.opaque_multiply.inputs.pressure = [[0,0],[0.0001,lo],[0.5,1],[1,1]];
      }
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
