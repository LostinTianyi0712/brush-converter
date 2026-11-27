/* BrushConv 目标引擎模型：画世界Pro 3.4.5（Phase 2，browser + node）
 *
 * 规范见 docs/IR_规范.md §0.2 / §3。
 * 这一层集中存放所有「画世界Pro 引擎行为补偿 / 图层路由 / 阈值」，按目标 + 版本隔离，
 * 使 core/ir.js 只装物理量、core/convert.js 只做流水线调度。
 *
 * 三根核心轴实测依据（第366轮，MuMu 画世界Pro 3.4.5）：
 *   1. scatter × cnt（14 支 × 2 次 = 28 条划笔，D=40 & D=100）：
 *      画世界扩宽系数 K_hsj 只随 cnt 变、完全不随 scatter 变（D=40/100 尺度不变）：
 *        cnt=1 → K_span=1.000 (K_95=0.99)
 *        cnt=3 → K_span=2.53  (K_95=2.29)
 *        cnt=6 → K_span=3.94  (K_95=3.51)
 *      结合 Procreate 侧 5 支多数量笔实测带宽，跨引擎折算收敛为单一连续函数 `1 / √cnt`，
 *      淘汰第355轮 `÷(1+0.55(cnt-1))` 与第363轮 `0.42→0.22` 分段冲突。
 *   2. textureScale / f24（6 支单变量条纹图，w=256..2048 × f24=0.5/1.0 × D=100/220）：
 *      精确恒等 `tile_px = tex_w × f24`（0.0px 误差，与笔径 sizePx 完全无关）。
 *   3. f123 ↔ 界面深度（6 档 256² 棋盘格，f123 = 0.00..0.95）：
 *      精确线性 `ink = f123 + (1 - f123) × tex = (1 - uiDepth) + uiDepth × tex`（0.002 误差）。
 *
 * 说明：因 build_bundles.js / hsj_missing_core_test.js / source_syntax_test.js 要求 core/ 扁平布局，
 * 引擎模型文件按 core/model-<target>.js 命名（语义对应 IR 规范里的 core/models/<target>.js）。
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const ir = isNode ? require('./ir.js') : (root.BC && root.BC.ir);
  const png = isNode ? require('./png.js') : (root.BC && root.BC.png);

  const m = {};

  m.ENGINE = {
    id: 'hsjpro',
    version: '3.4.5',
    calibratedDate: '2026-11-25'
  };

  /* ---------- 独立颗粒纹理层标定常量（第293/354/356/361/362/363轮） ---------- */
  m.BRU_MAX_SIZE_PX = 5000;
  m.GRAIN_LAYER_MIN_DEPTH = 0.75;
  m.GRAIN_LAYER_MAX_SPACING = 15;
  m.GRAIN_LAYER_DEPTH_RATIO = 0.69;
  m.GRAIN_LAYER_MAX_SRC_DEPTH = 1.0;
  m.GRAIN_LAYER_MAX_UI_DEPTH = 0.55;
  m.GRAIN_LAYER_HIRES_UI_DEPTH = 0.90;
  m.GRAIN_LAYER_MIN_SCALE = 0.1;

  /* ---------- 轴 1：scatter × cnt（第366轮 14 支实测标定） ----------
     画世界 Pro 3.4.5 实测 K_hsj(cnt) ≈ cnt^0.70（独立于 scatter 与 D）；
     Procreate 侧多数量极值扩散约 cnt^0.20；跨引擎比值 K_hsj / K_pc ≈ √cnt。 */
  m.scatterDivisorProcreate = function (cnt) {
    const n = Math.max(1, Math.round(Number(cnt) || 1));
    return n > 1 ? Math.sqrt(n) : 1;
  };

  m.compensateScatterPct = function (brush, opts, subFlatInk) {
    if (subFlatInk) return 0;
    if (!brush || brush.scatterPct === undefined) return undefined;
    let sc = 1;
    if (brush.source !== 'bru') {
      if (opts && opts.scatterScale !== undefined) sc = opts.scatterScale;
      else if (brush.source === 'abr') sc = 0.15;
      else if (brush.source === 'procreate' && !brush._bruExtra) {
        sc = 1 / m.scatterDivisorProcreate(brush.scatterCount);
      }
    }
    return Math.min(1000, brush.scatterPct * sc);
  };

  /* ---------- 轴 2：textureScale / f24（第366轮精确恒等 tile_px = tex_w × f24） ----------
     目标平铺周期 targetTilePx = refPx × brush.textureScale，
     再按画世界精确恒等式换算 f24 = targetTilePx / plainW。 */
  m.computeTextureScale = function (brush, plainW, opts) {
    if (!brush || !(plainW > 0)) return null;
    const isTexturized = !!(brush._params && Number(brush._params.textureApplication) === 1);
    const isHiRes = plainW >= 1024 && !!brush._params && !brush._bruExtra;
    const isDenseMultiplyWash = isHiRes && Number(brush.grainBlendMode) === 1 &&
      (brush.sizePx || 0) >= 60 && (Number(brush.spacingPct) || 99) <= 2;
    const sizeScale = (opts && opts.sizeScale) || 1;
    const refPx = (isHiRes && ((isTexturized && (brush.sizePx || 0) >= 40) || isDenseMultiplyWash))
      ? 900
      : (isTexturized ? 256 : Math.max(1, Math.min(m.BRU_MAX_SIZE_PX, (brush.sizePx || 100) * sizeScale)));
    const targetTilePx = refPx * (brush.textureScale || 1);
    return targetTilePx / plainW;
  };

  /* ---------- 轴 3：f123 ↔ 界面深度（第366轮精确线性 ink = f123 + (1-f123)×tex） ---------- */
  m.computeGrainUiDepth = function (brush, match) {
    let uiDepth = Math.max(0, Math.min(1, brush.textureDepth === undefined ? 1 : Number(brush.textureDepth) || 0));
    if (match && match.grainLayer) {
      if (match.uiDepthOverride > 0) {
        uiDepth = match.uiDepthOverride;
      } else {
        const hiResDeep = !!(brush._params && !brush._bruExtra && !match.fromSubGrain &&
          Number(brush._params.textureApplication) === 1 &&
          match.plain && match.plain.w >= 1024 && Number(brush.textureDepth) >= 0.90);
        const maxUi = hiResDeep ? m.GRAIN_LAYER_HIRES_UI_DEPTH : m.GRAIN_LAYER_MAX_UI_DEPTH;
        uiDepth = Math.min(maxUi, hiResDeep ? uiDepth * m.GRAIN_LAYER_HIRES_UI_DEPTH : uiDepth * m.GRAIN_LAYER_DEPTH_RATIO);
        uiDepth = Math.round(uiDepth * 10000) / 10000;
      }
    }
    return uiDepth;
  };

  m.depthToF123 = function (uiDepth) {
    const f123 = ir ? ir.depthToF123(uiDepth) : Math.max(0, Math.min(1, 1 - uiDepth));
    return Math.round(f123 * 10000) / 10000;
  };

  /* ---------- 纹理亮度 f35 与对比度 f33（第355/356/361/362/363轮） ---------- */
  m.bruTexBrightness = function (brush) {
    const v = brush && brush.textureBrightness;
    const fromBru = !!(brush && (brush.source === 'bru' || brush._bruTexParams || brush._nativeTexFromBru));
    if (v === undefined || !Number.isFinite(Number(v))) return ir ? ir.NEUTRAL.brightness : 51;
    const n = Number(v);
    if (fromBru) return Math.max(-100, Math.min(100, Math.round(n * 100) / 100));
    return Math.round(ir ? ir.canonicalBrightness(n, false) : Math.max(10, Math.min(100, 51 + n * 0.5)));
  };

  m.bruTexContrast = function (brush) {
    const v = brush && brush.textureContrast;
    const fromBru = !!(brush && (brush.source === 'bru' || brush._bruTexParams || brush._nativeTexFromBru));
    if (v === undefined || !Number.isFinite(Number(v))) return fromBru ? 100 : (ir ? ir.NEUTRAL.contrast : 0);
    const n = Number(v);
    return Math.max(fromBru ? -200 : -100, Math.min(100, Math.round(n * 100) / 100));
  };

  m.compensateTextureBrightness = function (brush, match, mappedGrainTone, absent35) {
    if (absent35) return undefined;
    if (match && match.neutralTone) return ir ? ir.NEUTRAL.brightness : 51;
    if (mappedGrainTone) {
      return Math.round(ir ? ir.canonicalBrightness(mappedGrainTone.brightness, false)
        : Math.max(10, Math.min(100, 51 + mappedGrainTone.brightness * 0.5)));
    }
    if (match && match.custom && !brush._nativeTexFromBru && !brush._bruTexParams) {
      const n = Number(brush.textureBrightness) || 0;
      return Math.round(ir ? ir.canonicalBrightness(n, false) : Math.max(10, Math.min(100, 51 + n * 0.5)));
    }
    return m.bruTexBrightness(brush);
  };

  m.compensateTextureContrast = function (brush, match, mappedGrainTone, absent33) {
    if (absent33) return undefined;
    if (match && match.neutralTone) return match.contrastOverride || 0;
    const clampFabricContrast = !!(match && match.grainLayer && brush._params && !brush._bruExtra &&
      Number(brush._params.textureApplication) === 1 && (Number(brush.grainBlendMode) === 8 || Number(brush.grainBlendMode) === 10));
    if (mappedGrainTone) {
      const c = Math.max(-100, Math.min(100, Math.round(mappedGrainTone.contrast)));
      return clampFabricContrast && c > 0 ? 0 : c;
    }
    if (match && match.custom && !brush._nativeTexFromBru && !brush._bruTexParams) {
      const c = Math.max(-100, Math.min(100, Math.round(Number(brush.textureContrast) || 0)));
      return clampFabricContrast && c > 0 ? 0 : c;
    }
    return m.bruTexContrast(brush);
  };

  /* ---------- 流量三项引擎补偿（第356/361/363轮） ----------
     ① 高散布/双笔密亮片（flow × 0.65）
     ② 单笔多数量云雾涂抹流量守恒（flow / cnt，下限 0.08）
     ③ 极低点距浅釉烘焙叠印补偿（min(flow, spacing × 0.2)，下限 0.05） */
  m.compensateFlowPct = function (brush, spacingPct, sizePx, textureBaked, bruPressure) {
    const baseFlow = brush.flowPct === undefined && bruPressure ? bruPressure.flow : brush.flowPct;
    const effFlow = baseFlow === undefined ? 1 : baseFlow;
    const cnt = Math.max(1, Math.round(Number(brush.scatterCount) || 1));
    const isDenseGlitter = brush.source === 'procreate' && !brush._bruExtra && !!brush._params &&
      cnt >= 5 && Number(brush.spacingPct) >= 15 && (!!brush.dualOn || Number(brush.scatterPct || 0) >= 40);
    if (isDenseGlitter) return Math.max(0.05, effFlow * 0.65);
    const isMultiCountCloud = brush.source === 'procreate' && !brush._bruExtra && !!brush._params &&
      !brush.dualOn && cnt >= 5 && spacingPct >= 4 && spacingPct < 15 &&
      !!brush._params.renderingModulatedTransfer && textureBaked && effFlow > 0.15 && effFlow <= 0.85;
    if (isMultiCountCloud) return Math.max(0.08, Math.round((effFlow / cnt) * 1000) / 1000);
    const isUltraDenseLightGlaze = brush.source === 'procreate' && !brush._bruExtra && !!brush._params &&
      !!brush._params.renderingMaxTransfer && !!brush._params.renderingModulatedTransfer &&
      !brush._params.renderingRecursiveMixing && Number(brush._params.textureApplication) === 0 &&
      textureBaked && spacingPct <= 0.5 && sizePx >= 30 && Number(brush.textureDepth) >= 0.99 && effFlow >= 0.5;
    if (isUltraDenseLightGlaze) return Math.max(0.05, Math.min(effFlow, Math.round(spacingPct * 200) / 1000));
    return baseFlow;
  };

  /* ---------- 低载荷浅釉不透明度补偿（第356轮） ---------- */
  m.compensateOpacity = function (brush, baseOp, match) {
    const isLowLoadGlaze = brush.source === 'procreate' && !brush._bruExtra && !!brush._params &&
      !!brush._params.renderingModulatedTransfer && Number(brush._params.dynamicsLoad) > 0 &&
      Number(brush._params.dynamicsLoad) <= 0.15 && Number(brush._params.dynamicsPressureOpacity) > 0.1 &&
      !(match && match.grainLayer);
    return isLowLoadGlaze ? Math.max(0.05, baseOp * 0.65) : baseOp;
  };

  /* ---------- 淡入淡出默认护栏 f134（第356轮）与方形笔触 f41（第289/350轮） ---------- */
  m.defaultFadeInOut = function (brush) {
    if (brush.bruFadeInOut !== undefined) return brush.bruFadeInOut;
    return (brush.source === 'procreate' && !brush._bruExtra && brush._params && !brush.taperOn) ? false : undefined;
  };

  m.inferSquareTip = function (brush, opts, isBinarySquareTip) {
    if (brush.bruSquareTip !== undefined) return !!brush.bruSquareTip;
    return brush.source !== 'bru' && (!opts || opts.fidelity !== false) && isBinarySquareTip(brush.tip);
  };

  /* ---------- 纹理统计、低方差拉伸、无缝程序化纸纹与颗粒层路由 ---------- */
  m.grainStd = function (plain) {
    if (!plain || !(plain.w >= 64) || !(plain.h >= 64) || !plain.gray) return 0;
    const g = plain.gray, n = g.length, step = Math.max(1, Math.floor(n / 65536));
    let s = 0, s2 = 0, k = 0;
    for (let i = 0; i < n; i += step) { s += g[i]; s2 += g[i] * g[i]; k++; }
    const mean = s / k;
    return Math.sqrt(Math.max(0, s2 / k - mean * mean));
  };

  m.grainHasPattern = function (plain) {
    return m.grainStd(plain) >= 8;
  };

  let _cachedProcPaperPng = null;
  m.proceduralPaperGrainPng = function () {
    if (_cachedProcPaperPng) return _cachedProcPaperPng;
    const n = 512;
    const hash = function (x, y, s) {
      let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    };
    const sample = function (x, y, period, seed) {
      const fx = (x / n) * period, fy = (y / n) * period;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const ux = tx * tx * (3 - 2 * tx), uy = ty * ty * (3 - 2 * ty);
      const xm0 = ((x0 % period) + period) % period, xm1 = (xm0 + 1) % period;
      const ym0 = ((y0 % period) + period) % period, ym1 = (ym0 + 1) % period;
      const a = hash(xm0, ym0, seed), b = hash(xm1, ym0, seed);
      const c = hash(xm0, ym1, seed), d = hash(xm1, ym1, seed);
      return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
    };
    const rgba = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = 0.22 * sample(x, y, 24, 1)
                + 0.30 * sample(x, y, 64, 2)
                + 0.28 * sample(x, y, 128, 3)
                + 0.20 * hash(x, y, 4);
        const g = Math.max(0, Math.min(255, Math.round((v - 0.5) * 340 + 145)));
        const o = (y * n + x) * 4;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = 255;
      }
    }
    _cachedProcPaperPng = png.encode(n, n, rgba);
    return _cachedProcPaperPng;
  };

  m.stretchLowStdGrainBytes = function (plain) {
    const g = plain.gray, n = g.length;
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[g[i]]++;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.02) { hi = v; break; } }
    const span = Math.max(1, hi - lo);
    const rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const v = Math.max(0, Math.min(255, Math.round((g[i] - lo) * 255 / span)));
      const o = i * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
      rgba[o + 3] = 255;
    }
    return png.encode(plain.w, plain.h, rgba);
  };

  m.isLargeBundledPaperBrush = function (brush, opts) {
    if (!brush || brush.source !== 'procreate' || brush._bruExtra || brush._nativeTexFromBru || !brush._params) return false;
    if (opts && (opts.bruGrainLayer === 'off' || opts.fidelity === false || opts.noTextureBake === true ||
        opts.bruTexMatch === 'off' || (opts.bruTexAsset && opts.bruTexAsset !== 'off'))) return false;
    if (Math.abs(Number(brush.textureRotation) || 0) > 1e-4) return false;
    if (Math.round(Number(brush.scatterCount) || 1) < 4 || (brush.sizePx || 0) < 200) return false;
    if (Number(brush.textureDepth) < 0.90 || !brush.textureInverted || Number(brush.grainBlendMode) !== 1) return false;
    if (!/paper|grain|noise|charcoal|parchment/i.test(String(brush.bundledGrainPath || ''))) return false;
    const sp = Number(brush.spacingPct);
    const spGate = Number.isFinite(Number(brush._params.plotSpacing)) ? sp / Math.SQRT2 : sp;
    if (!(spGate > 0 && spGate <= m.GRAIN_LAYER_MAX_SPACING)) return false;
    if (opts && opts.spacingOverride > m.GRAIN_LAYER_MAX_SPACING) return false;
    if (brush.dualOn && brush.dualTip && !brush.bruDualRefUuid && opts &&
        (opts.dualBake === false || opts.noDualBake === true)) return false;
    if (brush.embeddedSubPng && brush.embeddedSubPng.length) return false;
    return true;
  };

  m.grainLayerCandidate = function (brush, opts) {
    if (!brush || brush.source !== 'procreate' || brush._bruExtra || brush._nativeTexFromBru) return false;
    if (opts && (opts.bruGrainLayer === 'off' || opts.fidelity === false)) return false;
    if (!(Number(brush.textureDepth) >= m.GRAIN_LAYER_MIN_DEPTH)) return false;
    const appMode = brush._params ? Number(brush._params.textureApplication) : 0;
    const gbm = Number(brush.grainBlendMode);
    const isMultiplyTexturized = !!(brush._params && appMode === 1 && gbm === 1);
    const isCanvasFabricTexturized = !!(brush._params && appMode === 1 && (gbm === 8 || gbm === 10) &&
      brush._rawGrain && brush._rawGrain.length);
    if (!isMultiplyTexturized && !isCanvasFabricTexturized && Number(brush.textureDepth) >= m.GRAIN_LAYER_MAX_SRC_DEPTH) return false;
    const sp = Number(brush.spacingPct);
    const spForGate = (brush._params && Number.isFinite(Number(brush._params.plotSpacing))) ? sp / Math.SQRT2 : sp;
    if (!(spForGate > 0 && spForGate <= m.GRAIN_LAYER_MAX_SPACING)) return false;
    if (brush._params && appMode === 0 && Math.round(Number(brush.scatterCount) || 1) >= 4 &&
        Number(brush.scatterPct || 0) >= 30 && spForGate >= 10) return false;
    if (opts && opts.spacingOverride > m.GRAIN_LAYER_MAX_SPACING) return false;
    if (brush.dualOn && brush.dualTip && !brush.bruDualRefUuid && opts &&
        (opts.dualBake === false || opts.noDualBake === true)) return false;
    if (brush.embeddedSubPng && brush.embeddedSubPng.length) return false;
    return true;
  };

  if (typeof module !== 'undefined' && module.exports && typeof process !== 'undefined') module.exports = m;
  else root.BC = Object.assign(root.BC || {}, { modelHsjpro: m });
})(typeof globalThis !== 'undefined' ? globalThis : this);
