﻿/* 画世界Pro .bru container + Brush protobuf reader/writer */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const png = isNode ? require('./png.js') : root.BC.png;
  function decodeBrushImage(bytes) {
    const jpeg = isNode ? require('./jpeg.js') : root.BC.jpeg;
    return jpeg && jpeg.isJpeg(bytes) ? jpeg.decode(bytes) : png.decode(bytes);
  }

  const MAGIC = 'hsjbru';

  // Android 3.4.5 dual-brush menu order. Native exports establish f122:
  // normal omits it (0); changing only to Hard Mix adds d0 07 08 (122 = 8).
  const DUAL_BLEND_NAMES = ['normal', 'multiply', 'darken', 'colorBurn', 'linearBurn',
    'lighten', 'colorDodge', 'overlay', 'hardMix', 'difference', 'subtract', 'divide', 'linearHeight'];
  const PRO_DUAL_BLEND_NAMES = ['normal', 'darken', 'multiply', 'colorBurn', 'linearBurn',
    'lighten', 'screen', 'hardMix', 'overlay', 'softLight', 'hardLight', 'difference'];
  function dualBlendName(value) {
    return DUAL_BLEND_NAMES[value];
  }
  function dualBlendValue(value, fallback) {
    if (typeof value === 'number') value = PRO_DUAL_BLEND_NAMES[value];
    const aliases = { nrml: 'normal', mltp: 'multiply', drkn: 'darken', cbrn: 'colorburn',
      lghn: 'lighten', cddg: 'colordodge', ovrl: 'overlay', hmix: 'hardmix', dfrn: 'difference' };
    let key = String(value === undefined ? '' : value).toLowerCase().replace(/[^a-z]/g, '');
    key = aliases[key] || key;
    const index = DUAL_BLEND_NAMES.findIndex(function (name) { return name.toLowerCase() === key; });
    return index >= 0 ? index : (typeof fallback === 'number' ? fallback : 0);
  }

  /* ---------- protobuf primitives ---------- */
  /* Varint for protobuf uint64. No BigInt / BigInt literals: must stay
     parseable by Chrome 61 (ES2017). Negative numbers are encoded as their
     two's-complement 64-bit value (always 10 bytes), matching protobuf. */
  function encVarint(v) {
    if (v >= 0 && v <= Number.MAX_SAFE_INTEGER) {
      const out = [];
      while (v >= 128) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
      out.push(v);
      return out;
    }
    // unsigned 64-bit halves
    let lo, hi;
    if (v >= 0) {
      lo = v % 4294967296;
      hi = Math.floor(v / 4294967296);
    } else {
      const neg = -v; // v >= -Number.MAX_SAFE_INTEGER
      const negLo = neg % 4294967296;
      const negHi = Math.floor(neg / 4294967296);
      lo = negLo === 0 ? 0 : 4294967296 - negLo;
      hi = (4294967296 - negHi - (negLo === 0 ? 0 : 1)) % 4294967296;
    }
    const out = [];
    for (;;) {
      const more = hi !== 0 || lo > 0x7f;
      out.push((lo & 0x7f) | (more ? 0x80 : 0));
      lo = ((lo >>> 7) | ((hi & 0x7f) << 25)) >>> 0;
      hi = hi >>> 7;
      if (!more) break;
    }
    return out;
  }
  // 画世界Pro 3.0 双笔刷引用消息模板（取自真实双笔刷 BRU 的 f121；只替换前两个 UUID）
  const DUAL_LINK_TEMPLATE_B64 = 'CiRlMjliODQwOS1iNTE0LTRjODgtYTY0Ny05NDVkNDg0NGI1MzkSJGU1MjJjYTczLWE0NWItNDM1OC1hMmNlLTdlZGNjYTA2YzUxYRoG5bmy5p+TIglpY29ucy95emIoATIFcHQxMzI6BXBzMTE2RR6FB0JNAACwQV0AAIA/ZQAA+kNtAACAP3X1KNw+gAGAgID4//////8BjQEK16M9mAEBrQEAALRCtQEAAIA/vQEAAIA/xQEAAAA/zQEAAIA/1QG4HgU+4AEB6AEB+AEBiAL3//////////8BmALp//////////8BoAIBqAIfyAIB0gIAiAMBlQPMzEw+qAMVwAMByAMB1QMAAMA/2AMCiAQB0AQB3QQAAABB5QQBAABB7QQAAIA/9QQAAIA/+AQBjQUAAIA/kAWs4Lj4//////8BmAUBoAUN0AUBiAYBoAYBrQYAAIA/mAcCwgcWOWU0dXJaWkhTNmFsUlpKVThtb1FHQdAHAd0HUrheP4AIAZ0IAACAP6UIAAC0Q70IAACAP8UImpkZP+gIAYUJAACAP5AJAfUJAAC0Qg==';
  function dualLinkTemplate() {
    const bin = isNode ? new Uint8Array(Buffer.from(DUAL_LINK_TEMPLATE_B64, 'base64')) : (function () { const s2 = atob(DUAL_LINK_TEMPLATE_B64); const out = new Uint8Array(s2.length); for (let i = 0; i < s2.length; i++) out[i] = s2.charCodeAt(i); return out; })();
    return bin;
  }

  function tag(field, wt) { return encVarint(field * 8 + wt); }
  function fVarint(field, v) { return tag(field, 0).concat(encVarint(v)); }
  function fF32(field, v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    return tag(field, 5).concat(Array.from(b));
  }
  function fBytes(field, bytes) {
    return tag(field, 2).concat(encVarint(bytes.length), Array.from(bytes));
  }
  function u8arr(arr) { return new Uint8Array(arr); }

  /* 【第232轮·field-matrix】BRU 已知字段号白名单 = 写侧（buildMetadata 里 fVarint/fF32/fBytes(N,)
     的静态扫描，89 个）∪ 读侧（pushBrush 里 o[N] 的静态扫描）——来源与明细见
     _probe/field-matrix/extract.js（_probe/field-matrix/report.md §5 D 表）。
     白名单之外的字段号视为「未知字段」：解析时保留原始 wire 字节（tag+payload，_rawUnknown），
     重建写 meta 时原样追加，不再静默丢弃（f54 作者署名 199 支、f128 引擎 148 支、f107 108 支…）。
     新增已知字段后请同步更新此表（extract.js 可重新生成）；漏了也不会写坏——buildMetadata
     会跳过本次已写出的字段号，不会重复。 */
  const BRU_KNOWN_FIELDS = new Set([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
    28, 29, 31, 32, 33, 35, 36, 37, 42, 43, 44, 47, 49, 50, 51, 56, 57, 58, 59, 60, 61, 62, 63, 64,
    65, 67, 74, 77, 78, 79, 80, 81, 82, 83, 84, 87, 90, 92, 93, 94, 95, 96, 97, 99, 100, 101, 103,
    104, 109, 115, 117, 119, 120, 121, 122, 123, 129, 134, 135, 136, 138, 139, 158
  ]);

  /* ---------- metadata builder (validated against 画世界Pro Android) ---------- */
  function buildMetadata(b) {
    const parts = [];
    const nameBytes = util.utf8Encode(b.name || 'brush');
    parts.push(u8arr(fBytes(1, util.utf8Encode(util.uid()))));   // ID
    parts.push(u8arr(fBytes(2, util.utf8Encode(b.pkgId || util.uid())))); // PKGID
    parts.push(u8arr(fBytes(3, nameBytes)));                    // NAME
    parts.push(u8arr(fBytes(4, util.utf8Encode('icons/yzb')))); // ICONPATH (cosmetic)
    parts.push(u8arr(fVarint(5, 1)));                           // ISVISIBLE
    // f6 = TEXTUREASSET：引用 App 内置纹理库的资源 id（真机导出样本里是 pt24=沙纸）。
    // 只写 f28 开关不带 id，App 拿空纹理渲染 → 笔迹几乎不出墨；带上 id 才会按文档空间采样颗粒。
    if (b.texAssetId) parts.push(u8arr(fBytes(6, util.utf8Encode(String(b.texAssetId)))));
    /* 【第206轮 R204-02（作者：Claude）】noShape = 不带笔尖图、用 App 程序化圆头（画世界官方「小方块」
       450B 的结构：无 f7、无 f31、容器图长 = 0xFFFFFFFF）。只允许单支 writeBrush。 */
    if (!b.noShape) parts.push(u8arr(fBytes(7, util.utf8Encode(b.texId))));     // MASKTEXPATH (image id)
    /* 第181轮：f119（双笔刷开关）改为**无条件显式写出**。
       以前只在「内嵌副笔」分支里写，单笔/烘焙后的笔刷根本没有这个字段，App 走缺省值；
       而 Procreate 双笔转出来的笔刷笔尖里已经烘了一层副笔，缺省值把双笔打开就变成
       同一笔落两次墨（黄土笔刷实测的「重影」）。
       判定：确实挂着副笔（内嵌 PNG 或引用 UUID）且没被显式关掉，才写 1，其余写 0。 */
    const dualFlag = (!!(b.bruDualSubBrush || b.bruDualRefUuid) && b.bruDualEnabled !== false) ? 1 : 0;
    parts.push(u8arr(fVarint(119, dualFlag)));
    const size = Math.max(1, Math.min(5000, b.sizePx || 100));
    const maxSize=Math.max(size,b.maxSizePx||500);
    /* 【第192轮】minSizeRatio 不能写 0。
       真实画世界原生 BRU 里 f50（MINWIDTHPERCENT）从不出现 0：实测「压感硬圆.bru」
       是 0.033（f9=1px / f8=30px）、双笔样本是 0.5。而 Procreate 里 dynamicsPressureSize=1
       的笔刷会算出 minSizeRatio=0（例如「吹石-圆笔 润」），照原样写就是 f9=0、f50=0——
       App 侧把 0 视作「未设置最小宽度」退回默认值，压感就表现为不生效。
       0.01（1% 宽度）在视觉上仍是完全收尖，但不会再撞到这个边界值。
       注意只钳下限，无压感的笔刷（minSizeRatio=1）不受影响。 */
    /* 【第192轮调查结论·暂不钳制】曾尝试把 minSizeRatio=0 钳到 0.01（依据：真实画世界 BRU
       的 f50 从不出现 0）。实测会破坏既有约定「仅透明度压感不得变成大小压感」
       （fidelity 用例锁着），且无法在 App 端证实 0 会被当成无效值，故退回原样写出。
       若要再动，必须先拿到「同一支笔刷在画世界原生导出」的 BRU 做字段级对照。 */
    const minSize = Math.max(0, Math.min(1, b.minSizeRatio === undefined ? 1 : b.minSizeRatio));
    const opacity = Math.max(0, Math.min(1, b.opacity === undefined ? 1 : b.opacity));
    const minOp = Math.max(0, Math.min(1, b.minOpacityRatio === undefined ? 1 : b.minOpacityRatio));
    parts.push(u8arr(fF32(8, size)));                           // WIDTH
    parts.push(u8arr(fF32(9, size * minSize)));                 // SMALLWIDTH (零压感宽度)
    if (!b.bruLegacyMinWidth) parts.push(u8arr(fF32(50, minSize))); // MINWIDTHPERCENT
    parts.push(u8arr(fF32(11, 1)));                             // MINWIDTH
    parts.push(u8arr(fF32(12, maxSize)));                      // MAXWIDTH
    parts.push(u8arr(fF32(13, opacity)));                       // ALPHA
    /* 【第192轮】SMALLALPHA（零压感 alpha）只在**完全没有压感**时才写。
       证据：用户提供的同一支笔刷「调前 / 调后」两个画世界原生导出对照——
         调前（无压感）：有 f14 = 0.13，没有 f36、没有 f47
         调后（开了大小压力 + 传递）：**f14 消失**，多出 f36=1、f47=1
       其它真实样本一致：双笔样本 f47=1 且没有 f14；压感硬圆/硬圆（都没有 f47）都有 f14=0.13。
       所以 f14 是「没有压力动态时」的最小 alpha 落值；一旦开了 f36/f47，App 自己按压力
       曲线算 alpha，此时再写 f14 会让它变成固定下限、把压力效果压平——这正是用户反馈的
       「Procreate 转画世界后不透明度不对」。
       0.13 是画世界写这个字段时的默认值（两个真实样本一致）。 */
    const sizePressOn = !!(b.pressureSize === undefined ? b.pressure : b.pressureSize);
    const transferOn = !!b.pressureOpacity;
    /* 【第194轮】f14 = 面板「最小不透明度」百分比 / 100（**绝对值，不乘 opacity**），
       与压感开关无关，为 0 时 App 直接省略。证据（_probe/pressure193）：
         s7 最小不透明度 0%  → 无 f14（此时 f36=1、f47=1 都开着）
         s8 最小不透明度 50% → f14=0.5（f36/f47 仍开着）
         s10 同一支 f13=0.8、f14=0.5 且面板显示 50% → 证伪「f14 = opacity × 最小不透明度」
       第192轮「开压感就不写 f14」是从「该笔刷最小不透明度恰好 0%」误推出来的相关性；
       那条结论在 0%/未设置场景下依然成立，故默认值路径原样保留：
         · 0 < minOp < 1（用户/来源明确设过）→ 写标定值 minOp；
         · minOp = 0 → 省略（App 行为）；
         · minOp = 1（默认，未设置）→ 沿用第192轮逻辑：只在完全无压感时写 0.13。
       这样 Procreate「最小不透明度 30%」这类笔刷转过去不再被丢掉，既有输出不变。 */
    if (Number.isFinite(b.bruSmallAlpha)) {
      if (b.bruSmallAlpha > 0) parts.push(u8arr(fF32(14, Math.min(1, b.bruSmallAlpha))));
    } else if (minOp > 0 && minOp < 1) parts.push(u8arr(fF32(14, minOp)));   // SMALLALPHA（显式最小不透明度，面板绝对值）
    else if (minOp >= 1 && !sizePressOn && !transferOn) parts.push(u8arr(fF32(14, 0.13))); // 无压感默认落值
    else if (minOp >= 1) parts.push(u8arr(fF32(14, 1)));                    // 【第195轮】有压感 + 面板 100%（旧版省略 → App 显示 0%）
    /* f16：原生样本（官方小方块、塑形扁刷 160+ 份标定件）一律 0xFF000000（黑）；旧写法固定 -1（白）。
       只有内置纹理引用路径（convert 传 bruColor）按原生写黑，其余输出保持旧值，逐字节不变。 */
    parts.push(u8arr(fVarint(16, b.bruColor === undefined ? -1 : b.bruColor)));  // COLOR
    const spacing = Math.max(0.001, Math.min(10, (b.spacingPct === undefined ? 10 : b.spacingPct) / 100));
    parts.push(u8arr(fF32(17, spacing)));                       // SPACING
    /* 【第233轮】f19 是旧的「跟随方向」位，以前从 bruRotationMode 反推——f115∈{2,3,4} 时被改成 0。
       源里有 f19 就原样写，没有才退回旧规则。 */
    parts.push(u8arr(fVarint(19, b.bruLegacyDirection === true ? 1 : (b.bruLegacyDirection === false ? 0
      : (b.bruRotationMode === undefined ? 1 : (b.bruRotationMode === 1 ? 1 : 0)))))); // legacy direction flag
    const roundness = Math.max(0.01, Math.min(1, (b.roundness === undefined ? 100 : b.roundness) / 100));
    parts.push(u8arr(fF32(22, roundness)));                     // ROUNDNESS
    const hardness = Math.max(0, Math.min(1, b.hardness === undefined ? 1 : b.hardness));
    parts.push(u8arr(fF32(23, hardness)));                      // HARDNESS
    const texScale = Math.max(0.01, Math.min(20, b.textureScale === undefined ? 1 : b.textureScale));
    parts.push(u8arr(fF32(24, texScale)));                      // TEXSCALE
    const flow = Math.max(0, Math.min(1, b.flowPct === undefined ? 1 : b.flowPct));
    parts.push(u8arr(fF32(25, flow)));                          // BRUSHFLOW
    const minFlow = Math.max(0, Math.min(1, b.minFlowRatio === undefined ? Math.min(1, flow * 0.13 + 0.01) : b.minFlowRatio));
    /* 【第194轮】压力页新增字段的取值（默认值 = 画世界面板默认状态，不传时输出与旧版逐字节一致）：
       · bruFlowSmooth（f67）        流量平滑开关，面板默认「关闭」→ 不写
       · bruFingerPressurePct（f117）手指压力·强度，面板默认 100% → 1-100/100 = 0 → 不写
       · bruFadeInOut（f134）        淡入淡出，面板默认「开启」→ 不写；关闭才写 1（反相！）
       · bruPressureSizeInfluence（f138）/ bruPressureFlowInfluence（f139）
                                     「压力影响」滑块，范围 -100%..+100%，中点 100%=0 → 不写 */
    const influenceVal = function (v) {
      const n = (v === undefined || v === null || !isFinite(Number(v))) ? 100 : Number(v);
      const pct = Math.max(-100, Math.min(100, n));
      return Math.max(-2, Math.min(0, pct / 100 - 1)); // -100%→-2，0%→-1，100%→0
    };
    /* 【第195轮】null / NaN / 非数值一律当「未传」= 100%（其余 4 个压力字段同此语义）。
       旧写法只挡 undefined，而 Number(null)===0 能通过 isFinite，于是 null 被当成 0% 强度，
       写出一支「手指压力全失效」的笔刷。 */
    const fingerRaw = (b.bruFingerPressurePct === undefined || b.bruFingerPressurePct === null || !isFinite(Number(b.bruFingerPressurePct))) ? 100 : Number(b.bruFingerPressurePct);
    const fingerPressVal = Math.max(0, Math.min(1, 1 - Math.max(0, Math.min(100, fingerRaw)) / 100));
    /* 【第195轮】f134 是反相字段（1=关闭），所以「未传」必须落到 true=开启。
       旧写法只挡 undefined：null → !!null=false → 写出 f134=1，把淡入淡出关掉了；NaN 同理。 */
    const fadeInOutOn = (b.bruFadeInOut === undefined || b.bruFadeInOut === null || (typeof b.bruFadeInOut === 'number' && !isFinite(b.bruFadeInOut))) ? true : !!b.bruFadeInOut;
    const sizeInfluence = influenceVal(b.bruPressureSizeInfluence);
    const flowInfluence = influenceVal(b.bruPressureFlowInfluence);
    const smallFlow = Number.isFinite(b.bruSmallFlow) ? Math.max(0, Math.min(1, b.bruSmallFlow)) : flow * minFlow;
    parts.push(u8arr(fF32(26, smallFlow)));                     // SMALLBRUSHFLOW
    if (!b.noShape) {
      parts.push(u8arr(fVarint(32, b.bruShapeInverted ? 1 : 0))); // REVERSESHAPE (native nib invert toggle)
      parts.push(u8arr(fVarint(31, 1)));                          // USESHAPE
    } else if (b._bruF31Field) {
      /* 【第232轮·field-matrix】源里「无笔尖图但带 f31」的原生记录（扁头质感描边实测）：
         noShape 布局也把 f31 原样写回，字段不丢。 */
      parts.push(u8arr(fVarint(31, 1)));
    }
    if (b.hasTexture) parts.push(u8arr(fVarint(28, 1)));        // TEXTURE ON
    // Native texture panel stores “apply texture to each tip” inverted.
    if (b.bruTexturePerTip === false) parts.push(u8arr(fVarint(99, 1)));
    parts.push(u8arr(fVarint(29, b.textureInverted ? 1 : 0)));  // REVERSETEX (distinct from shape f32)
    /* 【第206轮 R204-02（作者：Claude）】f35 必须写 **varint**（wire type 0），不是 float。
       依据：bru_标定 / 样本 / pressure193 / 官方小方块等 165 份原生 BRU 的 f35 全部是 varint（如 `98 02 64` = 100）；
       全字段 wire type 对照里，我们写出的字段只有 f35 与原生不符。App 用 protobuf 读，类型不符的字段按未知字段
       丢弃、取缺省值 —— 也就是以前所有转出的纹理亮度在 App 里都没有生效（第204轮 pt65 试制版也带着这个错）。 */
    /* 【第228轮】源 BRU 里没有 f35/f33 时不写（画世界的语义：不写 = 取缺省），有值就原样写出。
   f35/f33 是**有符号绝对值**：原生样本「眼睛」f35 = -6（wire: 98 02 FA FF FF FF FF FF FF FF FF 01），
   「头发亮晶晶」f33 = -3。旧实现把负值当成「相对中性 51/100 的偏移」再加回中性，
   往返后 -6 变 45、-3 变 97 —— 亮度/对比整体偏 51/100，203 支里 23 支 / 12 支受影响。 */
    if (b.textureBrightness !== undefined && Number.isFinite(Number(b.textureBrightness))) {
      parts.push(u8arr(fVarint(35, Math.max(-100, Math.min(100, Math.round(Number(b.textureBrightness))))))); // TEXBRIGHTNESS
    }
    if (b.textureContrast !== undefined && Number.isFinite(Number(b.textureContrast))) {
      parts.push(u8arr(fVarint(33, Math.max(-200, Math.min(200, Math.round(Number(b.textureContrast))))))); // CONTRAST
    }
    if (b.textureDepth) parts.push(u8arr(fF32(123, Math.max(0, Math.min(1, b.textureDepth))))); // TEXTUREDEPTH
    if (sizePressOn) parts.push(u8arr(fVarint(36, 1)));         // SUPPORTPRESSURE
    if (transferOn) parts.push(u8arr(fVarint(47, 1)));          // TRANSFER
    if (b.sizeJitterPct) parts.push(u8arr(fF32(10, Math.min(1, b.sizeJitterPct / 100)))); // SIZE JITTER
    if (b.spacingJitterPct) parts.push(u8arr(fF32(18, Math.min(10, b.spacingJitterPct / 100)))); // SPACING JITTER
    if (b.flowJitterPct) parts.push(u8arr(fF32(27, Math.min(1, b.flowJitterPct / 100)))); // FLOW JITTER
    if (b.countJitterPct) parts.push(u8arr(fF32(60, Math.min(1, b.countJitterPct / 100)))); // COUNT JITTER
    if (b.angle) parts.push(u8arr(fF32(20, b.angle)));          // ANGLE
    if (b.angleJitterDeg) parts.push(u8arr(fF32(21, b.angleJitterDeg))); // ANGLE JITTER
    /* 【第229轮】原生 BRU 里有「f56 没写、但 f57/f58/f59 有值」的笔刷（轻舟「墨迹/迹墨/蓫痕」：
       scatterOn=false + 强度 55% + 两轴 + 数量 4）。旧实现只要 scatterOn 为假就整组不写，
       往返后强度/数量被抹成 0/1。改成「开关为真、或任一参数存在」就写出，开关本身照旧只在为真时写。 */
      if (b.scatterOn || b.scatterPct || (b.scatterCount || 1) > 1 || b.scatterBothAxes) {
        if (b.scatterOn) parts.push(u8arr(fVarint(56, 1)));       // SCATTER ON
        if (b.scatterBothAxes) parts.push(u8arr(fVarint(57, 1))); // SCATTER BOTH AXES
        parts.push(u8arr(fF32(58, Math.max(0, Math.min(10, (b.scatterPct || 0) / 100))))); // SCATTER STRENGTH
        /* 【第232轮】源里单写 f59=1（数量显式为 1、无其它散布参数）的笔刷：块条件进不去，
           在块后单独补写（见下）；块内则放宽为「源有 f59 就写」。 */
        if ((b.scatterCount || 1) > 1 || b._bruScatterCountField) parts.push(u8arr(fVarint(59, Math.round(b.scatterCount)))); // COUNT
      }
      /* 【第232轮】块没进（开关/参数全默认）但源里明确写了 f59：原样补写，字段不丢。 */
      if (!b.scatterOn && !b.scatterPct && !b.scatterBothAxes && (b.scatterCount || 1) <= 1 && b._bruScatterCountField) {
        parts.push(u8arr(fVarint(59, Math.round(b.scatterCount || 1))));
      }
    parts.push(u8arr(fVarint(37, b.bruProtoVer === undefined ? 31 : b.bruProtoVer))); // VER（源有就写源）
    /* f42 =「形状RGB值影响透明度」（子消息，开 = {f1:1}，见 bru_标定/字段映射.md §3.3）。官方小方块与全部
       带 ptN 纹理的原生样本都是开；旧写法写空子消息。只有 convert 显式要求（bruShapeRgbOpacity）才写开。 */
    parts.push(u8arr(fBytes(42, b.bruShapeRgbOpacity ? new Uint8Array([0x08, 0x01]) : new Uint8Array(0)))); // RGBTOALPHA
    /* 【第227轮】f84 = 纹理混合模式。读侧一直在读（num(o[84],0)），但**写侧从来没有**，
       导致往返后一律变 0：全量 203 支 BRU 源里有 45 支失真（14 → 0、12 → 0）。
       官方样本实测编码是 varint（AE11「眼睛」= a0 05 0c → 值 12），这里按同类型写。 */
    if (typeof b.bruTextureBlendMode === 'number' && isFinite(b.bruTextureBlendMode) && b.bruTextureBlendMode !== 0) {
      parts.push(u8arr(fVarint(84, b.bruTextureBlendMode)));
    }
    parts.push(u8arr(fVarint(49, 1)));                          // PRESSUSEPERCENT
    /* 【第193轮真机标定】f51 = 面板「流量压力·最小值」/ 100，**不与 flow 相乘**。
       证据：MuMu + 画世界 3.4.5 上把该滑块 14%→60% 导出，diff 只有 `f51: 0.14→0.6`；
       60%→30% 再取一点，diff 只有 `f51: 0.6→0.3`。同一批样本里 `f26` 恒定不变（0.14），
       所以 f26 不是这一项的落点，保持原写法不动。
       旧代码写 `min(1, flow*minFlow)`，当 flow<1 时会把最小值再乘一次流量，App 里显示的
       最小百分比就会偏小——这也是「流量压力最小值不对」的直接原因。 */
    parts.push(u8arr(fF32(51, Math.min(1, minFlow))));          // SMALLBRUSHFLOWPERCENT
    parts.push(u8arr(fVarint(65, 1)));                          // ALLBRUSHRECT
    /* f67 = 流量平滑开关。标定证据：p193_s5(关闭) → s6(开启)，diff 只有 `f67: — → 1`，
       反向 s10→s11 之外再关回也是一样（不写即关闭）。面板默认关闭，所以默认不写。 */
    if (b.bruFlowSmooth) parts.push(u8arr(fVarint(67, 1)));      // FLOWSMOOTH
    /* 【第230轮】同 scatter：原生 BRU 有「f74 没写、f77 有值」的笔刷（轻舟「色块平铺」taperOn=false + 尺寸 0.36），
       旧条件只看 taperOn，往返把 0.36 抹成默认 1。改成「开关为真、或任一锥度参数存在」就写出，f74 仍只在为真时写。 */
    if (b.taperOn || b._bruTaperFields) {
      if (b.taperOn) parts.push(u8arr(fVarint(74, 1)));
      /* 【第232轮】逐字段「非默认才写」：否则补上 _bruTaperFields 之后 198 支会多写 f77=1 f78=1，
         字节面变大且 _rawMeta 类用例可能受影响。 */
      const taperSizeV = Math.max(0, Math.min(1, b.taperSize === undefined ? 1 : b.taperSize));
      const taperOpacityV = Math.max(0, Math.min(1, b.taperOpacity === undefined ? 1 : b.taperOpacity));
      /* 【第232轮】_bruTaperFields（源里有 f77/f78）时非默认值也写——「源有字段就写」，字段不丢。 */
      if (b.taperOn || b._bruTaperFields || Math.abs(taperSizeV - 1) > 1e-6) parts.push(u8arr(fF32(77, taperSizeV)));
      if (b.taperOn || b._bruTaperFields || Math.abs(taperOpacityV - 1) > 1e-6) parts.push(u8arr(fF32(78, taperOpacityV)));
    }
    if (b.wetEdgesOn) {
      parts.push(u8arr(fVarint(100, 1)));
      parts.push(u8arr(fF32(101, Math.max(0, Math.min(1, 1 - (b.wetEdgesAmount === undefined ? 0.4 : b.wetEdgesAmount))))));
      parts.push(u8arr(fF32(129, Math.max(0, Math.min(1, 1 - (b.wetEdgesDepth === undefined ? 0.4 : b.wetEdgesDepth))))));
    } else if (b._bruWetDepthField) {
      /* 【第232轮·field-matrix】源里 f100 关着但单写了 f129：原样写回深度，不写开关/强度（源也没有）。 */
      parts.push(u8arr(fF32(129, Math.max(0, Math.min(1, 1 - (b.wetEdgesDepth === undefined ? 0.4 : b.wetEdgesDepth))))));
    }
    // #37：混色（f103 开关 / f104 强度，反向存储）。smudge 字段优先；
    // Procreate 源只有湿混「混合」(dynamicsMix) 时用它兜底，跨格式不再把混色丢回默认值。
    const smudgeActive = b.smudgeOn !== undefined ? !!b.smudgeOn : (b.dynamicsMix !== undefined && b.dynamicsMix > 0);
    const smudgeAmt = b.smudgeAmount !== undefined ? b.smudgeAmount : (b.dynamicsMix !== undefined ? b.dynamicsMix : 0.3);
    if (smudgeActive) {
      parts.push(u8arr(fVarint(103, 1)));
      parts.push(u8arr(fF32(104, Math.max(0, Math.min(1, 1 - smudgeAmt)))));
    } else if (b._bruSmudgeAmountField) {
      /* 【第232轮·field-matrix】源里 f103 关着但单写了 f104：原样写回强度，不写开关。 */
      parts.push(u8arr(fF32(104, Math.max(0, Math.min(1, 1 - smudgeAmt)))));
    }
    /* 【第216轮】辅助颜色（= 双色 / 副色，Procreate 的 Secondary Color）。
       真机单变量标定（_probe/dualcolor216，同一支笔刷三次导出）：
         · 颜色动态 关 + 辅助颜色 0%  → 无 f61、无 f109
         · 颜色动态 开 + 辅助颜色 50% → f61=1、f109=float32 0.5
         · 颜色动态 开 + 辅助颜色 80% → f61=1、f109=float32 0.8（B/D 两份仅此一字段不同）
       所以 f109 是 0..1 的辅助颜色强度，f61 是它的总开关；App 里 f109 必须配 f61 才生效。
       colorJitterFgBg 为 0 / 未设置时不写任何字段，输出与旧版逐字节一致。 */
    const fgBgJitter = Math.max(0, Math.min(1, Number(b.colorJitterFgBg) || 0));
    if (b.colorDynamicsOn || fgBgJitter > 0) {
      parts.push(u8arr(fVarint(61, 1)));
      if (b.colorJitterHue) parts.push(u8arr(fF32(62, b.colorJitterHue)));
      if (b.colorJitterSat) parts.push(u8arr(fF32(63, b.colorJitterSat)));
      if (b.colorJitterVal) parts.push(u8arr(fF32(64, b.colorJitterVal)));
      if (fgBgJitter > 0) parts.push(u8arr(fF32(109, fgBgJitter)));  // COLORRANDC（辅助颜色）
    } else if (b._bruF109 !== undefined && b._bruF109 > 0) {
      /* 【第232轮·field-matrix】源里 f61 关着但单写了 f109（迟早-真果冻力 f109=0.41）：
         原样写回强度，不写开关（源也没有）。 */
      parts.push(u8arr(fF32(109, b._bruF109)));
    }
    parts.push(u8arr(fVarint(79, 1)));                          // TAPEREFFECT
    parts.push(u8arr(fF32(80, b.smoothingStrength === undefined ? 0.2 : Math.max(0, Math.min(1, b.smoothingStrength))))); // SMOOTHSTRENGTH
    if (b.bruUuid || b.bruDualRefUuid) {
      const uuidBytes = util.utf8Encode(b.bruUuid || ('bc-' + Date.now().toString(16) + '-0000-0000-0000-000000000000'));
      parts.push(u8arr(fBytes(120, uuidBytes)));
      if (b.bruDualRefUuid) {
        const u1 = uuidBytes, u2 = util.utf8Encode(b.bruDualRefUuid);
        const sub = b.bruDualSubBrush;
        const tpl = sub ? metadataFor(Object.assign({}, sub, {
          bruDualRefUuid: null, bruDualSubBrush: null, texId: sub.texId || sub.oldTexId || ''
        }),{}) : (b.bruLinkTemplate || dualLinkTemplate());
        const subName = util.utf8Encode(String(b.dualSubName || '第二支笔刷'));
        const iconPath = util.utf8Encode('icons/yzb');
        const tail = readFields(tpl, 0, tpl.length).filter(function (f) { return f.f > 5; });
        const msg = util.concat([
          u8arr(fBytes(1, u1)), u8arr(fBytes(2, u2)), u8arr(fBytes(3, subName)),
          u8arr(fBytes(4, iconPath)), u8arr(fVarint(5, 1)), encodeFields(tail)
        ]);
        parts.push(u8arr(fBytes(121, msg)));
        // 真实双笔刷文件里还有 f87 / f158，一并写入（经验值，来自样本）
        /* 【第230轮】BRU 源带着数字枚举（f122 原值）时直接用，别再经名字表绕一圈：
           Procreate 侧的 dualBlendMode 是它自己的下标，绕过去会把 12=linearHeight 写成 0。 */
        parts.push(u8arr(fVarint(122, (typeof b.bruDualBlendMode === 'number' && isFinite(b.bruDualBlendMode))
          ? b.bruDualBlendMode : dualBlendValue(b.dualBlendMode, b.bruDualBlendMode))));
        /* 【第232轮·field-matrix】源里带 f87（实测 −1 的 10 字节 varint）时原样写回，
           替代经验常数 9629115——双笔源里有 f87 的 13 支此前全部 VALUE 失真。 */
        parts.push(u8arr(b._bruF87Raw || fVarint(87, 9629115)));
        parts.push(u8arr(fF32(158, 90)));
      }
    }
    /* 【第232轮】非双笔但源里带 f87 的笔刷（eye 等 93 支，值 −1）：原样写回。 */
    if (!b.bruDualRefUuid && b._bruF87Raw) parts.push(u8arr(b._bruF87Raw));
    if (b.hollowPct !== undefined && b.hollowPct > 0) parts.push(u8arr(fF32(44, Math.max(0, Math.min(0.5, b.hollowPct / 100))))); // 中空度
    if (b.antialiasLevel) parts.push(u8arr(fVarint(96, Math.max(1, Math.min(3, Math.round(b.antialiasLevel))))));
    if (b.borderOn) {
      parts.push(u8arr(fVarint(92, 1)));
    }
    if (b.speedPressure) parts.push(u8arr(fVarint(43, 1)));
    parts.push(u8arr(fF32(81, 1)));                             // HOLLOWALPHA
    parts.push(u8arr(fVarint(82, b.hollowColor === undefined ? -1 : b.hollowColor))); // HOLLOWCOLOR（源有就写源）
    parts.push(u8arr(fVarint(83, 1)));                          // HOLALPIND
    parts.push(u8arr(fVarint(90, 1)));                          // NEWSPACECALTYPE
    // Write each field once, including when the effect is disabled: its stored
    // settings must survive toggling it back on. Zero is an explicit value.
    parts.push(u8arr(fF32(93, b.borderBrightness === undefined ? 1 : Math.max(0, Math.min(1, b.borderBrightness / 100)))));
    parts.push(u8arr(fF32(94, b.borderStrength === undefined ? 1 : Math.max(0, Math.min(1, b.borderStrength / 100)))));
    parts.push(u8arr(fVarint(95, b.borderBlend === undefined ? 4 : Math.max(0, Math.round(b.borderBlend)))));
    parts.push(u8arr(fVarint(97, Math.max(1, Math.round(b.renderCount || 1))))); // RENDERCOUNT
    parts.push(u8arr(fVarint(115, b.bruRotationMode === undefined ? 1 : b.bruRotationMode))); // native rotation control
    /* f117 = 手指压力·强度。标定：s9(100%) → s10(55%) 得 `f117: — → 0.45`；
       s11(55%) → s12(27%) 得 `0.45 → 0.73`，即 `1 − 强度/100`。100% 时 = 0，App 省略。 */
    if (fingerPressVal > 1e-6) parts.push(u8arr(fF32(117, fingerPressVal))); // FINGERPRESSURE
    /* f134 = 淡入淡出。**1 = 关闭（反相）**，不写 = 开启。
       标定：s6(开)→s7(误触关) 出现 `f134: — → 1`；s10(关)→s11(开) 又变回 `1 → —`。 */
    if (!fadeInOutOn) parts.push(u8arr(fVarint(134, 1)));       // FADEOFF
    parts.push(u8arr(fF32(135, maxSize / 500)));                // BRUWMAXSCALE
    parts.push(u8arr(fF32(136, size / maxSize)));               // BRUWSCALE
    /* f138 / f139 = 大小压力·压力影响 / 流量压力·压力影响，取值为 `面板%/100 − 1`（-2..0）。
       标定：s3→s3b `-1 → -1.5`（0%→-50%）、s3b→s3c `-1.5 → -0.51`（-50%→49%）；
       s3c→s4 出现 `f138: — → -1`。面板 100%（默认）时值为 0，App 省略不写。 */
    if (sizeInfluence < -1e-6) parts.push(u8arr(fF32(138, sizeInfluence))); // SIZEPRESSUREINFLUENCE
    if (flowInfluence < -1e-6) parts.push(u8arr(fF32(139, flowInfluence))); // FLOWPRESSUREINFLUENCE
    /* 【第232轮】未知字段原样透传：把 _rawUnknown 里的原始 wire 字节追加到 meta 末尾
       （protobuf 字段无序，App 按字段号取值）。只追加本次构建**没有写过**的字段号——
       某个字段号将来升级为已知时自动停止透传，不会重复写。
       metadataFor 的补丁路径（_rawMeta 存在）本来就走「原文 + 补丁表」，未知字段号不进
       补丁表，不会从这里重复进入。 */
    let metaOut = util.concat(parts.map(u8arr));
    if (b._rawUnknown && b._rawUnknown.length) {
      const written = new Set(readFields(metaOut, 0, metaOut.length).map((it) => it.f));
      const extraBytes = [];
      for (const u of b._rawUnknown) {
        if (!u || !u.length) continue;
        const it = readFields(u, 0, u.length);
        if (it.length === 1 && it[0].raw && it[0].raw.length === u.length && !written.has(it[0].f)) {
          extraBytes.push(u);
        }
      }
      if (extraBytes.length) metaOut = util.concat([metaOut].concat(extraBytes));
    }
    return metaOut;
  }

  const CONTAINER_HEAD = 22;
  const RECORD_LEN = 128;
  const BODY_START = CONTAINER_HEAD + RECORD_LEN; // 150

  function metadataFor(brush, opts) {
    if (opts.fidelity !== false && opts.keepRawMeta !== false && !opts.forceRebuild && brush._rawMeta && brush._rawMeta.length) {
      const patch=new Set(brush._rawPatchFields||[]);
      if(brush._rawOriginalName!==undefined && brush.name!==brush._rawOriginalName)patch.add(3);
      if(patch.size){
        const freshBytes=buildMetadata(brush),fresh=readFields(freshBytes,0,freshBytes.length);
        const old=readFields(brush._rawMeta,0,brush._rawMeta.length);
        return encodeFields(old.filter(f=>!patch.has(f.f)).concat(fresh.filter(f=>patch.has(f.f))));
      }
      const raw = new Uint8Array(brush._rawMeta);
      const oldId = (brush.oldTexId || '').toUpperCase();
      const newId = (brush.texId || (brush.png ? util.md5(brush.png) : '')).toUpperCase();
      if (oldId && newId && oldId !== newId && oldId.length === newId.length) {
        const oldBytes = util.utf8Encode(oldId), newBytes = util.utf8Encode(newId);
        for (let i = 0; i + oldBytes.length <= raw.length; i++) {
          let same = true;
          for (let k = 0; k < oldBytes.length; k++) if (raw[i + k] !== oldBytes[k]) { same = false; break; }
          if (same) raw.set(newBytes, i);
        }
      }
      return raw;
    }
    /* texId 显式给空串 = 「本笔刷没有自定义 mask，笔尖由 App 内置图库提供」
       （画世界官方内置笔刷的 f7 就是空）。不能用 `||` 兜底成 md5，否则空串被
       当成缺失，又写回一个 App 找不到的 mask 名。未给（undefined）才回落 md5。 */
    const texId = brush.texId !== undefined && brush.texId !== null
      ? brush.texId
      : (brush.png ? util.md5(brush.png).toUpperCase() : '');
    return buildMetadata(Object.assign({}, brush, { pkgId: brush.pkgId || opts.pkgId, texId: texId }));
  }

  /* Build a single-brush .bru file */
  function writeBrush(brush, opts) {
    opts = opts || {};
    const noShape = !!brush.noShape;
    const img = noShape ? new Uint8Array(0) : brush.png;
    if (!noShape && (!img || !img.length)) throw new Error('缺少笔尖图像数据');
    const meta = metadataFor(brush, opts);
    const embedded = !noShape && brush.embeddedSubPng && brush.embeddedSubPng.length ? brush.embeddedSubPng : null;
    /* 【第231轮】noShape 也能带纹理段：楠.bru「眼睛」的原生布局就是「无笔尖图 + f6 纹理像素」
       （rec+0x52=0、imgLen=0、texLen=实长，实测 _probe/verify230）。此前 `!noShape &&`
       把这条布局整个堵死，眼睛类笔刷往返保真无从表达。 */
    const texture = brush.bruTextureBytes;
    const texLength = texture ? texture.length : 0;
    const total = BODY_START + meta.length + img.length + texLength + (embedded ? embedded.length : 0);
    if (total > 0xffffffff) throw new Error('单支 BRU 超过 4GB，无法写出');
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    out.set(util.utf8Encode(MAGIC), 0);
    dv.setUint32(6, 8, false);            // container version 8
    dv.setUint32(10, total, false);       // total size
    dv.setUint32(14, 1, false);           // brush count
    dv.setUint32(18, 1, false);           // flag
    const rec = CONTAINER_HEAD;
    dv.setUint32(rec + 0x56, meta.length, false);            // meta length
    dv.setUint32(rec + 0x5e, img.length, false);             // image length
    dv.setUint32(rec + 0x62, texLength, false);              // separate texture length
    if (noShape) {
      /* 450B 小方块式（rec+0x52=1 + 三个 0xFFFFFFFF）只适用于**无任何附加数据**的记录；
         带纹理段时改用楠.bru「眼睛」式（rec+0x52=0、imgLen=0、texLen=实长），
         两种变体的解析都由 parseBru 覆盖（楠.bru #1 即眼睛式，实测）。 */
      if (!texLength) {
        dv.setUint32(rec + 0x52, 1, false);
        dv.setUint32(rec + 0x5a, 0xffffffff, false);
        dv.setUint32(rec + 0x5e, 0xffffffff, false);
        dv.setUint32(rec + 0x62, 0xffffffff, false);
      }
    }
    // 原生单支 BRU：记录 end 覆盖主图之后追加的副笔尖 PNG；img length 仍只算主图
    dv.setUint32(rec + 0x66, total, false); // end
    out.set(meta, BODY_START);
    out.set(img, BODY_START + meta.length);
    if (texLength) out.set(texture, BODY_START + meta.length + img.length);
    if (embedded) {
      // Native single-export fixture: trailing 22-byte descriptor starts at 128.
      out[rec + 0x6a] = 1;
      dv.setUint32(rec + 0x73, embedded.length, false);
      out.set(embedded, BODY_START + meta.length + img.length + texLength);
    }
    return out;
  }

  /* Build a multi-brush .bru pack (container v7 layout used by 画世界Pro):
     header + 128-byte record (brush 1) + for every other brush a 50-byte index block,
     its metadata and its tip image. This keeps a whole .abr / .brushset together. */
  function writePack(brushes, opts) {
    opts = opts || {};
    if (!brushes || !brushes.length) throw new Error('没有可打包的笔刷');
    if (brushes.length > 3000) throw new Error('单个 .bru 笔刷数量过多');
    /* 单支必须走单支布局：画世界自己导出的 .bru 一律是 version 8 / flag 1，
       而多支布局写的是 version 7 / flag 0。界面默认按"整包"分支导出，单支笔刷
       以前也被包进 v7，结果与 App 原生导出不一致（第179轮实测差异）。 */
    if (brushes.length === 1) return writeBrush(brushes[0], opts);
    const items = brushes.map(function (b) {
      const pngBytes = b.png;
      // 多支布局里「无笔尖图」条目没有原生样本可对照，不猜：noShape 只允许单支 writeBrush。
      if (b.noShape) throw new Error('多支 BRU 暂不支持无笔尖图条目: ' + (b.name || ''));
      if (!pngBytes || !pngBytes.length) throw new Error('缺少笔尖图像数据: ' + (b.name || ''));
      const meta = metadataFor(b, opts);
      return { meta, img: pngBytes, texture: b.bruTextureBytes || new Uint8Array(0), embedded: b.embeddedSubPng || new Uint8Array(0) };
    });
    let total = BODY_START;
    for (let i = 0; i < items.length; i++) {
      total += items[i].meta.length + items[i].img.length + items[i].texture.length + items[i].embedded.length;
      if (i > 0) total += 50;
    }
    if (total > 0xffffffff) throw new Error('打包后文件超过 4GB');
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    out.set(util.utf8Encode(MAGIC), 0);
    const hasTextureBlocks = items.some(it => it.texture.length);
    dv.setUint32(6, hasTextureBlocks ? 8 : 7, false);
    dv.setUint32(10, total, false);     // total size
    dv.setUint32(14, items.length, false);
    dv.setUint32(18, hasTextureBlocks ? 1 : 0, false);
    let pos = BODY_START;
    // brush 1: describe it in the 128-byte record
    dv.setUint32(CONTAINER_HEAD + 0x56, items[0].meta.length, false);
    dv.setUint32(CONTAINER_HEAD + 0x5e, items[0].img.length, false);
    dv.setUint32(CONTAINER_HEAD + 0x62, items[0].texture.length, false);
    dv.setUint32(CONTAINER_HEAD + 0x66, pos + items[0].meta.length + items[0].img.length + items[0].texture.length + items[0].embedded.length, false);
    out.set(items[0].meta, pos); pos += items[0].meta.length;
    out.set(items[0].img, pos); pos += items[0].img.length;
    out.set(items[0].texture, pos); pos += items[0].texture.length;
    if (items[0].embedded.length) {
      out[CONTAINER_HEAD + 0x6a] = 1;
      dv.setUint32(CONTAINER_HEAD + 0x73, items[0].embedded.length, false);
    }
    out.set(items[0].embedded, pos); pos += items[0].embedded.length;
    for (let i = 1; i < items.length; i++) {
      const blockPos = pos;
      const metaLen = items[i].meta.length, imgLen = items[i].img.length;
      const endOff = blockPos + 50 + metaLen + imgLen + items[i].texture.length + items[i].embedded.length;
      dv.setUint32(blockPos + 0x08, metaLen, false);
      dv.setUint32(blockPos + 0x10, imgLen, false);
      dv.setUint32(blockPos + 0x14, items[i].texture.length, false);
      dv.setUint32(blockPos + 0x18, endOff, false);
      if (items[i].embedded.length) {
        out[blockPos + 0x1c] = 1;
        dv.setUint32(blockPos + 0x25, items[i].embedded.length, false);
      }
      pos = blockPos + 50;
      out.set(items[i].meta, pos); pos += metaLen;
      out.set(items[i].img, pos); pos += imgLen;
      out.set(items[i].texture, pos); pos += items[i].texture.length;
      out.set(items[i].embedded, pos); pos += items[i].embedded.length;
    }
    if (pos !== total) throw new Error('内部长度不一致 (' + pos + '/' + total + ')');
    return out;
  }

  /* ---------- reader ---------- */
  function isBru(bytes) {
    return bytes.length > 8 && util.ascii(bytes, 0, 6) === MAGIC;
  }

  const SKIP_FIELDS = new Set([7, 46, 120, 121, 147, 148]);

  function readFields(bytes, start, end) {
    const fields = [];
    let p = start;
    while (p < end) {
      const fieldStart = p;
      let tagVal = 0, shift = 0, ok = false;
      let q = p;
      while (q < end) {
        const c = bytes[q++];
        tagVal += (c & 0x7f) * Math.pow(2, shift);
        if (!(c & 0x80)) { ok = true; break; }
        shift += 7;
        if (shift > 56) break;
      }
      if (!ok) break;
      const f = Math.floor(tagVal / 8), w = tagVal % 8;
      if (f === 0 || f > 100000) break;
      p = q;
      if (w === 0) {
        let v = 0, lowBits = 0; shift = 0;
        while (p < end) {
          const c = bytes[p++];
          v += (c & 0x7f) * Math.pow(2, shift);
          if (shift < 32) lowBits |= (c & 0x7f) << shift;
          if (!(c & 0x80)) break;
          shift += 7;
          if (shift > 63) return fields;
        }
        // Texture adjustment fields are protobuf int32. Negative values use a ten-byte varint.
        /* 【第233轮】f16（画笔颜色）也是 int32：源里「白」写的是 64 位补码 -1，用 v 累加会超过安全整数、
           再 |0 变成 0（白变黑）；-20544 也会丢精度成 -20480。fieldmatrix 审计里 116 支受损。 */
        fields.push({ f, w, v: f === 16 || f === 33 || f === 35 || f === 82 ? lowBits : v });
      } else if (w === 5) {
        if (p + 4 > end) break;
        fields.push({ f, w, v: new DataView(bytes.buffer, bytes.byteOffset + p, 4).getFloat32(0, true) });
        p += 4;
      } else if (w === 1) {
        if (p + 8 > end) break;
        fields.push({ f, w, v: bytes.subarray(p, p + 8) });
        p += 8;
      } else if (w === 2) {
        let l = 0; shift = 0;
        while (p < end) {
          const c = bytes[p++];
          l += (c & 0x7f) * Math.pow(2, shift);
          if (!(c & 0x80)) break;
          shift += 7;
        }
        if (p + l > end) break;
        fields.push({ f, w, v: bytes.subarray(p, p + l) });
        p += l;
      } else break;
      fields[fields.length - 1].raw = bytes.subarray(fieldStart, p);
    }
    return fields;
  }

  function fieldsToObj(fields) {
    const o = {};
    for (const it of fields) o[it.f] = it.v;
    return o;
  }

  function encodeFields(fields) {
    return util.concat(fields.map(function (f) {
      if (f.raw) return f.raw;
      if (f.w === 0) return u8arr(fVarint(f.f, f.v));
      if (f.w === 5) return u8arr(fF32(f.f, f.v));
      if (f.w === 2) return u8arr(fBytes(f.f, f.v));
      return util.concat([u8arr(tag(f.f, f.w)), f.v]);
    }));
  }

  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function findPng(bytes, from, limit) {
    const end = Math.min(bytes.length - 8, from + (limit || 20000000));
    for (let i = from; i < end; i++) {
      if (bytes[i] !== 0x89) continue;
      let ok = true;
      for (let k = 0; k < 8; k++) if (bytes[i + k] !== PNG_SIG[k]) { ok = false; break; }
      if (ok) return i;
    }
    return -1;
  }

  function looksLikeMetaStart(bytes, i) {
    if (bytes[i] !== 0x0a) return false;
    const len = bytes[i + 1];
    if (len < 8 || len > 60) return false;
    for (let k = 0; k < len; k++) {
      const c = bytes[i + 2 + k];
      if (c < 32 || c > 126) return false;
    }
    const nt = i + 2 + len;
    return bytes[nt] === 0x12;
  }

  /* Block-driven multi-brush reader. Fallbacks keep older/odd containers readable. */
  function parseBru(bytes) {
    if (!isBru(bytes)) throw new Error('不是画世界Pro .bru 文件');
    const version = util.u32(bytes, 6);
    const totalSize = util.u32(bytes, 10);
    const count = util.u32(bytes, 14);
    const rec = CONTAINER_HEAD;
    const firstMetaLen = util.u32(bytes, rec + 0x56);
    const firstImgLen = util.u32(bytes, rec + 0x5e);
    const firstTextureLen = util.u32(bytes, rec + 0x62);
    const firstEnd = util.u32(bytes, rec + 0x66);
    const brushes = [];
    const warnings = [];

    function pngEndAt(off, limit) {
      let p = off + 8;
      const stop = limit === undefined ? bytes.length : Math.min(bytes.length, limit);
      while (p + 12 <= stop) {
        const len = util.u32(bytes, p);
        const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
        const end = p + 12 + len;
        if (end > stop) return -1;
        if (type === 'IEND') return end;
        p = end;
      }
      return -1;
    }

    function pushBrush(metaStart, metaEnd, pngStart, pngEnd, embeddedMeta, extraEnd, textureLen) {
      const rawMeta = embeddedMeta || bytes.subarray(metaStart, metaEnd);
      const fields = readFields(rawMeta, 0, rawMeta.length);
      const o = fieldsToObj(fields);
      // 字段语义依据实机标定：D:\dsh项目\笔刷ru_标定\字段映射.md
      const num = (v, dflt) => (typeof v === 'number' && isFinite(v) ? v : dflt);
      const name = o[3] ? util.utf8Decode(o[3]) : '';
      const size = num(o[8], 100);
      const minSizePct = typeof o[50] === 'number' ? o[50] : null;   // 最小直径（f50）
      const spacing = num(o[17], 0.1);                                // 间距（f17）
      const alpha = num(o[13], 1);                                    // 不透明度（f13）
      const flowPct = num(o[25], 1);                                  // 流量（f25）
      const smallAlpha = num(o[14], alpha);                           // 最小不透明度（f14）
      const minFlowPct = num(o[51], flowPct);                         // 最小流量（f51）
      const sizeJitterPct = num(o[10], 0) * 100;                      // 大小随机（f10）
      const spacingJitterPct = num(o[18], 0) * 100;                   // 间距随机（f18）
      const flowJitterPct = num(o[27], 0) * 100;                      // 流量随机（f27）
      const countJitterPct = num(o[60], 0) * 100;                     // 数量随机（f60）
      const angleDeg = num(o[20], 0);                                 // 旋转（f20，度）
      const angleJitterDeg = num(o[21], 0);                           // 旋转随机（f21，度）
      const roundnessPct = num(o[22], 1) * 100;                       // 圆度（f22）
      const hardnessPct = num(o[23], 1) * 100;                        // 硬度（f23）
      const scatterOn = !!o[56];                                      // 散布开关（f56）
      const scatterPct = num(o[58], 0) * 100;                         // 散布强度（f58）
      const scatterBothAxes = !!o[57];                                // 散布两轴（f57）
      const scatterCount = Math.max(1, Math.round(num(o[59], 1)));    // 数量（f59）
      const textureOn = !!o[28];                                      // 纹理开关（f28）
      const texScale = num(o[24], 1);                                 // 纹理缩放（f24）
      const texBrightness = num(o[35], 51);                           // 纹理亮度（f35）
      const texContrast = num(o[33], 100);                            // 纹理对比度（f33）
      const texDepth = num(o[123], 0);                                // 纹理深度（f123）
      const wetOn = !!o[100];                                         // 湿边开关（f100）
      const wetStrengthRaw = num(o[101], 1);                          // 湿边强度（反向：1-x）
      const wetDepthRaw = num(o[129], 1);                             // 湿边深度（反向）
      const mixOn = !!o[103];                                         // 混色开关（f103）
      const mixStrengthRaw = num(o[104], 1);                          // 混色强度（反向）
      const taperOn = !!o[74];                                        // 锥度开关（f74）
      const taperSize = num(o[77], 1);                                // 锥度尺寸强度（f77）
      /* 【第230轮】源里到底有没有 f77/f78：有就必须原样写出（哪怕 f74 关着），
         没有就不要凭空补默认值，否则 183 支会被写成显式值。 */
      const bruTaperFields = o[77] !== undefined || o[78] !== undefined;
      const taperOpacity = num(o[78], 1);                             // 锥度不透明度（f78）
      const colorDynOn = !!o[61];                                     // 颜色动态（f61）
      const colorHue = num(o[62], 0), colorSat = num(o[63], 0), colorVal = num(o[64], 0);
      /* 【第216轮】f109 = 辅助颜色强度（0..1）= 画世界的「双色」/ Procreate 的 Secondary Color。
         真机标定见 buildMetadata 里 f109 的注释。只在颜色动态打开时才算数：f109 单独存在
         时 App 不生效，所以关掉 f61 就当 0，避免把惰性字段当成真的副色动态。 */
      const colorFgBg = colorDynOn ? Math.max(0, Math.min(1, num(o[109], 0))) : 0;
      const smoothingStrength = num(o[80], 0.2);                      // 平滑强度（f80）
      // 画世界Pro 3.0：f120=本笔刷uuid；f121 field2=包ID，field3及后续字段为副笔参数。
      let bruUuid = null, bruDualRef = null, bruLinkInfo = null, bruLinkTemplate = null;
      try {
        if (o[120] instanceof Uint8Array) bruUuid = util.utf8Decode(o[120]).replace(/ +$/, '');
        if (o[121] instanceof Uint8Array) {
          const msg = fieldsToObj(readFields(o[121], 0, o[121].length));
          const u1 = msg[1] instanceof Uint8Array ? util.utf8Decode(msg[1]) : null;
          const u2 = msg[2] instanceof Uint8Array ? util.utf8Decode(msg[2]) : null;
          if (!bruUuid && u1) bruUuid = u1;
          if (u2 && u2 !== bruUuid) bruDualRef = u2;
          bruLinkInfo = { primary: u1, packageId: u2,
            name: msg[3] instanceof Uint8Array ? util.utf8Decode(msg[3]) : '', enabled: !!o[119] };
          bruLinkTemplate = new Uint8Array(o[121]);
        }
      } catch (e) { /* ignore */ }
      const hollowPct = o[44] === undefined ? undefined : num(o[44], 0.5) * 100;                        // 中空度（f44）
      const antialiasLevel = num(o[96], 0);                           // 抗锯齿（f96）
      const borderOn = !!o[92];                                       // 混边开关（f92）
      const borderBlend = num(o[95], 0);                              // 混边混合（f95）
      const borderBrightness = num(o[93], 1) * 100;                   // 混边亮度（f93）
      const borderStrength = num(o[94], 1) * 100;                     // 混边强度（f94）
      const renderCount = Math.max(1, Math.round(num(o[97], 1)));     // 渲染数量（f97）
      const speedPressure = !!o[43];                                  // 速度模拟压感（f43）
      const pressureSize = !!o[36];                                   // 大小压力（f36）
      const legacyMinWidth = pressureSize && minSizePct === null && Number.isFinite(o[9]) && o[9] >= 0 && size > 0;
      const transferOn = !!o[47];                                     // 传递（f47）
      /* 【第194轮】压力页字段回读（第193轮真机标定）：
         f67 开关 / f117 `1−强度/100` / f134 `1=关闭`（反相）/ f138·f139 `面板%/100−1`。
         不读回来的话，原生 BRU 一旦走重建路径（改尺寸、forceRebuild）这几项就丢成默认值。 */
      const flowSmooth = !!o[67];                                     // 流量平滑（f67）
      const fingerPressPct = o[117] === undefined ? 100
        : Math.max(0, Math.min(100, (1 - num(o[117], 0)) * 100));      // 手指压力强度（f117）
      const fadeInOut = o[134] === undefined ? true : !o[134];         // 淡入淡出（f134：1=关闭）
      const sizeInfluencePct = o[138] === undefined ? 100
        : Math.max(-100, Math.min(100, (num(o[138], 0) + 1) * 100));   // 大小压力·压力影响（f138）
      const flowInfluencePct = o[139] === undefined ? 100
        : Math.max(-100, Math.min(100, (num(o[139], 0) + 1) * 100));   // 流量压力·压力影响（f139）
      let tip = null;
      if (pngStart >= 0 && pngEnd > pngStart) {
        try {
          const im = decodeBrushImage(bytes.subarray(pngStart, pngEnd));
          tip = { w: im.width, h: im.height, rgba: im.rgba };
        } catch (e) {
          warnings.push('第 ' + (brushes.length + 1) + ' 支笔刷图像解码失败（可能为 JPEG 纹理）');
        }
      }
      // 画世界 3.x 单支 BRU 会把“关联副笔尖”的 PNG 紧随主图之后内嵌；
      // 容器 count 仍是 1，需要在记录 end 之前的剩余区里继续找 PNG。
      const embeddedTips = [];
      let textureBytes, grainRgba;
      let extraStart = pngEnd;
      if (textureLen > 0 && pngEnd >= 0 && pngEnd + textureLen <= extraEnd && o[6] instanceof Uint8Array) {
        const id = util.utf8Decode(o[6]).replace(/\u0000+$/, '');
        const chunk = bytes.subarray(pngEnd, pngEnd + textureLen);
        if (/^[0-9a-f]{32}$/i.test(id) && util.md5(chunk) === id.toLowerCase()) {
          extraStart += textureLen;
          textureBytes = chunk;
          try {
            const im = decodeBrushImage(chunk);
            grainRgba = { w: im.width, h: im.height, rgba: im.rgba };
          } catch (e) { warnings.push(name + ': 自定义纹理原图已保留，预览解码失败'); }
        }
      }
      if (pngStart >= 0 && extraEnd && extraEnd > extraStart) {
        let ep = extraStart;
        while (ep < extraEnd) {
          const pj = findPng(bytes, ep, extraEnd - ep);
          if (pj < 0) break;
          const pe = pngEndAt(pj, extraEnd);
          if (pe < 0 || pe > extraEnd) break;
          try {
            const im = png.decode(bytes.subarray(pj, pe));
            embeddedTips.push({ w: im.width, h: im.height, rgba: im.rgba });
          } catch (e) { break; }
          ep = pe;
        }
      }
      const brush = {
        name: name || ('笔刷 ' + (brushes.length + 1)),
        tip,
        sizePx: size,
        spacingPct: spacing * 100,
        minSizeRatio: Math.max(0, Math.min(1, minSizePct !== null ? minSizePct : legacyMinWidth ? o[9] / size : 1)),
        bruLegacyMinWidth: legacyMinWidth,
        bruSmallFlow: Number.isFinite(o[26]) ? Math.max(0, Math.min(1, o[26])) : undefined,
        opacity: alpha,
        flowPct: Math.max(0, Math.min(1, flowPct)),
        /* 第194轮：f14 按 App 面板百分比直接读（见写出口注释：s10 的 f13=0.8 / f14=0.5 且面板显示
           50%，证明 f14 是面板绝对值而不是「opacity 的比例」）。缺省（没有 f14）仍是 1 = 未限制。 */
        /* 第195轮：无 f14 == App 面板「最小不透明度 0%」（s7 单变量：改成 0% 后该字段消失，
           protobuf 不写默认值 0）。旧版读成 1（未限制），会让 0% 的笔刷往返后变成 100%。 */
        minOpacityRatio: o[14] === undefined ? 0 : Math.max(0, Math.min(1, smallAlpha)),
        /* 第195轮：f51 与 f14 同理是**面板绝对值**（第193轮标定：f51 = 流量压力·最小值 %/100，
           不乘 flow）。旧版这里除以 flowPct，flow<1 的笔刷往返一次最小值就被放大（0.3→0.6，
           0.5@flow=0.2 直接夹到 1）。 */
        minFlowRatio: o[51] === undefined ? 1 : Math.max(0, Math.min(1, minFlowPct)),
        pressure: pressureSize || transferOn,
        pressureSize: pressureSize,
        pressureOpacity: transferOn,
        // 第194轮：压力页标定字段（默认值即画世界面板默认，回写时不会平白多出字段）
        bruFlowSmooth: flowSmooth,
        bruFingerPressurePct: fingerPressPct,
        bruFadeInOut: fadeInOut,
        bruPressureSizeInfluence: sizeInfluencePct,
        bruPressureFlowInfluence: flowInfluencePct,
        sizeJitterPct: sizeJitterPct,
        spacingJitterPct: spacingJitterPct,
        flowJitterPct: flowJitterPct,
        countJitterPct: countJitterPct,
        angle: angleDeg,
        /* 【第233轮·fieldmatrix 审计】这三个字段以前「写侧恒用常量」，把源值砸掉：
           f37 VER（源 29/23 被写成 31）、f82 HOLLOWCOLOR（源真值被写成 -1）、
           f19 旧「跟随方向」位（被折进 bruRotationMode 再反推，f115∈{2,3,4} 时变 0）。 */
        bruProtoVer: typeof o[37] === 'number' ? o[37] : undefined,
        hollowColor: typeof o[82] === 'number' ? o[82] : undefined,
        bruLegacyDirection: o[19] === undefined ? undefined : !!o[19],
        angleJitterDeg: angleJitterDeg,
        bruRotationMode: Math.max(0, Math.min(4, Math.round(num(o[115], o[19] ? 1 : 0)))),
        roundness: roundnessPct,
        hardness: hardnessPct / 100,
        smoothingStrength: smoothingStrength,
        bruUuid: bruUuid,
        bruDualRefUuid: bruDualRef,
        bruLinkInfo: bruLinkInfo,
        bruLinkTemplate: bruLinkTemplate,
        bruDualEnabled: o[119] === undefined ? undefined : !!o[119],
        bruDualBlendMode: num(o[122], 0),
        dualBlendMode: dualBlendName(num(o[122], 0)),
        pkgId: o[2] instanceof Uint8Array ? util.utf8Decode(o[2]) : undefined,
        hollowPct: hollowPct,
        antialiasLevel: antialiasLevel,
        borderOn: borderOn,
        borderBlend: borderBlend,
        borderBrightness: borderBrightness,
        borderStrength: borderStrength,
        renderCount: renderCount,
        speedPressure: speedPressure,
        scatterOn: scatterOn,
        scatterPct: scatterPct,
        scatterBothAxes: scatterBothAxes,
        scatterCount: scatterCount,
        hasTexture: textureOn,
        bruTexturePerTip: !o[99],
        bruTextureBlendMode: num(o[84], 0),
        /* 【第226轮】f16（颜色）与 f42（形状RGB影响透明度）以前只写不读，往返时源值丢了：
           f16 退回默认 -1（白）、f42 消失，而官方样本是 0xFF000000（-16777216）+ f42={1:1}。
           读出来才能在往返里保持；写侧规则不动。 */
        bruColor: typeof o[16] === 'number' ? (o[16] | 0) : undefined,
        bruShapeRgbOpacity: !!(o[42] && typeof o[42] === 'object' && (o[42][1] === 1 || o[42][1] === true)),
        texAssetId: o[6] instanceof Uint8Array ? util.utf8Decode(o[6]).replace(/\u0000+$/, '') : undefined,
        textureInverted: !!o[29],
        textureScale: texScale,
        textureBrightness: texBrightness,
        textureContrast: texContrast,
        textureDepth: texDepth,
        grainStrength: texDepth > 0 ? Math.max(0.1, Math.min(0.8, texDepth)) : 0.35,
        wetEdgesOn: wetOn,
        wetEdgesAmount: wetOn ? Math.max(0, Math.min(1, 1 - wetStrengthRaw)) : 0,
        /* 【第232轮·field-matrix】f129 源有字段就还原值（哪怕 f100 关着）——写侧「源有就写」靠它取值。
           旧实现 wetOn=false 时置 0，f129 的源值（eye 0.92）在重建时被写成 1。 */
        wetEdgesDepth: (o[129] !== undefined || wetOn) ? Math.max(0, Math.min(1, 1 - wetDepthRaw)) : 0,
        _bruWetDepthField: o[129] !== undefined,
        smudgeOn: mixOn,
        /* 【第232轮·field-matrix】f104 源有字段就还原值（哪怕 f103 关着）。旧实现 mixOn=false 时置 0，
           f104 的源值（eye 0.01）在重建时被写成 1。 */
        smudgeAmount: (o[104] !== undefined || mixOn) ? Math.max(0, Math.min(1, 1 - mixStrengthRaw)) : 0,
        _bruSmudgeAmountField: o[104] !== undefined,
        _bruScatterCountField: o[59] !== undefined,
        /* 【第232轮】f109 原值（辅助颜色，colorDynamicsOn 关着时 writer 也要能原样写回）。 */
        _bruF109: o[109] === undefined ? undefined : Math.max(0, Math.min(1, num(o[109], 0))),
        _bruF31Field: o[31] !== undefined,
        /* 【第232轮】f87 原始 wire 字节（实测为 −1 的 10 字节 varint；double 读回会丢精度，
           所以直接留字节）。双笔经验常数 9629115 只在源没有 f87 时兜底。 */
        _bruF87Raw: (function () { for (const it of fields) if (it.f === 87 && it.raw && it.raw.length) return it.raw; })(),
        // #37：BRU f103/f104（混色强度）→ Procreate 湿混「混合」。载入/柔化 BRU 无对应
        // 字段，交由 Procreate 默认值；同格式写出仍优先用 smudgeOn/smudgeAmount。
        dynamicsMix: mixOn ? Math.max(0, Math.min(1, 1 - mixStrengthRaw)) : undefined,
        taperOn: taperOn,
        taperSize: taperSize,
        _bruTaperFields: bruTaperFields,
        taperOpacity: taperOpacity,
        colorDynamicsOn: colorDynOn,
        colorJitterHue: colorHue,
        colorJitterSat: colorSat,
        colorJitterVal: colorVal,
        /* 【第216轮】辅助颜色 → Procreate 的 Secondary Color（procreate.js 的 jitterSecondary）。
           只有 >0 时才回填，值为 0 的笔刷字段保持 undefined，避免影响既有逐字节输出。 */
        colorJitterFgBg: colorFgBg > 0 ? colorFgBg : undefined,
        _rawMeta: rawMeta,
        _rawMaxWidth:num(o[12],500),
        /* 【第195轮】f12 同时回填公开字段，否则绕过 convert.makeBru（它用 _rawMaxWidth 兜底）
           直接调 bru.writeBrush 重建时，最大宽度上限会从 800 静默掉到 500，f135/f136 随之失真。 */
        maxSizePx: num(o[12], 500),
        oldTexId: (function (v) {
          if (!v) return '';
          if (typeof v === 'string') return v;
          try { return util.utf8Decode(v); } catch (e) { return ''; }
        })(o[7]),
        bruProceduralTip: !tip && !o[31] && !(o[7] && o[7].length),
        bruShapeInverted: !!o[32],
        source: 'bru',
        bruVersion: version
      };
      if (textureBytes) brush._rawBruTexture = textureBytes;
      if (grainRgba) brush._grainRgba = grainRgba;
      if (embeddedTips.length) {
        brush.embeddedTips = embeddedTips;
        const hasLink = !!(brush.bruLinkTemplate || brush.bruDualRefUuid || brush.bruDualEnabled);
        if (hasLink && !brush.dualTip) {
          brush.dualOn = brush.bruDualEnabled !== false;
          brush.dualTip = embeddedTips[0];
          const subName = (brush.bruLinkInfo && brush.bruLinkInfo.name) || '';
          brush.dualSubName = subName;
          brush.dualBrush = Object.assign({}, brush.dualBrush || {}, {
            enabled: brush.dualOn,
            name: subName,
            blend: brush.bruDualBlendMode,
            diameter: embeddedTips[0].w
          });
        }
      }
      /* 【第232轮·field-matrix D 表】未知字段原样保留：不在读写白名单里的字段号，
         按原始 wire 字节（tag+payload）存 _rawUnknown，重建写 meta 时原样追加。
         f54 作者署名、f128 笔刷引擎、f107 混色亮度修正等都靠这条活过 brushset 往返。 */
      if (rawMeta && rawMeta.length) {
        const unknownFields = [];
        for (const it of fields) {
          if (!BRU_KNOWN_FIELDS.has(it.f) && it.raw && it.raw.length) unknownFields.push(it.raw);
        }
        if (unknownFields.length) brush._rawUnknown = unknownFields;
      }
      brushes.push(brush);
      const parsed = brushes[brushes.length - 1];
      parsed._rawState = {};
      Object.keys(parsed).forEach(function (key) {
        const v = parsed[key];
        if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') parsed._rawState[key] = v;
      });
    }

    function metaAt(i) {
      if (i + 2 >= bytes.length || bytes[i] !== 0x0a) return false;
      const len = bytes[i + 1];
      if (len < 8 || len > 80) return false;
      for (let k = 0; k < len; k++) {
        const c = bytes[i + 2 + k];
        if (c < 32 || c > 126) return false;
      }
      return bytes[i + 2 + len] === 0x12;
    }
    function findNextMeta(from, limit) {
      const stop = Math.min(bytes.length - 8, from + (limit || 4 * 1024 * 1024));
      for (let i = from; i < stop; i++) {
        if (bytes[i] === 0x0a && metaAt(i)) return i;
      }
      return -1;
    }

    // Native files use 0xffffffff as a missing-image sentinel.
    const firstTipSize = firstImgLen === 0xffffffff ? 0 : firstImgLen;
    const firstTexSize = firstTextureLen === 0xffffffff ? 0 : firstTextureLen;
    let pos = BODY_START + firstMetaLen + firstTipSize + firstTexSize;
    if (firstMetaLen > 0 && BODY_START + firstMetaLen <= bytes.length) {
      pushBrush(BODY_START, BODY_START + firstMetaLen, BODY_START + firstMetaLen,
        Math.min(bytes.length, BODY_START + firstMetaLen + firstTipSize),
        undefined, Math.min(bytes.length, firstEnd || bytes.length), firstTexSize);
      if (firstEnd && firstEnd > pos && firstEnd <= bytes.length) pos = firstEnd;
    }

    // remaining brushes: 50-byte index block each
    let guard = 0;
    while (guard++ < 5000) {
      if (count > 0 && brushes.length >= count) break;
      if (pos + 50 >= bytes.length) break;
      let metaLen = util.u32(bytes, pos + 0x08);
      const img1Len = util.u32(bytes, pos + 0x10);
      const img2Len = util.u32(bytes, pos + 0x14);
      let endOff = util.u32(bytes, pos + 0x18);
      let metaStart = pos + 50;
      let ok = metaLen > 0 && metaLen < 0x10000 && metaAt(metaStart);
      if (!ok) {
        // container variant: locate next metadata by signature scan (block size may differ)
        const found = findNextMeta(pos + 1, 4096);
        if (found < 0) break;
        metaStart = found;
        const pngAt = findPng(bytes, metaStart, 4 * 1024 * 1024);
        const nextMeta = findNextMeta(metaStart + 40, 64 * 1024 * 1024);
        const limit = nextMeta > 0 ? nextMeta : bytes.length;
        const metaEnd = pngAt > 0 && pngAt < limit ? pngAt : limit;
        // 用 PNG chunk 扫到 IEND 得到真实结束，不再拿 nextMeta-50 截断 IDAT；
        // 副图尾部扫描上限传给 extraEnd，否则变体容器里的双笔内嵌副笔尖永远扫不到。
        const pngEnd = pngAt > 0 ? pngEndAt(pngAt, limit) : -1;
        pushBrush(metaStart, metaEnd, pngAt > 0 ? pngAt : -1, pngEnd, undefined, limit);
        pos = nextMeta > 0 ? nextMeta - 50 : bytes.length;
        continue;
      }
      const expectEnd = metaStart + metaLen + img1Len + img2Len;
      if (expectEnd > bytes.length) {
        warnings.push('笔刷记录长度超出文件，停止读取');
        break;
      }
      // A valid end may also cover an embedded sub-tip PNG after the main.
      if (endOff < expectEnd || endOff > bytes.length) endOff = expectEnd;
      const pngStart = metaStart + metaLen;
      pushBrush(metaStart, pngStart, pngStart, Math.min(bytes.length, pngStart + img1Len), undefined, endOff, img2Len);
      pos = endOff > pos ? endOff : Math.min(bytes.length, pngStart + img1Len + img2Len);
    }
    if (!brushes.length) throw new Error('.bru 中没有找到可用笔刷');
    // Resolve links after every standalone brush is available. f121 embeds the
    // secondary settings; field2 is a package ID, not a secondary brush UUID.
    brushes.slice().forEach(function (primary) {
      if (!primary.bruLinkTemplate) return;
      pushBrush(0, 0, -1, -1, primary.bruLinkTemplate);
      const embedded = brushes.pop();
      const candidates = brushes.filter(function (b) { return b !== primary; });
      const samePackage = candidates.filter(function (b) { return b.pkgId === primary.bruDualRefUuid; });
      const pool = samePackage.length ? samePackage : candidates;
      const linked = pool.find(function (b) { return embedded.oldTexId && b.oldTexId === embedded.oldTexId; }) ||
        pool.find(function (b) { return b.name === embedded.name; }) ||
        candidates.find(function (b) { return b.bruUuid === primary.bruDualRefUuid; });
      const embeddedTip = (primary.embeddedTips && primary.embeddedTips[0]) || primary.dualTip || null;
      const sub = Object.assign({}, linked || {}, embedded, {
        // Record-local embedded pixels are authoritative; a same-named brush
        // elsewhere in the pack must not replace them.
        tip: embeddedTip || (linked ? linked.tip : null), dualOn: false, dualTip: undefined,
        bruDualRefUuid: null, bruLinkTemplate: null, _rawMeta: undefined
      });
      primary.dualOn = primary.bruDualEnabled === undefined
        ? !!(embeddedTip || (linked && linked.tip)) : primary.bruDualEnabled;
      primary.dualTip = sub.tip;
      primary.dualSubBrush = sub;
      primary.dualBrush = Object.assign({}, sub, {
        enabled: primary.dualOn, diameter: sub.sizePx, spacing: sub.spacingPct,
        blend: primary.dualBlendMode,
        name: sub.name, useScatter: sub.scatterOn, count: sub.scatterCount, bothAxes: sub.scatterBothAxes
      });
      if (primary.dualOn && !sub.tip && !sub.bruProceduralTip) warnings.push(primary.name + ': 双笔刷副笔参数已读取，但包内缺少对应笔尖图像');
    });
    return { version, totalSize, count: count || brushes.length, brushes, warnings };
  }

  const api = { isBru, writeBrush, writePack, parseBru, buildMetadata, MAGIC, dualBlendValue };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { bru: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
