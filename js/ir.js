/* BrushConv IR（中间值）—— Phase 1 影子层（browser + node）
 *
 * 规范见 docs/IR_规范.md。这一层**只装物理量**：单位、量程、中性写死；
 * 任何「某个 App 会怎么歪」的补偿系数都不许进来（那是 core/models/<target>.js 的事）。
 *
 * Phase 1 的定位：**影子模式**。生产代码不调用它；由 test/ir_shadow_test.js 拿它和真实
 * 写出结果逐项比对，用来发现「有人改了 convert.js 的换算式但没同步这里」的漂移。
 * 它证明的是**两处实现一致**，不是「标定正确」——后者只能靠真机读数。
 */
(function (root) {
  'use strict';

  const ir = {};

  /* ---------- 画世界的硬边界（与 convert.js 同值，改一处必须改两处，影子测试会拦） ---------- */
  ir.BRU_MIN_SPACING_PCT = 0.1;   // 间距下限，低于它按 0.1% 写（第351轮真机：界面最小显示 1%）
  ir.BRU_AUTO_SPACING_PCT = 10;   // 源 spacing = 0（Procreate 的「自动间距」）按 10% 写
  ir.BRU_MAX_SPACING_PCT = 1000;

  /* ---------- 中性值与量程（§1） ---------- */
  ir.NEUTRAL = {
    brightness: 51,   // f35：0..100，51 中性，越大越深（第362轮三点真机）
    contrast: 0,      // f33：-100..100，0 中性（第355轮）
    textureDepth: 0   // 界面深度：0 = 无纹理
  };
  ir.RANGE = {
    angle: [0, 360],          // 360 ≡ 0，但**不许擅自折成 0**（原生 BRU 存在 360，第351轮踩过）
    spacing: [0, 1000],
    scatter: [0, 1000],
    scatterCount: [1, 16],
    roundness: [0, 100],
    unit: [0, 1],             // opacity / flow / minRatio / secondaryAmount
    brightness: [-100, 100],
    contrast: [-200, 100],    // BRU 源历史上有 < -100 的绝对值
    textureDepth: [0, 1]
  };

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : undefined; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function inRange(v, r) { return v >= r[0] && v <= r[1]; }

  /* 角度归一化：只折 <0 或 >360，[0,360] 一律原样（含 360）。
     与 convert.js 的 normAngle360 用法一致；写成独立函数是为了让「谁在哪一步折」有唯一答案。 */
  ir.normalizeAngle = function (deg) {
    const n = num(deg);
    if (n === undefined) return undefined;
    if (n >= 0 && n <= 360) return n;
    return ((n % 360) + 360) % 360;
  };

  /* 间距：把「源值」翻译成物理量，并记录这次翻译用到了哪条约定。
     返回 { pct, auto } —— auto=true 表示源是「自动间距」，pct 是按约定落到的值。 */
  ir.canonicalSpacing = function (spacingPct) {
    const raw = num(spacingPct);
    const notes = [];
    if (raw === undefined) { notes.push('missing'); return { pct: undefined, auto: false, notes: notes }; }
    let pct = raw;
    let auto = false;
    if (!(pct > 0)) { auto = true; pct = ir.BRU_AUTO_SPACING_PCT; notes.push('auto→' + pct); }
    else if (pct < ir.BRU_MIN_SPACING_PCT) { pct = ir.BRU_MIN_SPACING_PCT; notes.push('floor→' + pct); }
    pct = clamp(pct, 0, ir.BRU_MAX_SPACING_PCT);
    return { pct: pct, auto: auto, notes: notes };
  };

  /* 纹理亮度（f35）。非 BRU 源：51 + b*0.5（第362轮）；BRU 源/往返：原样。
     fromBru 由调用方给，因为它取决于来源标记（_bruTexParams / _nativeTexFromBru）。 */
  ir.canonicalBrightness = function (v, fromBru) {
    const n = num(v);
    if (n === undefined) return fromBru ? ir.NEUTRAL.brightness : ir.NEUTRAL.brightness;
    if (fromBru) return n;
    return clamp(51 + n * 0.5, 10, 100);
  };
  ir.canonicalContrast = function (v, fromBru) {
    const n = num(v);
    if (n === undefined) return ir.NEUTRAL.contrast;
    if (fromBru) return n;
    return clamp(n, -100, 100);
  };

  /* 纹理深度：IR 存的是**界面深度**（0=无、1=满），而画世界 f123 存 `1 − 界面深度`。 */
  ir.depthToF123 = function (depth) { const n = num(depth); return n === undefined ? undefined : clamp(1 - n, 0, 1); };
  ir.f123ToDepth = function (f123) { const n = num(f123); return n === undefined ? undefined : clamp(1 - n, 0, 1); };

  /* 副色强度：IR 存**线性混合比**；画世界 f109 直出，Procreate 出口才做 ^(1/2.2)（第341/348轮）。 */
  ir.canonicalSecondary = function (v) { const n = num(v); return n === undefined ? 0 : clamp(n, 0, 1); };
  ir.secondaryToProcreate = function (v) { const n = ir.canonicalSecondary(v); return Math.pow(n, 1 / 2.2); };

  /* ---------- 从「已解析的笔刷对象」读出规范值 ----------
     只翻译**单位/口径**；不去猜引擎补偿（flow 的三条画世界补偿仍留在 convert.js，
     这里把读到的 flow 原样带出并标 compensated，避免假装它是干净的物理值）。 */
  ir.fromBrush = function (brush) {
    if (!brush) return null;
    const fromBru = !!(brush.source === 'bru' || brush._bruTexParams || brush._nativeTexFromBru);
    const notes = [];
    const rawAngle = num(brush.angle);
    const angle = ir.normalizeAngle(rawAngle);
    if (rawAngle !== undefined && angle !== rawAngle) notes.push('angle ' + rawAngle + '→' + angle);
    const sp = ir.canonicalSpacing(brush.spacingPct);
    for (const n of sp.notes) notes.push('spacing ' + n);
    if (num(brush.textureDepth) !== undefined) notes.push('textureDepth 按 f123 口径存储（界面深度 = 1 − ' + num(brush.textureDepth) + '）');
    return {
      size: num(brush.sizePx),
      spacing: sp.pct,
      spacingAuto: sp.auto,
      scatter: num(brush.scatterPct),
      scatterCount: num(brush.scatterCount),
      angle: angle,
      roundness: num(brush.roundness),
      opacity: num(brush.opacity),
      /* flow 在 BRU 读回的对象上已经是「补偿后」的值；这里不做反解，只标出来 */
      flow: num(brush.flowPct),
      flowCompensated: fromBru ? 'unknown' : false,
      texture: {
        has: !!brush.hasTexture,
        depth: ir.f123ToDepth(brush.textureDepth),
        brightness: ir.canonicalBrightness(brush.textureBrightness, fromBru),
        contrast: ir.canonicalContrast(brush.textureContrast, fromBru),
        scale: num(brush.textureScale)
      },
      color: { secondaryAmount: ir.canonicalSecondary(brush.secondaryColorAmount !== undefined ? brush.secondaryColorAmount : brush.colorJitterFgBg) },
      fromBru: fromBru,
      notes: notes
    };
  };

  /* ---------- 规范值 → 画世界写出侧应有的数值（含钳位，不含补偿） ----------
     给影子测试比对用；Phase 2 才会成为真正的 emit 路径。 */
  ir.toBruNumbers = function (c) {
    if (!c) return null;
    return {
      spacingPct: c.spacing,
      angle: c.angle,
      f123: ir.depthToF123(c.texture.depth),
      f35: c.texture.brightness,
      f33: c.texture.contrast,
      f109: c.color.secondaryAmount
    };
  };

  /* ---------- 不变量检查 ---------- */
  ir.violations = function (c) {
    const out = [];
    if (!c) return out;
    const chk = function (name, v, r) {
      if (num(v) === undefined) return;
      if (!inRange(v, r)) out.push({ field: name, value: v, range: r });
    };
    chk('angle', c.angle, ir.RANGE.angle);
    chk('spacing', c.spacing, [ir.BRU_MIN_SPACING_PCT, ir.BRU_MAX_SPACING_PCT]);
    chk('scatter', c.scatter, ir.RANGE.scatter);
    chk('scatterCount', c.scatterCount, ir.RANGE.scatterCount);
    chk('roundness', c.roundness, ir.RANGE.roundness);
    chk('opacity', c.opacity, ir.RANGE.unit);
    chk('flow', c.flow, ir.RANGE.unit);
    chk('texture.depth', c.texture.depth, ir.RANGE.textureDepth);
    chk('texture.brightness', c.texture.brightness, ir.RANGE.brightness);
    chk('texture.contrast', c.texture.contrast, ir.RANGE.contrast);
    chk('color.secondaryAmount', c.color.secondaryAmount, ir.RANGE.unit);
    return out;
  };

  if (typeof module !== 'undefined' && module.exports && typeof process !== 'undefined') module.exports = ir;
  else root.BC = Object.assign(root.BC || {}, { ir: ir });
})(typeof globalThis !== 'undefined' ? globalThis : this);
