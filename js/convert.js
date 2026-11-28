/* Conversion pipeline: detect -> parse -> normalize -> write .bru */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const nodePath = isNode ? require('path') : null;
  const util = isNode ? require('./util.js') : root.BC.util;
  const ir = isNode ? require('./ir.js') : root.BC.ir;
  const png = isNode ? require('./png.js') : root.BC.png;
  const hsjModel = isNode ? require('./model-hsjpro.js') : root.BC.modelHsjpro;
  const zip = isNode ? require('./zip.js') : root.BC.zip;
  const abr = isNode ? require('./abr.js') : root.BC.abr;
  const tpl = isNode ? require('./tpl.js') : root.BC.tpl;
  const procreate = isNode ? require('./procreate.js') : root.BC.procreate;
  const plist = isNode ? require('./plist.js') : root.BC.plist;
  const bplist = isNode ? require('./bplist.js') : root.BC.bplist;
  const bru = isNode ? require('./bru.js') : root.BC.bru;
  const gimp = isNode ? require('./gimp.js') : root.BC.gimp;
  const mypaint = isNode ? require('./mypaint.js') : root.BC.mypaint;
  const krita = isNode ? require('./krita.js') : root.BC.krita;
  const genericBrush = isNode ? require('./genericbrush.js') : root.BC.genericBrush;
  const csp = isNode ? require('./csp.js') : root.BC.csp;
  const sutWrite = isNode ? require('./sutWrite.js') : root.BC.sutWrite;
  const cspMaterial = isNode ? require('./cspMaterial.js') : root.BC.cspMaterial;
  const sqlite = isNode ? require('./sqlite.js') : root.BC.sqlite;
  const udongmanTemplate = isNode ? require('./udongmanTemplate.js') : root.BC.udongmanTemplate;
  const medibang = isNode ? require('./medibang.js') : root.BC.medibang;
  const medibangIni = isNode ? require('./medibangIni.js') : root.BC.medibangIni;
  const sai2read = isNode ? require('./sai2read.js') : root.BC.sai2read;
  const sai2dat = isNode ? require('./sai2dat.js') : root.BC.sai2dat;
  const sai2settings = isNode ? require('./sai2settings.js') : root.BC.sai2settings;
  const painterlib = isNode ? require('./painterlib.js') : root.BC.painterlib;
  const gobrush = isNode ? require('./gobrush.js') : root.BC.gobrush;
  const gobrushWrite = isNode ? require('./gobrushWrite.js') : root.BC.gobrushWrite;
  const sai2 = isNode ? require('./sai2.js') : root.BC.sai2;
  const infpainter = isNode ? require('./infpainter.js') : root.BC.infpainter;

  function pressureSizeOn(brush) {
    return brush.pressureSize === undefined ? !!brush.pressure : !!brush.pressureSize;
  }

  /* 锥度→PS渐隐（Fade）近似：ABR 没有锥度字段，用「渐隐」（控制码 1 + fStp 步数）
     模拟收笔时尺寸/不透明度衰减。ABR 每个笔尖属性只能挂一个控制源，
     笔压/倾斜已占用时不覆盖（优先保压感）。 */
  function abrTaperFade(brush) {
    if (!brush || !brush.taperOn) return { applied: false };
    const srcCtlSize = brush.dynamicsControlSize == null ? (pressureSizeOn(brush) ? 2 : (brush.tiltSizeDyn > 0 ? 3 : 0)) : brush.dynamicsControlSize;
    const srcCtlOpacity = brush.dynamicsControlOpacity == null ? (brush.pressureOpacity ? 2 : (brush.tiltOpacityDyn > 0 ? 3 : 0)) : brush.dynamicsControlOpacity;
    const taperSize = Math.max(0, Math.min(1, brush.taperSize === undefined ? 0.5 : brush.taperSize));
    const taperOpacity = Math.max(0, Math.min(1, brush.taperOpacity === undefined ? 0.5 : brush.taperOpacity));
    const out = { applied: false };
    if (!srcCtlSize && taperSize > 0.001) {
      out.sizeCtl = 1;
      out.sizeSteps = Math.round(24 + 96 * taperSize);
      out.applied = true;
    }
    if (!srcCtlOpacity && taperOpacity > 0.001) {
      out.opacityCtl = 1;
      out.opacitySteps = Math.round(24 + 96 * taperOpacity);
      out.applied = true;
    }
    return out;
  }

  function rawBrushUnchanged(brush, opts) {
    opts = opts || {};
    if (opts.fidelity === false || opts.forceRebuild || !brush._rawBrushState ||
        brush._rawBrushState !== util.brushFingerprint(brush)) return false;
    if ((opts.sizeScale !== undefined && opts.sizeScale !== 1) || opts.spacingOverride > 0 || opts.pressure !== undefined) return false;
    return !['scatter','grainMode','textureDepth','minSizeRatio','minOpacityRatio',
      'flowPct','pressureCurve','pressureCurves','prop18'].some(function (key) { return opts[key] !== undefined; });
  }

  // A SUT can contain current/initial variants. Preserve its private material
  // only when every parsed variant is selected and unchanged, including after
  // a Worker structured clone. A subset must never reintroduce hidden brushes.
  function rawSutGroup(brush, list, opts) {
    const group = brush && brush._rawSutGroup;
    if (!group || !group.bytes || (opts && /^(on|off)$/.test(opts.pressureMode))) return null;
    const members = list.filter(function (b) { return b._rawSutGroup === group; });
    if (members.length !== group.count) return null;
    const indices = new Set();
    for (const b of members) {
      if (!rawBrushUnchanged(b, opts)) return null;
      indices.add(b._rawSutIndex);
    }
    return indices.size === group.count ? group : null;
  }

  /* 原生 SUT 被修改后，优先在原文件上原位改写 Variant 参数：
     这样 material.layer（真实笔尖/纹理）、Effector 压感曲线、内置素材引用都不会被丢掉。
     只在完整选择同一 SUT 的全部变体、且没有要求强制重建/切换压感时才走这条路。 */
  function nativeSutMembers(brush, list) {
    const group = brush && brush._rawSutGroup;
    if (!group || !group.bytes) return null;
    const members = [];
    for (const b of list) {
      if (b && b._rawSutGroup === group) members.push({ brush: b, index: b._rawSutIndex });
    }
    if (!members.length || members.length !== group.count) return null;
    return { group: group, members: members };
  }

  function sutVariantTable(bytes) {
    const db = sqlite.read(bytes);
    return sqlite.getTable(db, 'Variant');
  }

  function filterSutParams(params, columns, dropped) {
    const out = {};
    for (const k in params) {
      if (columns.indexOf(k) >= 0) out[k] = params[k];
      else if (dropped && dropped.indexOf(k) < 0 && !(k === 'UseDualBrush' && !params[k])) dropped.push(k);
    }
    return out;
  }

  /* ---------- 写入口数值卫生（崩溃防护） ----------
     源文件可能畸形、截断或来自别的转换器，解析后得到 NaN / Infinity / 负值 /
     荒谬上限（例如 1e9 px 直径）。这些值一旦编进目标文件，目标软件读到就会
     分配巨型缓冲或断言失败（PS 的 sampledBrush 直径、Procreate 的
     ValkyrieStitcher 断言等都是这个路径）。
     这里只在「明显非法」时改动，合法值原样透传；各格式自己的上限钳制不变，
     钳制过的字段会挂在 _guardNotes 上，由写出口汇总成警告，不静默吞掉。 */
  const MIN_TEXTURE_SCALE = 0.01;
  const GUARD_RULES = [
    // [字段, 默认值, 下限, 上限]
    ['sizePx', null, 0.1, 5000],          // null = 用笔尖尺寸兜底
    ['spacingPct', 25, 0, 1000],
    ['roundness', 100, 0, 100],
    ['opacity', 1, 0, 1],
    ['flowPct', 1, 0, 1],
    ['hardness', 1, 0, 1],
    ['minSizeRatio', 0, 0, 1],
    ['minOpacityRatio', 0, 0, 1],
    ['sizeJitterPct', 0, 0, 100],
    ['angleJitterDeg', 0, 0, 360],
    ['roundnessJitterPct', 0, 0, 100],
    ['countJitterPct', 0, 0, 100],
    ['opacityJitterPct', 0, 0, 100],
    ['scatterPct', 0, 0, 1000],
    ['scatterCount', 1, 0, 100],
    /* textureDepth 不在这里兜底：NaN 由烘焙路径自己回退（round107 用例
       「非有限纹理深度回退默认值而不清空笔尖」验证过），写成 0 反而会改变
       烘焙后的笔尖 alpha。 */
    /* 【第269轮】textureScale 上限 100 是给 PS/Procreate 那种「平铺缩放百分比」的，
       但天生会画的 textureScale 是**从 grainScale 反推**出来的（第206轮实测
       tile ≈ 0.576 × grainScale²，再除以纹理像素宽），原生笔刷里 116/180/214 都是合法值。
       钳它的后果不是「数字变一点」：sanitizeBrushNumbers 会返回克隆对象，指纹随之变化，
       `rawBrushUnchanged` 立刻失效 —— 整包透传被跳过，变成整份重建，330KB 原生载荷全丢。
       实测证据：20 支的 `书法练习_*.gobrushes` 未改参数导出时 25.9MB → 14.6MB。 */
    ['textureScale', 1, MIN_TEXTURE_SCALE, 100, function (brush) {
      // BRU 的 f24 用 float32，合法下限再读回时略小于 JS 的 0.01。
      if (brush.source === 'bru' && brush.textureScale === Math.fround(MIN_TEXTURE_SCALE)) return true;
      /* 只放过「天生会画派生出来的有限值」（grainScale 上限 100 → 反推上限约 720px/纹理宽）：
         NaN / 越界值仍然回到通用钳制，别把保护一起丢掉。 */
      return !!(brush && brush.source === 'gopaint' && brush.gopaintGrainScale !== undefined &&
        Number.isFinite(brush.textureScale) && brush.textureScale > 0 && brush.textureScale <= 1000);
    }],
    ['textureRotate', 0, -360, 360],
    ['smoothingStrength', 0, 0, 1],
    ['dualDiameter', 30, 0.1, 5000],
    ['dualScatterPct', 0, 0, 1000],
    ['dualScatterCount', 1, 0, 100],
    ['dualFlow', 1, 0, 1],
    ['dualHardness', 1, 0, 1]
  ];
  const GUARD_DUAL_RULES = [
    ['diameter', 30, 0.1, 5000],
    ['scatterPct', 0, 0, 1000],
    ['count', 1, 0, 100],
    ['flow', 1, 0, 1],
    ['hardness', 1, 0, 1],
    ['spacing', 25, 0, 1000]
  ];

  function tipFallbackSize(brush) {
    const t = brush && brush.tip;
    const n = t && Math.max(Number(t.w) || 0, Number(t.h) || 0);
    return Number.isFinite(n) && n > 0 ? n : 40;
  }

  function guardValue(holder, key, def, min, max, notes, label) {
    const raw = holder[key];
    if (raw === undefined || raw === null) return null;
    const n = typeof raw === 'number' ? raw : Number(raw);
    /* AUDIT-20261111-05：NaN/Infinity 走兜底值后也必须再过一次上下限。sizePx 的兜底值取笔尖实际边长，
       本身没有上限——6000×1 的笔尖配 sizePx=NaN，以前直接把 6000 写进 ABR Dmtr，越过 5000px 防线。 */
    let v = Number.isFinite(n) ? n : Number(def);
    if (!Number.isFinite(v)) v = min;
    if (v < min) v = min;
    else if (v > max) v = max;
    if (v === n) return null;
    notes.push((label || key) + ' ' + (Number.isFinite(n) ? n : String(raw)) + '→' + v);
    return v;
  }

  function sanitizeBrushNumbers(brush) {
    if (!brush || typeof brush !== 'object' || brush instanceof Uint8Array) return brush;
    const notes = [];
    const patch = {};
    const sizeDefault = tipFallbackSize(brush);
    for (const rule of GUARD_RULES) {
      /* rule[4]：可选跳过判据。原生来源自己定义取值范围的字段（如天生会画的
         textureScale 由 grainScale 反推）不能被通用上限钳——钳了会改指纹，
         进而让「未改动就透传」失效，整包被迫重建（见 GUARD_RULES 里那条注释）。 */
      if (typeof rule[4] === 'function' && rule[4](brush)) continue;
      const def = rule[1] === null ? sizeDefault : rule[1];
      const v = guardValue(brush, rule[0], def, rule[2], rule[3], notes);
      if (v !== null) patch[rule[0]] = v;
    }
    // 角度不像尺寸那样有上限，但荒谬角度会让部分写端乘出 Infinity；
    // 只在超出 ±360 时归一化，避免改动合法的大角度。
    if (typeof brush.angle === 'number') {
      if (!Number.isFinite(brush.angle)) { patch.angle = 0; notes.push('angle ' + brush.angle + '→0'); }
      else if (brush.angle > 360 || brush.angle < -360) {
        const a = ((brush.angle % 360) + 360) % 360;
        patch.angle = a; notes.push('angle ' + brush.angle + '→' + a);
      }
    }
    let dualPatch = null;
    if (brush.dualBrush && typeof brush.dualBrush === 'object') {
      const dn = [];
      const dp = {};
      for (const rule of GUARD_DUAL_RULES) {
        const def = rule[1] === null ? sizeDefault : rule[1];
        const v = guardValue(brush.dualBrush, rule[0], def, rule[2], rule[3], dn, 'dualBrush.' + rule[0]);
        if (v !== null) dp[rule[0]] = v;
      }
      if (dn.length) { dualPatch = dp; notes.push(...dn); }
    }
    if (!notes.length) return brush;
    const out = Object.assign({}, brush, patch);
    if (dualPatch) out.dualBrush = Object.assign({}, brush.dualBrush, dualPatch);
    Object.defineProperty(out, '_guardNotes', { value: notes, enumerable: false, configurable: true });
    return out;
  }

  function collectGuardNotes(list) {
    const notes = [];
    const arr = Array.isArray(list) ? list : [list];
    for (const b of arr) {
      if (b && b._guardNotes) for (const n of b._guardNotes) if (notes.indexOf(n) < 0) notes.push(n);
    }
    return notes;
  }

  /* 【第186轮】sizeScale 的乘法发生在 GUARD 之后。
     GUARD（sanitizeBrushNumbers）在写出口包装层只消毒「入参 brush」，
     而 sizeScale 是在这里才乘上去的——sizeScale=1000 时 40px → 40000px，
     完全绕过 GUARD 的 5000 上限（实测 ABR 回读 Dmtr=40000、sizeScale=1e5 时 4e6，
     PS/Procreate 读到就是分配巨型缓冲或断言失败）。乘法之后必须再收一次。
     BRU 那条路径（makeBru 内 Math.min(3000)）本来就有上限，不受影响。 */
  const SCALED_SIZE_MAX = 5000;
  function clampScaledSize(v, def) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return def;
    return Math.min(SCALED_SIZE_MAX, Math.max(0.1, n));
  }
  function withSizeAndSpacing(brush, opts) {    opts = opts || {};
    const b = Object.assign({}, brush);
    if (Number.isFinite(opts.sizeScale) && opts.sizeScale > 0) {
      b.sizePx = clampScaledSize((brush.sizePx || 40) * opts.sizeScale, clampScaledSize(brush.sizePx, 40));
      /* 第201轮：记下钳制后实际生效的倍数。原生 XML 透传的写端（Krita .kpp）不用 sizePx、而是直接给 XML 里的
         diameter/scale 乘倍数，必须用这个值才不会绕过 5000px 上限（第189轮审查 P2-#12）。 */
      const unscaled = Number(brush.sizePx);
      if (Number.isFinite(unscaled) && unscaled > 0) b._sizeScaleApplied = b.sizePx / unscaled;
      if (brush.dualBrush && brush.dualBrush.diameter > 0) {
        b.dualBrush = Object.assign({}, brush.dualBrush, {diameter:clampScaledSize(brush.dualBrush.diameter * opts.sizeScale, clampScaledSize(brush.dualBrush.diameter, 30))});
      }
      if(brush.dualSubBrush && brush.dualSubBrush.sizePx>0)b.dualSubBrush=Object.assign({},brush.dualSubBrush,{sizePx:clampScaledSize(brush.dualSubBrush.sizePx*opts.sizeScale, clampScaledSize(brush.dualSubBrush.sizePx, 30))});
    }
    if (Number.isFinite(opts.spacingOverride) && opts.spacingOverride > 0) {
      b.spacingPct = opts.spacingOverride;
      if(brush.dualBrush)b.dualBrush=Object.assign({},b.dualBrush,{spacing:opts.spacingOverride});
    }
    return b;
  }

  function angleControlAliases(brush) {
    // Procreate exposes both target aliases. A changed control must not be
    // overwritten by the unchanged snapshot of the other target's setting.
    if (brush.source==='procreate' && brush._rawNormalized) {
      const before=brush._rawNormalized;
      if (brush.bruRotationMode!==before.bruRotationMode && brush.dynamicsControlAngle===before.dynamicsControlAngle) return Object.assign({},brush,{dynamicsControlAngle:brush.bruRotationMode===1?6:0});
      if (brush.dynamicsControlAngle!==before.dynamicsControlAngle && brush.bruRotationMode===before.bruRotationMode) return Object.assign({},brush,{bruRotationMode:brush.dynamicsControlAngle===6?1:0});
    }
    return brush;
  }
  function withExportSettings(brush, opts) {
    opts = opts || {};
    const b = withSizeAndSpacing(angleControlAliases(brush), opts);
    b.pressureSize = opts.pressure === undefined ? pressureSizeOn(brush) : !!opts.pressure;
    b.pressureOpacity = opts.pressure === false ? false : !!brush.pressureOpacity;
    b.pressure = b.pressureSize || b.pressureOpacity;
    return b;
  }

  function detect(name, bytes) {
    const lower = (name || '').toLowerCase();
    const safe = function (fn) { try { return !!fn(); } catch (e) { return false; } };
    if (/\.params\.json$/.test(lower)) return 'csp-decrypted';
    if (medibangIni && safe(function () { return medibangIni.isIni(bytes); })) return 'mbini';
    if (sai2read && safe(function () { return sai2read.isToolnrm(bytes); })) return 'sai2tool';
    if (sai2read.isBrushIni(bytes)) return 'sai2ini';
    if (sai2dat && safe(function () { return sai2dat.isSai2Preset(bytes); })) return 'sai2preset';
    if (bru && safe(function () { return bru.isBru(bytes); })) return 'bru';
    if (csp && safe(function () { return csp.isSut(bytes); })) return 'sut';
    if (gobrush && safe(function () { return gobrush.isGobrush(lower); })) return 'gobrush';
    if (zip && safe(function () { return zip.isZip(bytes); })) {
      let zentries = null;
      try { zentries = zip.read(bytes); } catch (e) { /* ignore */ }
      if (zentries) {
        if (zentries.some(e => /^brush2\.ini$/i.test(e.name.replace(/^.*\//, '')))) return 'mbini_set';
        if (sai2settings && safe(function () { return sai2settings.isSettingsPack(bytes); })) return 'sai2settings';
        if (sai2read.isSai2Pack(bytes,zentries)) return 'sai2pack';
        if (zentries.some(e => /^paintoppresets\/[^/]+\.kpp$/i.test(e.name))) return 'kbundle';
        if (lower.endsWith('.mtd')) return 'mtd'; // 优动漫绘画助手素材包（zip 壳），须先于 Painter 库判定
        /* 第201轮（第189轮审查 P2-#15）：Procreate 判定提到 Painter 之前。Painter 库的判定条件是「有任意 .xml」，
           带 readme.xml 之类附件的 .brushset 以前会被当成 Painter 库解析失败；Painter 库里不会有 Brush.archive。 */
        if (zentries.some(e => /Brush\.archive$/i.test(e.name))) return 'procreate';
        if (painterlib && safe(function () { return painterlib.isLibraryZip(bytes); })) return 'painter';
        if (lower.endsWith('.mtd')) return 'mtd';
        /* 第164轮：Infinite Painter .prbr 与 ZIP 壳的 .mdp 各自已有 reader，
           但过去 detect() 没接线，导致「转出到 .prbr/.mdp 后无法再转入」。
           放在所有容器特征之后，避免抢走 SAI2 / Procreate / Krita / 优动漫包。 */
        if (infpainter && safe(function () { return infpainter.isPrbr(bytes); })) return 'prbr';
        if (/\.mdp$/i.test(lower) && genericBrush && safe(function () { return genericBrush.isMdp(bytes, name); })) return 'mdpzip';
      }
      if (lower.endsWith('.prbr')) return 'prbr';
      if (lower.endsWith('.mdp')) return 'mdpzip';
      return null;
    }
    if (tpl && safe(function(){return tpl.isTpl(bytes);})) return 'tpl';
    /* MediBang 原生 .mdp 是 'mdipack' 魔数的二进制材质，不是 ZIP；reader 早已存在。 */
    if (medibang && safe(function () { return medibang.isMdp(bytes); })) return 'mdp';
    if (bytes && bytes.length > 10 && bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x54) return 'pat';
    if (abr && safe(function () { return abr.isAbr(bytes); })) return 'abr';
    if (krita && safe(function () { return krita.isKpp(bytes); })) return 'kpp';
    if (gimp && safe(function () { return gimp.isGbr(bytes); })) return /.gih$/i.test(lower) ? 'gih' : 'gbr';
    if (mypaint && safe(function () { return mypaint.isMyb(bytes); })) return 'myb';
    if (genericBrush && safe(function () { return genericBrush.isPainterXml(bytes); })) return 'painter';
    // extension fallbacks
    if (lower.endsWith('.abr')) return 'abr';
    if (lower.endsWith('.tpl')) return 'tpl';
    if (lower.endsWith('.bru')) return 'bru';
    if (lower.endsWith('.brush') || lower.endsWith('.brushset')) return 'procreate';
    if (lower.endsWith('.kpp')) return 'kpp';
    if (lower.endsWith('.gbr')) return 'gbr';
    if (lower.endsWith('.gih')) return 'gih';
    if (lower.endsWith('.myb')) return 'myb';
    if (lower.endsWith('.brushcategory') || lower.endsWith('.brushlibrary')) return 'painter';
    if (lower.endsWith('.sut')) return 'sut';
    if (lower.endsWith('.mtd')) return 'mtd';
    if (lower.endsWith('.gobrush') || lower.endsWith('.gobrushes')) return 'gobrush';
    if (lower.endsWith('.prbr')) return 'prbr';
    return null;
  }

  function extLabel(kind) {
    return {
      abr: 'Photoshop ABR',
      tpl: 'Photoshop 工具预设 TPL',
      procreate: 'Procreate 笔刷',
      bru: '画世界Pro BRU',
      kpp: 'Krita KPP',
      gbr: 'GIMP GBR',
      gih: 'GIMP GIH',
      myb: 'MyPaint MYB',
      painter: 'Corel Painter',
      mdp: 'MediBang MDP',
      prbr: 'Infinite Painter PRBR',
      mdpzip: 'MediBang MDP 笔刷包（ZIP）',
      sut: '优动漫 / CSP SUT（部分读取）',
      udongman: '优动漫 / CSP（ABR兼容）',
      gobrush: '天生会画 GoBrush',
      kbundle: 'Krita 资源包 BUNDLE',
      'csp-decrypted': 'CSP 解密目录',
      mbini: 'MediBang 云笔刷 Brush2.ini',
      'mbini_set': 'MediBang 云笔刷包',
      sai2pack: 'SAI 2 素材包',
      sai2ini: 'SAI 2 笔刷 ini',
      sai2tool: 'SAI 2 笔刷预设 toolnrm',
      sai2preset: 'SAI 2 原生工具预设（只读识别）',
      sai2settings: 'SAI 2 设置包（工具+素材，只读）',
      pat: 'Photoshop 图案 PAT',
      gobrushSet: '天生会画笔刷组'
    }[kind] || kind;
  }

  /** Krita resource bundle (.bundle): collect every paintoppresets/*.kpp. */
  function parseKritaBundle(name, bytes) {
    const entries = zip.read(bytes);
    const brushes = [];
    const warnings = [];
    const resourceMap = {};
    for (const e of entries) {
      try {
        const d = e.data();
        const buf = d instanceof Uint8Array ? d : new Uint8Array(d);
        resourceMap[e.name] = buf;
        const base = String(e.name).replace(/^.*\//, '');
        if (!resourceMap[base]) resourceMap[base] = buf;
      } catch (err) { /* skip */ }
    }
    for (const entry of entries) {
      if (!/^paintoppresets\/[^/]+\.kpp$/i.test(entry.name)) continue;
      // 第一轮已经解压并做过 CRC 校验，直接复用，避免同一 KPP 再 inflate 一次。
      const data = resourceMap[entry.name];
      if (!data) { warnings.push(entry.name + ' 读取失败'); continue; }
      try {
        const r = krita.parseKpp(data, entry.name, resourceMap);
        (r.brushes || []).forEach(function (b) {
          b.source = 'krita';
          b.bundle = name;
          brushes.push(b);
        });
        (r.warnings || []).forEach(function (w) { warnings.push(w); });
      } catch (e) {
        warnings.push(entry.name + ': ' + e.message);
      }
    }
    if (!brushes.length) throw new Error('Krita 资源包里没有可用预设');
    return { brushes, warnings };
  }

  function b64ToBytes(s) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(String(s), 'base64'));
    const bin = atob(String(s));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** 优动漫 .mtd（绘画助手素材包，实测与逆向确认的 zip 壳）。两种形态：
   *  1) 内含 .sut 成员 → 逐个 parseSut，参数真实可转换；
   *  2) 仅 CSP 素材文件夹（catalog.xml + data/material.layer + thumbnail）→
   *     material.layer 是 C2F 私有加密容器（实测高熵，无法解出参数），
   *     此时诚实报错并给出解锁路径，不产出假笔刷。 */
  function parseMtd(name, bytes) {
    let entries;
    try { entries = zip.read(bytes); } catch (e) { throw new Error('这个 .mtd 不是有效的 zip 素材包：' + e.message); }
    const warnings = [];
    const sutEntries = [];
    let catalogXml = null;
    let hasMaterialLayer = false;
    for (const e of entries) {
      if (e.dir) continue;
      const norm = e.name.replace(/\\/g, '/');
      const base = norm.split('/').pop();
      if (/\.sut$/i.test(base)) sutEntries.push({ name: base, data: e.data() });
      else if (/^catalog\.xml$/i.test(base)) {
        // 取最浅层（zip 可能包一层 uuid 目录）
        if (!catalogXml || norm.split('/').length < catalogXml.path.split('/').length) catalogXml = { data: e.data(), path: norm };
      } else if (/material\.layer$/i.test(norm)) hasMaterialLayer = true;
    }
    if (sutEntries.length) {
      const brushes = [];
      for (const s of sutEntries) {
        let r;
        try { r = csp.parseSut(s.data, s.name); } catch (err) { warnings.push('跳过无法解析的 ' + s.name + '：' + err.message); continue; }
        for (const b of (r.brushes || [])) brushes.push(Object.assign({}, b, { source: 'mtd' }));
        if (r.warnings && r.warnings.length) warnings.push(...r.warnings);
      }
      if (!brushes.length) throw new Error('这个 .mtd 里的 .sut 都无法解析');
      // 多个 .sut 的读取限制警告通常逐个重复，去重后再展示
      const dedup = [];
      for (const w of warnings) if (dedup.indexOf(w) < 0) dedup.push(w);
      dedup.unshift('已从优动漫素材包' + (name ? '「' + name + '」' : '') + '内的 ' + sutEntries.length + ' 个 .sut 解析出笔刷');
      return { brushes: brushes, warnings: dedup };
    }
    if (catalogXml || hasMaterialLayer) {
      let matName = '';
      if (catalogXml) {
        try {
          const text = util.utf8Decode(catalogXml.data);
          const m = text.match(/<name>([\s\S]*?)<\/name>/);
          if (m) matName = m[1].trim();
        } catch (e) { void e; }
      }
      throw new Error(
        '这是优动漫「绘画助手」导出的加密素材包（.mtd）：笔刷参数存于 CELSYS 私有加密容器（material.layer），本工具无法读取' +
        (matName ? '（素材名：' + xmlUnescape(matName) + '）' : '') + '。' +
        '要转换参数请：双击 .mtd 用绘画助手安装到优动漫 PAINT → 在子工具面板选中该笔刷 → 面板菜单导出子工具（.sut）→ 再把 .sut 拖入本工具。'
      );
    }
    throw new Error('.mtd 里既没有 .sut 也没有 CSP 素材结构（catalog.xml / material.layer），无法识别');
  }

  function xmlUnescape(s) {
    return String(s || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /* BRU f7 引用内置 psN 或预设自带的 textures/ 文件。纹理 f6 与笔尖独立。 */
  function builtinTipKey(b) {
    if (!b) return null;
    const old = String(b.oldTexId || '').replace(/\u0000+$/, '').replace(/\\/g, '/').toLowerCase();
    return /^(?:ps[1-9][0-9]*|textures\/[a-z0-9_-]+\.png)$/.test(old) ? old : null;
  }

  function restoreHsjTips(result, opts) {
    if (!result || !result.brushes) return 0;
    const missing = result.brushes.filter(function (b) { return b.source === 'bru' && !b.tip && builtinTipKey(b); });
    if (!missing.length) return 0;
    let lib = null;
    if (isNode) {
      /* 小包版/网页包可能不带 core/hsj-shapes.js（14MB）。缺文件按「没有内置库」处理：
         浏览器端 root.BC.hsjShapes 为空时本来就 return 0，Node 端不该反过来抛
         MODULE_NOT_FOUND 把整次解析带崩。其它 require 错误照常抛出。 */
      try { lib = require('./hsj-shapes.js'); }
      catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; }
    } else lib = root.BC.hsjShapes;
    const resMap = opts && opts.shapeResources && typeof opts.shapeResources.get === 'function' ? opts.shapeResources : null;
    if (!lib && !resMap) return 0;
    let count = 0;
    missing.forEach(function (b) {
      const key = builtinTipKey(b);
      const raw = lib ? lib.get(key) : null;
      const file = key.startsWith('textures/') ? key.slice('textures/'.length) : key + '.png';
      const pngBytes = raw ? b64ToBytes(raw) : resMap && resMap.get(file);
      if (!(pngBytes instanceof Uint8Array)) return;
      let image;
      try { image = png.decode(pngBytes); } catch (e) { return; }
      b.tip = { w: image.width, h: image.height, rgba: png.toMaskRgba(image.rgba) };
      b._tipFromBuiltin = b.oldTexId;
      if (b.tipSource === 'synth') delete b.tipSource;
      count++;
    });
    result.brushes.forEach(function (b) {
      if (!b || b.source !== 'bru' || !b.dualSubBrush || b.dualSubBrush.tip) return;
      const sub = b.dualSubBrush;
      const key = builtinTipKey(sub);
      if (!key) return;
      const raw = lib ? lib.get(key) : null;
      const file = key.startsWith('textures/') ? key.slice('textures/'.length) : key + '.png';
      const pngBytes = raw ? b64ToBytes(raw) : resMap && resMap.get(file);
      if (!(pngBytes instanceof Uint8Array)) return;
      let image;
      try { image = png.decode(pngBytes); } catch (e) { return; }
      const tipObj = { w: image.width, h: image.height, rgba: png.toMaskRgba(image.rgba) };
      sub.tip = tipObj;
      sub._tipFromBuiltin = sub.oldTexId;
      b.dualTip = tipObj;
      if (b.dualBrush) {
        b.dualBrush.tip = tipObj;
        b.dualBrush._tipFromBuiltin = sub.oldTexId;
      }
    });
    return count;
  }

  /* 【第272轮】Procreate 内置素材的事后补挂（restoreHsjTips 的同族）：
     用户的常见顺序是「先导笔刷包、再导/下载素材库」。解析那一刻库还没到位，
     `bundledShapePath`/`bundledGrainPath` 解析不出图，笔刷被定型成无笔尖/无纹理；
     之后再导库不会自动回头补 —— 表现就是「导入了图库，转出来还是实色」。
     这里在库可用时统一回补一次，返回补到的项数。 */
  function restoreProcreateBundled(result, opts) {
    if (!result || !result.brushes || !procreate || typeof procreate.attachBundledAssets !== 'function') return 0;
    const resMap = opts && opts.shapeResources && typeof opts.shapeResources.get === 'function' ? opts.shapeResources : null;
    if (!resMap) return 0;
    let count = 0;
    for (const b of result.brushes) count += procreate.attachBundledAssets(b, resMap);
    return count;
  }

  function parseFile(name, bytes, opts) {
    const kind = detect(name, bytes);
    if (!kind) throw new Error('无法识别的文件格式（支持 .bru/.abr/.tpl/.brush/.brushset/.gobrush/.gobrushes/.sut/.mtd/.kpp/.gbr/.gih/.myb/.prbr/.mdp/.brushcategory/.brushlibrary，或包含笔刷的 ZIP）');
    let result;
    if (kind === 'sai2settings') {
      /* SAI2 设置包（custool + 素材目录）：结构可读，参数语义未标定，本版只给清单。 */
      let sum = null;
      try { sum = sai2settings.readSettingsPack(bytes); } catch (e) { sum = null; }
      throw new Error('SAI2 设置包：' + (sum ? sai2settings.summarize(sum) : '可识别') +
        '；本版只读清单，暂不转换为其它格式（字段语义未标定）');
    } else if (kind === 'sai2preset') {
      /* 第153轮：SAI2 原生工具预设（.saitdat/.saitgrp/.saitset/.saitlnk）结构已解开，
         但字段语义（cursize 刻度等）尚未原生标定，本版只做识别与说明，不猜映射。 */
      const info = sai2dat.identify(bytes);
      const label = sai2dat.KIND_LABEL[info.kind] || '预设';
      throw new Error('SAI2 原生' + label + (info.name ? '「' + info.name + '」' : '') +
        '：文件结构可读，但字段语义尚未标定，本版不提供转换（可用 _testout/native153/sai2/saitdat_tool.js dump 查看字段）');
    } else if (kind === 'bru') {
      result = bru.parseBru(bytes);
      result.brushes.forEach(function (b) {
        rememberProcreateGrain(b, b._rawTipPng);
        b._pcScalar = readPcScalar(b._rawTipPng);
        b._nativeArchiveBackup = readNativeArchive(b._rawTipPng);
        b._procreateDualBridge = dualBridgeRead(b._rawTipPng);
        if (!b._procreateDualBridge && dualBridgePresent(b._rawTipPng)) b._procreateDualBridgeInvalid = true;
        // The resolved secondary is a separate object, even when it also has
        // a standalone BRU record. An embedded tip takes precedence over it.
        if (b.dualSubBrush) {
          const embedded = (b.embeddedTips || []).find(function (tip) { return !tip.isSubGrain; });
          const secondaryPng = embedded ? embedded.raw : b.dualSubBrush._rawTipPng;
          const id = String(b.dualSubBrush.texAssetId || '').toUpperCase();
          const grainCandidates = (b.embeddedTips || []).filter(function (tip) {
            return tip !== embedded && tip.raw && /^[0-9A-F]{32}$/.test(id) && util.md5(tip.raw).toUpperCase() === id;
          });
          if (grainCandidates.length === 1) {
            const grain = grainCandidates[0];
            b.dualSubBrush._rawBruTexture = grain.raw;
            b.dualSubBrush._grainRgba = {w:grain.w, h:grain.h, rgba:grain.rgba};
          }
          if (b.dualSubBrush._rawBruTexture) {
            if (/^[0-9A-F]{32}$/.test(id) && util.md5(b.dualSubBrush._rawBruTexture).toUpperCase() === id) {
              b.dualSubBrush.source = 'bru';
            } else {
              delete b.dualSubBrush._rawBruTexture;
              delete b.dualSubBrush._grainRgba;
            }
          }
          rememberProcreateGrain(b.dualSubBrush, secondaryPng);
          b.dualSubBrush._pcScalar = readPcScalar(secondaryPng);
          b.dualSubBrush._nativeArchiveBackup = readNativeArchive(secondaryPng);
          b.dualSubBrush._noShapeMark = readProcreateMarkChunk(secondaryPng);
        }
        /* 【第348轮（作者：Lead）】极简标记（源无 Shape / bundledShapePath），与 grain chunk 独立。 */
        const mark = readProcreateMarkChunk(b._rawTipPng);
        if (mark) b._noShapeMark = mark;
      });
      result.brushes = result.brushes.map(b => Object.assign({}, b, { source: 'bru' }));
      restoreHsjTips(result, opts);
      // #23（WorkBuddy 第106轮）：BRU f115（旋转方式）→ PS 角度控制源逆映射。
      // 1=跟随笔迹方向(6)、2=初始方向(5)、3=笔压(2)；0=固定不映射。
      // BRU→BRU 写出仍直接用 bruRotationMode，不受影响。
      result.brushes.forEach(function (b) {
        if (b.dynamicsControlAngle === undefined && (b.bruRotationMode || 0) > 0) {
          const inv = { 1: 6, 2: 5, 3: 2 }[b.bruRotationMode];
          if (inv) b.dynamicsControlAngle = inv;
        }
      });
      /* 画世界的官方/内置笔刷经常【没有内嵌笔尖位图】（实测「小方块」只有 450B，
         f7 与图长都是空），笔尖由 App 内部资源提供。这种文件重新生成一遍必然
         变样 —— 单支且参数没被改过时直接抄回原字节，图案与导入前逐字节相同。
         多支合计成一个文件时不能拿整包字节顶单支，所以只给单支挂。 */
      if (result.brushes.length === 1) result.brushes[0]._rawBru = new Uint8Array(bytes);
      result.brushes.forEach(function (b) { b._rawBrushState = util.brushFingerprint(b); });
    } else if (kind === 'csp-decrypted') {
      if (!(opts && opts.decrypted && opts.decrypted.json)) {
        throw new Error('这是 CSP 解密目录里的参数文件；请把整个 _decrypted 目录（或包含它的压缩包）导入');
      }
      const dec = opts.decrypted;
      const tips = (dec.tips || []).map(function (b64) {
        if (!b64) return null;
        try {
          const img = png.decode(b64ToBytes(b64));
          return { w: img.width, h: img.height, rgba: png.toMaskRgba(img.rgba) };
        } catch (e) { return null; }
      });
      result = csp.parseDecryptedAssets(dec.json, tips, dec.name || name.replace(/\.params\.json$/i, ''));
    } else if (kind === 'tpl') {
      result = tpl.parse(bytes);
    } else if (kind === 'pat') {
      const patReader = isNode ? require('./patRead.js') : root.BC.patRead;
      const pats = patReader.readPat(bytes);
      if (!pats.length) throw new Error('这个 .pat 里没有可读取的图案');
      result = {
        brushes: pats.map(function (pt) {
          const n = pt.width * pt.height;
          const rgba = new Uint8Array(n * 4);
          for (let i = 0; i < n; i++) {
            const v = pt.gray[i];
            rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = v;
          }
          return {
            name: pt.name || 'pattern',
            tip: { w: pt.width, h: pt.height, rgba: rgba },
            sizePx: Math.max(pt.width, pt.height),
            spacingPct: 100,
            // 图案本身就是笔尖形状：若再挂 hasTexture，makeBru/makeAbr 会把同一份像素
            // 当纹理再烘一遍，笔尖被二次压暗。保留 _patternPixels 供其它分析使用，
            // 但不再声明“独立纹理”。
            hasTexture: false,
            _patternPixels: { w: pt.width, h: pt.height, mode: 1, data: pt.gray },
            source: 'pat'
          };
        }),
        warnings: ['图案文件按笔尖图像导入：图案即笔尖形状，不再叠加为独立纹理（避免双重烘焙压暗）']
      };
    } else if (kind === 'mbini' || kind === 'mbini_set') {
      let text = util.utf8Decode(bytes);
      let files = null;
      if (kind === 'mbini_set') {
        files = {};
        let iniBytes = null;
        for (const e of zip.read(bytes)) {
          if (e.dir) continue;
          const data = e.data();
          const base = e.name.replace(/^.*\//, '');
          files[base] = data;
          files[e.name] = data;
          if (/^brush2\.ini$/i.test(base)) iniBytes = data;
        }
        if (!iniBytes) throw new Error('压缩包里没有 Brush2.ini');
        text = util.utf8Decode(iniBytes);
      }
      result = medibangIni.parseIni(text, files, name);
    } else if (kind === 'painterlib') {
      result = painterlib.parseLibrary(bytes, name);
    } else if (kind === 'sai2tool') {
      result = sai2read.parseToolnrm(bytes);
    } else if (kind === 'sai2pack') {
      result = sai2read.parsePack(bytes, name);
    } else if (kind === 'sai2ini') {
      result = sai2read.parseBrushIni(bytes, name);
    } else if (kind === 'kbundle') {
      result = parseKritaBundle(name, bytes);
    } else if (kind === 'procreate') {
      result = procreate.parse(bytes, name, opts);
    } else if (kind === 'kpp') {
      result = krita.parseKpp(bytes, name);
    } else if (kind === 'gbr') {
      result = gimp.parseGbr(bytes, name);
    } else if (kind === 'gih') {
      result = gimp.parseGih(bytes, name);
    } else if (kind === 'myb') {
      result = mypaint.parseMyb(bytes, name);
    } else if (kind === 'painter') {
      if (zip.isZip(bytes)) {
        result = painterlib.parseLibrary(bytes, name);
      } else {
        result = genericBrush.parsePainter(bytes, name);
      }
    } else if (kind === 'gobrush') {
      result = gobrush.parse(bytes, name);
    } else if (kind === 'prbr') {
      /* 第164轮：补上「转出 → 转入」闭环，reader 本来就在 core/infpainter.js。 */
      result = infpainter.parsePrbr(bytes, name);
      result.brushes = (result.brushes || []).map(b => Object.assign({}, b, { source: 'prbr' }));
    } else if (kind === 'mdp') {
      result = medibang.parseMdp(bytes, name);
      result.brushes = (result.brushes || []).map(b => Object.assign({}, b, { source: 'mdp' }));
    } else if (kind === 'mdpzip') {
      result = genericBrush.parseMdp(bytes, name);
      result.brushes = (result.brushes || []).map(b => Object.assign({}, b, { source: 'mdpzip' }));
    } else if (kind === 'mtd') {
      result = parseMtd(name, bytes);
    } else if (kind === 'sut') {
      // Prefer a decrypted companion dump when it exists next to the .sut:
      // <dir>/_decrypted/<basename>/<name>.params.json + real material tips.
      let decryptedDir = null;
      if (isNode && opts && opts.path) decryptedDir = csp.findDecryptedFor(opts.path);
      if (decryptedDir) {
        result = csp.parseDecrypted(decryptedDir);
      } else if (opts && opts.decrypted && opts.decrypted.json) {
        // Desktop renderer sends the decrypted dump via IPC (params + base64 tips)
        const dec = opts.decrypted;
        const tips = (dec.tips || []).map(function (b64) {
          if (!b64) return null;
          try {
            const img = png.decode(b64ToBytes(b64));
            return { w: img.width, h: img.height, rgba: png.toMaskRgba(img.rgba) };
          } catch (e) { return null; }
        });
        result = csp.parseDecryptedAssets(dec.json, tips, (dec.name || name).replace(/\.[^.]+$/, ''));
      } else {
        result = csp.parseSut(bytes, name);
      }
    } else {
      result = abr.parse(bytes);
      /* 【第266轮】整包透传：记下原始字节与序号，makeAbrPack 在「原封不动」时直接回吐 */
      if (result && result.brushes && result.brushes.length) {
        const pack = { bytes: new Uint8Array(bytes), count: result.brushes.length };
        result.brushes.forEach(function (b, i) {
          b._rawAbrPack = pack;
          b._rawAbrIndex = i;
          /* 【第270轮】基线必须在这里（解析收尾处）就记下。
             以前只在 makeAbrPack 里「首次遇到时懒初始化」，而那时拿到的是**已经被用户改过**
             的指纹 —— 于是「打开 .abr → 改尺寸 → 导出」判定成「没动过」，直接回吐原始字节，
             用户的修改被整段吞掉（实测 control.abr 第0支 10px 改 15px，导出后回读还是 10px、
             输出与源文件逐字节相同）。基线放在 parseFile 收尾处，才能反映「用户动没动」。 */
          b._rawAbrBase = util.brushFingerprint(b);
        });
      }
    }
    if (kind === 'sut' && result.brushes.length) {
      // 原位改写时要写回 NodeName，必须用原笔刷名而不是文件名，否则用户的笔刷名会被
      // 「另存为的 .sut 文件名」覆盖（第137轮：BC136_RINGCS 被改成 BC136_texture_native）。
      let originName = String((result.brushes[0] && result.brushes[0].name) || '');
      // Only the parser-added multi-variant suffix is bookkeeping. A real
      // NodeName may itself end in " #12" or ".sut"; keep that name intact.
      if (result.brushes.length > 1) originName = originName.replace(/ #\d+$/, '');
      const group = {bytes:new Uint8Array(bytes), count:result.brushes.length,
        name:originName || (name || '').replace(/^.*[\\/]/,'').replace(/\.sut$/i,'') || 'brush'};
      result.brushes.forEach(function (b, i) {
        b._rawSutGroup = group;
        b._rawSutIndex = i;
        b._rawBrushState = util.brushFingerprint(b);
      });
    }
    const out = { kind, kindLabel: extLabel(kind), brushes: result.brushes, warnings: result.warnings || [] };
    /* 【第189轮】散布 pipe（sel0:random 多 cell）里 cell 数 ≠ 笔刷数，透传这个标记，
       上层才不会把「4 个偏移副本」当成「4 支笔刷」。 */
    if (result.scatterPipe) out.scatterPipe = true;
    // Procreate .brushset 的组名（brushset.plist 的 name）：导出时原样写回，避免退回第一支笔刷名
    if (result.name !== undefined) out.name = result.name;
    return out;
  }

  /** ABR 和 Procreate 解析会分片让出主线程并回报进度。 */
  async function parseFileAsync(name, bytes, opts) {
    opts = opts || {};
    const kind = detect(name, bytes);
    if (kind === 'abr') {
      const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
      const r = await abr.parseAsync(bytes, { onProgress: onProgress || undefined });
      return { kind: 'abr', kindLabel: extLabel('abr'), brushes: r.brushes, warnings: r.warnings || [] };
    }
    if (kind === 'procreate') {
      const r = await procreate.parseAsync(bytes, name, opts);
      const out = { kind, kindLabel: extLabel(kind), brushes: r.brushes, warnings: r.warnings };
      if (r.name !== undefined) out.name = r.name;
      return out;
    }
    return parseFile(name, bytes, opts);
  }

  function tipToRGBA(brush) {
    const tip = brush.tip;
    if (!tip) return null;
    if (tip.rgba) return { w: tip.w, h: tip.h, rgba: tip.rgba };
    if (tip.data) {
      const w = tip.w, h = tip.h, data = tip.data;
      const bpp = tip.bpp || 1;
      const rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        let a;
        if (bpp === 2) a = data[i * 2]; // 16-bit: take high byte
        else a = data[i];
        const o = i * 4;
        rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255; rgba[o + 3] = a;
      }
      return { w, h, rgba };
    }
    return null;
  }

  /* Synthesize a round brush tip when the source brush has no bitmap tip */
  /* Synthesize a simple round brush tip when the source brush has no bitmap tip.
     Uses hardness (edge falloff) and roundness (ellipse) only — no style guessing. */
  function synthTip(brush, n, opts) {
    n = n || 256;
    const hard = Math.max(0.05, Math.min(1, brush.hardness === undefined ? 0.75 : brush.hardness));
    const round = Math.max(0.05, Math.min(1, (brush.roundness === undefined ? 100 : brush.roundness) / 100));
    const rgba = new Uint8Array(n * n * 4);
    const cx = (n - 1) / 2;
    const angle = ((brush.angle || 0) * Math.PI) / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = (x - cx) / cx, dy = (y - cx) / cx;
        const rx = dx * cos + dy * sin;
        const ry = -dx * sin + dy * cos;
        const d = Math.sqrt(rx * rx + (ry / round) * (ry / round));
        let a;
        if (d >= 1) a = 0;
        else if (d <= hard) a = 1;
        else {
          const t2 = (1 - d) / (1 - hard);
          a = t2 * t2 * (3 - 2 * t2);   // smoothstep，接近 PS 柔边圆的高斯衰减
        }
        const o = (y * n + x) * 4;
        rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255;
        rgba[o + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
      }
    }
    return { w: n, h: n, rgba: rgba };
  }

  /* Bilinear sample of RGBA image (returns 0 alpha outside) */
  function sampleBilinear(rgba, w, h, x, y) {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return [0, 0, 0, 0];
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const out = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      const p00 = rgba[(y0 * w + x0) * 4 + c], p10 = rgba[(y0 * w + x1) * 4 + c];
      const p01 = rgba[(y1 * w + x0) * 4 + c], p11 = rgba[(y1 * w + x1) * 4 + c];
      out[c] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
    }
    return out;
  }

  /* Apply Photoshop-style angle / roundness / flip to a sampled tip, so the
     transformed appearance is baked into the pixels (画世界Pro does not apply a tip transform).
     Uses an expanded canvas to avoid clipping, then crops to the alpha bounding box. */
  function bakeTipTransform(img, brush) {
    const angle = ((brush.angle || 0) % 360) * Math.PI / 180;
    const round = brush.roundness === undefined ? 1 : Math.max(0.05, Math.min(1, brush.roundness / 100));
    const flipX = !!brush.flipX, flipY = !!brush.flipY;
    const cos = Math.abs(Math.cos(angle)) < 1e-12 ? 0 : Math.cos(angle);
    const sin = Math.abs(Math.sin(angle)) < 1e-12 ? 0 : Math.sin(angle);
    const rotNeeded = Math.abs(sin) > 0.001 || Math.abs(cos - 1) > 0.001;
    if (!rotNeeded && round >= 0.995 && !flipX && !flipY) return img;
    const w = img.w, h = img.h, src = img.rgba;
    // A mirror changes pixel positions, not the brush canvas or its center.
    // Cropping the alpha bounds here would enlarge sparse/off-center stamps.
    if (!rotNeeded && round >= 0.995) {
      const out = new Uint8Array(src.length);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = ((flipY ? h - 1 - y : y) * w + (flipX ? w - 1 - x : x)) * 4;
        out.set(src.subarray(i, i + 4), (y * w + x) * 4);
      }
      return { w, h, rgba: out };
    }
    // required half extents after squash+rotation of the canvas rect
    let maxX = 0, maxY = 0;
    const cx0 = (w - 1) / 2, cy0 = (h - 1) / 2;
    for (const sx of [-cx0, cx0]) {
      for (const sy of [-cy0, cy0]) {
        const sY = sy * round;
        const rx = cos * sx - sin * sY;
        const ry = sin * sx + cos * sY;
        if (Math.abs(rx) > maxX) maxX = Math.abs(rx);
        if (Math.abs(ry) > maxY) maxY = Math.abs(ry);
      }
    }
    const outW = Math.max(w, Math.ceil(maxX * 2) + 3);
    const outH = Math.max(h, Math.ceil(maxY * 2) + 3);
    const ocx = (outW - 1) / 2, ocy = (outH - 1) / 2;
    const out = new Uint8Array(outW * outH * 4);
    let minX = outW, minY = outH, maxBX = -1, maxBY = -1;
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        let dx = x - ocx, dy = y - ocy;
        if (flipX) dx = -dx;
        if (flipY) dy = -dy;
        // inverse of (squash Y by roundness, then rotate by angle)
        const rx = cos * dx + sin * dy;
        const ry = -sin * dx + cos * dy;
        const sx = rx + cx0;
        const sy = ry / round + cy0;
        const px = sampleBilinear(src, w, h, sx, sy);
        if (px[3] <= 1) continue;
        const o = (y * outW + x) * 4;
        out[o] = px[0]; out[o + 1] = px[1]; out[o + 2] = px[2]; out[o + 3] = px[3];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxBX) maxBX = x;
        if (y > maxBY) maxBY = y;
      }
    }
    if (maxBX < 0) return img;
    // crop to content
    const cw = maxBX - minX + 1, ch = maxBY - minY + 1;
    if (cw === outW && ch === outH) return { w: outW, h: outH, rgba: out };
    const cropped = new Uint8Array(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      const srcOff = ((minY + y) * outW + minX) * 4;
      cropped.set(out.subarray(srcOff, srcOff + cw * 4), y * cw * 4);
    }
    return { w: cw, h: ch, rgba: cropped };
  }

  /* 文件系统安全的基名。第189轮审查 P2-#22：保留设备名（含 CONIN$/CONOUT$/CLOCK$ 与
     COM¹/LPT² 上标变体）、尾随点空格、控制字符、双向隔离字符 U+2066-2069、以及
     preserveFileName 完全不限长（300 字符原样落盘）都要收口；截断必须按码点，别切代理对。
     具体规则在 util.fileBase，SAI2 那条独立路径共用同一份实现。 */
  function sanitizeName(name, index, preserveFileName) {
    // NFD（macOS 解压）先在 util 里归一化成 NFC，避免同名被当成两份
    return util.fileBase(name, {
      maxLen: preserveFileName ? 120 : 60,
      collapse: !preserveFileName,
      fallback: 'brush_' + String(index + 1).padStart(3, '0')
    });
  }

  /**
   * Convert one parsed brush to a .bru file.
   * opts: { maxTipSize, sizeScale, spacingOverride, pressure }
   */
  function genUuid() {
    const hex = '0123456789abcdef';
    let out = '';
    const rnd = util.randomBytes ? util.randomBytes(16) : null;
    for (let i = 0; i < 16; i++) {
      const b = rnd ? rnd[i] : Math.floor(Math.random() * 256);
      if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
      out += hex[b >> 4] + hex[b & 15];
    }
    return out;
  }

  /* 【第275轮】非 BRU 源的双笔刷**默认**要拆成「主笔 + 辅助条目」，不再等用户选写法。
     理由：Procreate/PS 的副笔语义是「与主笔混合」，画世界的双笔是「两支各落一次」；
     第181轮真机实测过把非 BRU 副笔直接内嵌会**重影**。而「拆成主笔+辅助条目」是画世界
     自己的原生双笔结构（主笔 f119=1 + f121 指向副笔），不会重影，且副笔参数可单独调。
     所以：BRU 原生双笔 → 仍走内嵌（真原生）；非 BRU 双笔 → 默认走 pair。 */
  function dualNeedsPair(brush, opts) {
    if (!brush || !brush.dualOn || !brush.dualTip) return false;
    if (brush.source === 'bru' || brush._nativeDualFromBru) return false;
    const d = brush.dualTip;
    if (!(d.rgba || d.data)) return false;
    /* 【第293轮 R293-01（WorkBuddy 真机）】颗粒要写成独立纹理层的笔刷**不能拆双笔**：
       拆出来的辅助条目是一支不透明、无纹理的实心尖，混合模式「叠加」，会把主笔的颗粒整片压平
       （同一支笔：拆 = grain 0.0232，不拆（副笔烘进笔尖）= 0.0622，与源缩略图 0.0632 基本重合；
       把「双重笔刷」一关立刻回到 0.0625 —— 压平颗粒的就是辅助笔本身）。
       所以这类保持「副笔烘进笔尖 + 独立纹理层」，判据直接复用 grainLayerWillApply，避免两处口径漂移。 */
    return !grainLayerWillApply(brush, opts);
  }

  function buildBruDualPairBrushes(brush) {
    const d = brush.dualTip;
    if (!d || (!d.rgba && !d.data)) return null;
    let tip;
    if (d.rgba) tip = { w: d.w, h: d.h, rgba: d.rgba };
    else {
      const bpp = d.bpp || 1;
      const rgba = new Uint8Array(d.w * d.h * 4);
      for (let i = 0; i < d.w * d.h; i++) {
        const a = bpp >= 3 ? Math.max(d.data[i * bpp], d.data[i * bpp + 1], d.data[i * bpp + 2]) : d.data[i];
        rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = a;
      }
      tip = { w: d.w, h: d.h, rgba: rgba };
    }
    const info = brush.dualBrush || {};
    const secUuid = genUuid();
    const priUuid = genUuid();
    const pkgUuid = genUuid();
    const sub = brush.dualSubBrush || {};
    // 【第355轮实机对比】原生 Procreate 组合笔刷的 Sub01 往往带合并前的残留默认尺寸(如 0.24/0.50/1.00，#12 53px 配 422px、#22 347px 配 92px)
    // 及无散布主笔下的大副笔散布(#23 主 0% 配副 46.8% → 爆高 3.4 倍)。仅对真 Procreate 解析对象同步副笔尺寸并裁剪无散主笔的副笔散布；
    // difference 镂空内核(#03)、>500px 超大铺抹(#26/#30/#34)、BRU 往返(_nativeDualFromBru)与合成测试对象均不动。
    const isNativeProDual = brush.source === 'procreate' && !brush._nativeDualFromBru &&
      !!brush._params && !!(sub && sub._params);
    const rawSubSize = Math.max(1, Math.round(info.diameter || brush.sizePx || 100));
    const subPSz = Number(sub && sub._params && sub._params.paintSize);
    const subHasStaleDefaultPSz = Number.isFinite(subPSz) &&
      (Math.abs(subPSz - 0.24) < 0.015 || Math.abs(subPSz - 0.5) < 0.015 || Math.abs(subPSz - 1.0) < 0.015);
    const isHollowDual = brush.procreateDualBlendMode === 6 || brush.procreateDualBlendMode === 7 ||
      brush.dualBlendMode === 'difference' || brush.dualBlendMode === 'subtract';
    const syncSubSize = isNativeProDual && !isHollowDual && brush.sizePx > 0 && brush.sizePx <= 500 &&
      (rawSubSize > brush.sizePx || subHasStaleDefaultPSz);
    const clipSubScatter = isNativeProDual && (!brush.scatterOn || (brush.scatterPct || 0) < 2);
    const isLowLoadGlaze = isNativeProDual && !!brush._params.renderingModulatedTransfer &&
      Number(brush._params.dynamicsLoad) > 0 && Number(brush._params.dynamicsLoad) <= 0.15 &&
      Number(brush._params.dynamicsPressureOpacity) > 0.1;
    const isDenseGlitterDual = isNativeProDual && Math.round(Number(brush.scatterCount) || 1) >= 5 && Number(brush.spacingPct) >= 15;
    const secOpacityBase = sub.opacity === undefined ? 1 : sub.opacity;
    const secFlowBase = sub.flowPct === undefined ? 1 : sub.flowPct;
    const sec = Object.assign({}, info, sub, {
      _pcNativeArchiveEligible: nativeArchiveUntouched(sub),
      _pcLinkedSecondary: true,
      source: sub.source || brush.source,
      name: util.cutUtf16(sanitizeName(brush.name || 'brush', 0), 54) + '_副笔尖',
      tip: tip,
      sizePx: syncSubSize ? Math.max(1, Math.round(brush.sizePx)) : rawSubSize,
      _pcScalarSyncedSize: syncSubSize && !!sub._rawNormalized && sub.sizePx === sub._rawNormalized.sizePx &&
        (info.diameter === undefined || info.diameter === sub._rawNormalized.sizePx),
      spacingPct: info.spacing !== undefined ? info.spacing : (brush.spacingPct === undefined ? 10 : brush.spacingPct),
      opacity: isLowLoadGlaze ? Math.max(0.05, secOpacityBase * 0.65) : secOpacityBase,
      flowPct: isLowLoadGlaze ? Math.max(0.05, secFlowBase * 0.65)
        : (isDenseGlitterDual ? Math.max(0.05, secFlowBase * 0.65) : sub.flowPct),
      angle: info.angle || 0,
      roundness: info.roundness === undefined ? 100 : info.roundness,
      dualOn: false,
      dualTip: undefined,
      dualBrush: undefined,
      dualSubBrush: undefined,
      scatterOn: clipSubScatter ? false : (info.useScatter === undefined ? !!sub.scatterOn : !!info.useScatter),
      scatterCount: info.count === undefined ? sub.scatterCount : info.count,
      scatterBothAxes: info.bothAxes === undefined ? sub.scatterBothAxes : info.bothAxes,
      scatterPct: clipSubScatter ? 0 : (info.scatterPct === undefined ? sub.scatterPct : info.scatterPct),
      bruUuid: secUuid,
      bruDualRefUuid: null,
      pkgId: pkgUuid
    });
    /* 【第291轮（作者：Claude）R290-04】本工具从画世界双笔导出的 brushset 转回 BRU：
       Procreate 形状只有灰度、直径只存整数，靠 brushConvBruExtra 记下的副笔颜色 / 精确尺寸 / 名字还原。
       深色副笔（焦边描边、f38「颜色」）要按原色涂回并跳过白遮罩，否则框变白看不见。
       尺寸只在「直径没被改过」（取整后相等）时才用精确值。 */
    if (brush._nativeDualFromBru) {
      const rgb = brush._bruSubTipRgb;
      if (Array.isArray(rgb) && rgb.length === 3 && sec.tip && sec.tip.rgba) {
        const px = new Uint8Array(sec.tip.rgba);
        for (let i = 0; i < px.length; i += 4) { px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; }
        sec.tip = { w: sec.tip.w, h: sec.tip.h, rgba: px };
        sec._keepTipRgb = true;
      }
      const exact = Number(brush._bruSubSizePx);
      if (exact > 0 && Math.round(exact) === sec.sizePx) sec.sizePx = exact;
      if (typeof brush._bruSubName === 'string' && brush._bruSubName) sec.name = brush._bruSubName.slice(0, 60);
    }
    /* 【第297轮（作者：Lead）】brushset 往返的副笔两件套：
       ① 副笔纹理资源 id（f6）——Procreate 的 Sub01 没有纹理位，源值只存在 brushConvBruExtra 里。
          以前这里不接，f121 子消息里就没有 f6，DB 的副笔 texPath 被清空 → 副笔那层是纯色（用户看到的均匀色块）。
          注意不能只靠 `info.texAssetId`：makeBru 的 f6 链要求 hasTexture，而副笔的 hasTexture 恒为 false，
          所以显式打 _bruForcedTexId 让写侧绕过这条门。 */
    if (typeof brush._bruSubTexId === 'string' && brush._bruSubTexId) {
      sec.texAssetId = brush._bruSubTexId;
      sec._bruForcedTexId = true;
    }
    /* ② 副笔原生小宽度 f9：不带回去会按 sizePx×minSizeRatio 重算（第296轮 7 → 43.45）。 */
    {
      const nw = Number.isFinite(brush._bruSubNativeSmallWidth) ? brush._bruSubNativeSmallWidth
        : (sub && Number.isFinite(sub._bruNativeSmallWidth) ? sub._bruNativeSmallWidth : undefined);
      if (Number.isFinite(nw) && nw >= 0 && nw <= 5000) { sec._bruNativeSmallWidth = nw; sec._bruNativeSmallWidthFromSource = true; }
    }
    /* ③ 副笔子消息的字段存在性：写侧据此不凭空补 f29/f32/f33/f35/f80/f119/f120。 */
    if (Array.isArray(brush._bruSubFieldSet) && brush._bruSubFieldSet.length) {
      const ab = bruAbsentFields(brush._bruSubFieldSet);
      if (ab) sec._bruAbsentFields = ab;
    }
    {
      const subBuiltin = brush._bruSubBuiltinTipRef || (sub && (sub.bruBuiltinTipRef || sub._bruBuiltinTipRef));
      if (typeof subBuiltin === 'string' && subBuiltin) {
        sec.oldTexId = subBuiltin;
        sec._bruForceBuiltinTipRef = true;
      } else if (typeof brush._bruSubOldTexId === 'string' && brush._bruSubOldTexId && !sec.oldTexId) {
        sec.oldTexId = brush._bruSubOldTexId;
      }
      if (Number.isFinite(brush._bruSubF135)) sec._bruF135 = brush._bruSubF135;
      if (Number.isFinite(brush._bruSubF136)) sec._bruF136 = brush._bruSubF136;
      if (brush._bruSubTipRaw && brush._bruSubTipRaw.length) {
        sec._rawTipPng = brush._bruSubTipRaw;
        sec._bruForceRawTipPng = true;
      }
    }
    const primary = Object.assign({}, brush, {
      _pcNativeArchiveEligible: nativeArchiveUntouched(brush),
      bruUuid: priUuid,
      bruDualRefUuid: pkgUuid,
      dualSubName: sec.name,
      bruDualSubBrush: sec,
      bruDualEnabled: true,
      pkgId: pkgUuid,
      dualOn: false,
      dualTip: undefined
    });
    // 这两种满焦边、满压力副色的原生组合，画世界的变暗混边能保住双色笔的深外缘。
    // 记录此次生成的副笔身份，换关联后仍尊重用户选的新笔。
    if (isNativeProDual && brush.dualOn && brush.bruDualEnabled !== false && !brush.bruDualRefUuid &&
        !brush._bruExtra && brush._rawArchive && sub._rawArchive &&
        brush._params.burntEdgesAmount === 1 && brush._params.dynamicsPressureSecondaryColor === 1) {
      const mode = brush._params.burntEdgesBlendModeExtended ?? brush._params.burntEdgesBlendMode;
      if (mode === 9 || mode === 19) primary._pcBurntBorderSubUuid = secUuid;
    }
    if (primary._pcNativeArchiveEligible) primary._pcNativePairState = util.brushFingerprint(primary);
    if (sec._pcNativeArchiveEligible) sec._pcNativePairState = util.brushFingerprint(sec);
    return { primary: primary, secondary: sec, primaryUuid: priUuid, secondaryUuid: secUuid, pkgUuid: pkgUuid };
  }

  function makeBruDualPair(brush, opts) {
    const pair = buildBruDualPairBrushes(brush);
    if (!pair) return null;
    const opts2 = Object.assign({}, opts, { pkgId: pair.pkgUuid });
    const made = makeBruPack([pair.primary, pair.secondary], opts2);
    return { bytes: made.bytes, count: made.count, primaryUuid: pair.primaryUuid, secondaryUuid: pair.secondaryUuid };
  }

  /* 单支 BRU + 记录末尾内嵌副笔尖 PNG（画世界 3.x 原生单支布局） */
  function makeBruEmbedded(brush, opts) {
    /* 第181轮：双笔刷语义不同 —— Procreate 的副笔是「与主笔混合」，画世界的双笔刷是
       「副笔尖各画一笔」（位置/尺寸独立）。把 Procreate 副笔直接内嵌成画世界双笔，
       一次落笔会出现主笔 + 副笔两层墨 = 用户实测的「重影」（黄土笔刷）。
       非 BRU 源一律跳过内嵌、走烘焙路径：副笔合成进笔尖，并显式关闭 f119 双笔开关。
       只有源本来就是 BRU（画世界自己的原生双笔）才保留内嵌语义。 */
    /* 显式 forceEmbedSubTip 时保留内嵌能力（测试/高级用法），否则非 BRU 源一律烘焙。 */
    if (brush.source !== 'bru' && !(opts && opts.forceEmbedSubTip)) {
      return makeBru(brush, Object.assign({}, opts, { embedSubTip: false }));
    }
    const pair = buildBruDualPairBrushes(brush);
    if (!pair || !pair.secondary || !pair.secondary.tip) return makeBru(brush, Object.assign({}, opts, { embedSubTip: false }));
    // Use the same conversion path as a standalone secondary. This supplies
    // its image ID and applies scale/spacing/pressure/size limits exactly once.
    const sub = makeBru(pair.secondary, Object.assign({}, opts, { embedSubTip: false }));
    const enabled = brush.dualOn !== false && brush.bruDualEnabled !== false;
    const primary = Object.assign({}, pair.primary, {
      embeddedSubPng: sub.meta.noShape || sub.meta.bruBuiltinTipRef ? null : sub.pngBytes,
      bruDualSubBrush: sub.meta,
      bruDualEnabled: enabled,
      dualSubName: sub.meta.name,
      pkgId: pair.pkgUuid,
      /* 【第224轮】拆分主/副笔时会丢掉「从 brushset 转回来」的标记，主笔的纹理参数
         就退回默认值（还行：bright 51→100、contrast 100→200、blend 14→0）。这里显式带回。 */
      _bruTexParams: brush._bruTexParams,
      _nativeTexFromBru: brush._nativeTexFromBru,
      _nativeDualFromBru: brush._nativeDualFromBru
    });
    return makeBru(primary, Object.assign({}, opts, { embedSubTip: false }));
  }

  /* 【第366轮 Phase 2】画世界 f35/f33 映射归口至 core/model-hsjpro.js（底层量程/中性由 core/ir.js 定义）。 */
  function bruTexBrightness(brush) { return hsjModel.bruTexBrightness(brush); }
  function bruTexContrast(brush) { return hsjModel.bruTexContrast(brush); }

  function bruProcreateColor(brush) {
    const raw = brush.source === 'procreate' && brush._params;
    if (!raw) return null;
    const ratio = v => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
    };
    const pressure = {
      hue: ratio(raw.dynamicsPressureHue),
      saturation: ratio(raw.dynamicsPressureSaturation),
      brightness: ratio(raw.dynamicsPressureBrightness),
      secondary: ratio(raw.dynamicsPressureSecondaryColor)
    };
    if (pressure.secondary <= 0.001) pressure.secondary = 0;
    if (!pressure.hue && !pressure.saturation && !pressure.brightness && !pressure.secondary) return null;
    // The shared brush model combines pressure and random color for older targets.
    // BRU has separate controls, so take the random values from the source archive.
    const before = brush._rawNormalized || {};
    const random = (key, tip, stroke) => Object.prototype.hasOwnProperty.call(before, key) && brush[key] !== before[key]
      ? brush[key] : Math.max(ratio(raw[tip]), ratio(raw[stroke]));
    const hue = random('colorJitterHue', 'dynamicsJitterHue', 'dynamicsJitterStrokeHue');
    const saturation = random('colorJitterSat', 'dynamicsJitterSaturation', 'dynamicsJitterStrokeSaturation');
    const brightness = random('colorJitterVal', 'dynamicsJitterLightness', 'dynamicsJitterStrokeLightness');
    const enabled = brush.colorDynamicsOn !== before.colorDynamicsOn && before.colorDynamicsOn !== undefined
      ? brush.colorDynamicsOn : !!(hue || saturation || brightness || brush.colorJitterFgBg);
    // Tilt and roll have no equivalent pressure slider in BRU.
    const secondaryFallback = 0.5 * Math.max(ratio(raw.dynamicsTiltSecondaryColor), ratio(raw.dynamicsRollSecondaryColor));
    return { pressure, hue, saturation, brightness, enabled, secondaryFallback };
  }

  /* 从笔尖 alpha 轮廓估算硬边程度：纯二值边（只有 0/255）≈1，
     大面积半透明过渡（柔边圆笔）会显著降低。用于源笔刷没有 hardness 字段时，
     不要一律按 1（硬边）写 BRU。 */
  function hardnessFromAlpha(rgba, w, h) {
    if (!rgba || !w || !h) return 0.8;
    let solid = 0, mid = 0;
    for (let i = 0; i < w * h; i++) {
      const a = rgba[i * 4 + 3];
      if (a < 8) continue;
      if (a >= 250) solid++; else mid++;
    }
    const total = solid + mid;
    if (!total) return 0.8;
    const frac = mid / total;
    // 过渡像素占比越大越软；0.9 系数 + 0.15 下限让柔边落在 0.3~0.8 这一档，硬边≈1
    return Math.max(0.20, Math.min(1, 1 - Math.min(1, frac * 0.6)));
  }

  /* 【第206轮 R204-02（作者：Claude）】笔尖是不是「普通硬边实心圆」。
     画世界内置网点笔刷（官方「小方块」450B）不带笔尖图，用 App 的程序化圆头 + 内置纹理 ptN；
     转到 Procreate 时我们按 synthTip 合成了 256² 硬边圆当 Shape。回转时认出这张圆，
     就能还原成和官方一样的「无笔尖图 + 纹理引用」结构，而不是 USESHAPE + 一张圆图。
     判据：正方形、凡有覆盖处 RGB 全白、alpha 与同尺寸 hardness=1 的 synthTip 逐像素差 ≤ 8 的比例 ≥ 99.5%。 */
  function isPlainHardDisc(rgba, w, h) {
    if (!rgba || !(w > 0) || w !== h || w < 16 || rgba.length !== w * h * 4) return false;
    const ref = synthTip({ hardness: 1, roundness: 100, angle: 0 }, w);
    let bad = 0;
    const n = w * h, limit = Math.floor(n * 0.005);
    for (let i = 0; i < n; i++) {
      const o = i * 4, a = rgba[o + 3];
      if (a > 8 && (rgba[o] < 248 || rgba[o + 1] < 248 || rgba[o + 2] < 248)) return false;
      if (Math.abs(a - ref.rgba[o + 3]) > 8 && ++bad > limit) return false;
    }
    return true;
  }

  // Detect a repeating, axis-aligned soft-dot lattice from the pixels, not the
  // brush name. Both axes need the same dominant period; require the positive
  // cross term that distinguishes isolated dots from stripes or a checkerboard.
  function regularDotGrain(tex) {
    const n = 64;
    if (!tex || tex.w < 32 || tex.h < 32 || Math.abs(tex.w / tex.h - 1) > 0.02) return null;
    const x = new Float64Array(n), y = new Float64Array(n), tile = new Float64Array(n * n);
    let sum = 0, square = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const v = tex.gray[Math.floor((j + 0.5) * tex.h / n) * tex.w + Math.floor((i + 0.5) * tex.w / n)];
      tile[j*n+i] = v; x[i] += v / n; y[j] += v / n; sum += v; square += v * v;
    }
    const mean = sum / (n*n), variance = square / (n*n) - mean*mean;
    if (variance < 36) return null;
    function peak(axis) {
      let best = { k:0, power:0 };
      for (let k = 1; k <= Math.min(12, Math.floor(Math.min(tex.w,tex.h)/8)); k++) {
        let c = 0, s = 0;
        for (let i = 0; i < n; i++) {
          const a = 2 * Math.PI * k * (i + 0.5) / n;
          c += (axis[i] - mean) * Math.cos(a); s += (axis[i] - mean) * Math.sin(a);
        }
        const power = 2 * (c*c + s*s) / (n*n*variance);
        if (power > best.power) best = { k, power, phase: Math.atan2(s,c) };
      }
      return best;
    }
    const px = peak(x), py = peak(y);
    if (px.k !== py.k || px.power < 0.25 || py.power < 0.25 || px.power + py.power < 0.72) return null;
    const cx = new Float64Array(n), cy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = 2 * Math.PI * px.k * (i + 0.5) / n;
      cx[i] = Math.cos(a - px.phase); cy[i] = Math.cos(a - py.phase);
    }
    let mixed = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) mixed += (tile[j*n+i] - mean) * cx[i] * cy[j];
    if (Math.abs(mixed) * 4 / (n*n) < Math.sqrt(variance) * 0.09) return null;
    return { repeats:px.k };
  }

  const BRU_MAX_SIZE_PX = hsjModel.BRU_MAX_SIZE_PX;
  const BRU_AUTO_SPACING_PCT = ir.BRU_AUTO_SPACING_PCT;
  const BRU_MIN_SPACING_PCT = ir.BRU_MIN_SPACING_PCT;
  const proceduralPaperGrainPng = hsjModel.proceduralPaperGrainPng;
  const stretchLowStdGrainBytes = hsjModel.stretchLowStdGrainBytes;
  const isLargeBundledPaperBrush = hsjModel.isLargeBundledPaperBrush;
  function bruIndependentTexture(brush, opts) {
    if (brush.source === 'bru' || opts.noTextureBake === true || opts.bruTexMatch === 'off' ||
        (opts.bruTexAsset && opts.bruTexAsset !== 'off')) return null;
    if (!brush.hasTexture) {
      if (isLargeBundledPaperBrush(brush, opts)) {
        const rawBytes = proceduralPaperGrainPng();
        return { custom: true, scale: 0.55, plain: { w: 512, h: 512 }, rawBytes, grainLayer: true,
          uiDepthOverride: 0.78, neutralTone: true, noInvert: true };
      }
      return null;
    }
    /* 【第224轮】带 _nativeTexFromBru 的 brushset（本工具从带纹理的 BRU 导出的）
       转回 bru 时无条件还原独立纹理层。第206轮「非规则纹理必须烘焙」是为原生 ABR/
       Procreate 纹理定的（不规则纹理在 BRU 里平铺会显重复），而往返场景的源本来就是
       BRU 的独立纹理，还原它才是对的。原生档案没有这个标记，口径不变。 */
    const plainForNative = brush._nativeTexFromBru
      ? textureGray(brush.textureInverted ? Object.assign({}, brush, { textureInverted:false }) : brush)
      : null;
    if (brush._nativeTexFromBru) {
      /* 【第248轮】浏览器端没有 process：原来直接读 process.env 会让整个转换抛「process is not defined」。 */
      if (typeof process !== 'undefined' && process.env && process.env.BCU_DEBUG) console.log('[BiT]', JSON.stringify({name: brush.name, dualOn: !!brush.dualOn, dualTip: !!brush.dualTip, nDual: !!brush._nativeDualFromBru, ref: brush.bruDualRefUuid, texId: brush.texAssetId, gB: !!brush._grainFromBuiltin, fp: brush._grainFromBuiltinFp, hasTex: brush.hasTexture, src: brush.source}));
      if (!plainForNative) return null;
      /* 双笔守卫：内嵌副笔尖的双笔（还行型）必须烘焙——224 轮实测双笔 + 自定义纹理层不出墨。
         注意只看 dualOn&&dualTip：链接型双笔（迟早/扁头描边：dualOn 但副笔尖是跨包引用，
         brushset 里没有 Sub01）在 mid 上 dualOn=false，走保留分支——其 keepNativeId 形式
         与源文件同构（UUID+源原始字节 / ptN 内置引用），不触发 224 的形态。 */
      if (brush.dualOn && brush.dualTip) return null;
      /* 【第232轮·field-matrix】源 f6 本来就是内置引用（ptN）且 Grain 像素来自内置库时，
         直接沿用源 f6：Grain.png 的重编码会破坏逐像素指纹（Good铅笔 pt33 实测 bake），
         但 ptN 的真值在 App 内置库里。安全阀：导出时记下纹理灰度 md5（_grainFromBuiltinFp），
         重建时校验——Grain 被改过（halftone 测试的 1 像素改动）指纹对不上就回烘焙。 */
      if (/^pt/i.test(String(brush.texAssetId || '')) && brush._grainFromBuiltin) {
        const fp = plainForNative.gray ? util.md5(new Uint8Array(plainForNative.gray)) : null;
        if (fp && fp === brush._grainFromBuiltinFp) return { id: brush.texAssetId };
        return null;
      }
      /* 先试内置纹理库：命中 ptN 就写 f6 引用——比自定义纹理省体积，也让官方 450B
         那种「无笔尖图 + f6=pt65」的原生布局能照抄（第206轮依赖这一点）。 */
      const libN = isNode ? require('./hsj-textures-lib.js') : (root.BC && root.BC.hsjTextureLib);
      const hitN = libN && libN.matchKnown(plainForNative.w, plainForNative.h, plainForNative.gray);
      if (hitN) return { id: hitN };
      /* 【第231轮·真机复验见 _probe/verify230/report.md】单笔 + 笔尖 PNG + 自定义纹理在
         3.4.5 正常出墨，且保留独立纹理层对齐真源 98%/97%（纹理层是乘法调制，烘焙+归零反而
         把出墨放大 ~2.2 倍）。keepNativeId 要求「源 id 是 UUID 且源纹理原始字节在手」——
         id 与像素 md5 必须自洽（bru.js parse 与 App 端同口径）。 */
      if (!brush._rawBruTexture || !/^[0-9a-f]{32}$/i.test(String(brush.texAssetId || ''))) return null;
      return { custom: true, keepNativeId: true, plain: plainForNative };
    }
    // A BRU texture reference carries no rotation. Preserve rotated grain by baking.
    if (brush.source === 'procreate' && Math.abs(Number(brush.textureRotation) || 0) > 1e-4) return null;
    const plain = textureGray(brush.textureInverted ? Object.assign({}, brush, { textureInverted:false }) : brush);
    if (!plain) return null;
    const lib = isNode ? require('./hsj-textures-lib.js') : (root.BC && root.BC.hsjTextureLib);
    const hit = lib && lib.matchKnown(plain.w, plain.h, plain.gray);
    if (hit) return { id:hit };
    if (brush.source !== 'procreate') return null;
    // 【第366轮 Phase 2】纹理缩放换算归口至 core/model-hsjpro.js（实测 tile_px = tex_w × f24）。
    const isTexturized = !!(brush._params && Number(brush._params.textureApplication) === 1);
    const isHiRes = plain.w >= 1024 && !!brush._params && !brush._bruExtra;
    const scale = hsjModel.computeTextureScale(brush, plain.w, opts);
    if (!(scale >= 0.01 && scale <= 20)) return null;
    if (brush.textureDepth >= 0.8 && regularDotGrain(plain)) return { custom:true, scale, plain };
    /* 【第399轮（作者：Lead）】第388轮给 texApp=1 的小笔径（sizePx>=16、非双笔）放宽到 0.05：
       2048² 纸纹在 size=21 时 f24≈0.08，按老的 0.1 门槛会被判「不走独立层」而退烘焙。
       门槛改由 model-hsjpro.grainLayerMinScale 决定（普通 0.1 / 纹理化小笔径 0.05），
       GRAIN_LAYER_MIN_SCALE=0.1 的契约本身不破。 */
    if (scale >= (hsjModel.grainLayerMinScale ? hsjModel.grainLayerMinScale(brush) : GRAIN_LAYER_MIN_SCALE) &&
        grainLayerCandidate(brush, opts) && grainHasPattern(plain)) {
      // On Procreate 5.4.15 these fixed fabrics measure about 0.707 canvas px
      // per Grain pixel per scale unit. On multiply paper, changing pitch alone
      // moved the sampled wash from gray 133 to 181, so keep its calibrated scale.
      const blend = Number(brush.grainBlendMode);
      const nativeCanvasGrain = isTexturized && (blend === 8 || blend === 10) && brush._rawGrain && brush._rawGrain.length &&
        !brush._patternPixels && brush._params.textureScale > 0 && Number.isFinite(brush.textureScale) && brush.textureScale > 0;
      const layerScale = nativeCanvasGrain ? Math.max(0.01, Math.min(20, brush.textureScale / Math.SQRT2)) : scale;
      if (isTexturized && blend === 10 && grainStd(plain) < 22) {
        return { custom: true, scale: layerScale, plain, rawBytes: stretchLowStdGrainBytes(plain), grainLayer: true,
          uiDepthOverride: 0.85, neutralTone: true, contrastOverride: 20 };
      }
      return { custom:true, scale:layerScale, plain, grainLayer:true };
    }
    if (isLargeBundledPaperBrush(brush, opts) && grainHasPattern(plain)) {
      return { custom: true, scale: 0.54, plain, grainLayer: true, uiDepthOverride: 0.75, neutralTone: true };
    }
    // 【第356轮】原生 Procreate 双笔主笔为 Moving(app=0) 非正片叠底、而 Sub01 携带画布锁定 Texturized(app=1) 颗粒
    // （如 #24 辉石岩 3.19MB 岩石裂纹）时，提升副笔 app=1 颗粒为画世界独立纹理层，避免双笔散布烘焙糊成纯色云。
    const sub = brush.dualSubBrush;
    // A linked secondary already renders its paper on its own BRU record.
    if (isHiRes && !isTexturized && !brush.bruDualRefUuid && sub && sub._params && Number(sub._params.textureApplication) === 1 &&
        sub._rawGrain && sub._rawGrain.length && Number(sub.textureDepth) >= GRAIN_LAYER_MIN_DEPTH &&
        Number(sub.textureDepth) < GRAIN_LAYER_MAX_SRC_DEPTH && (brush.sizePx || 0) >= 80 &&
        opts.bruGrainLayer !== 'off' && opts.fidelity !== false && !opts.noTextureBake &&
        !(opts.bruTexAsset && opts.bruTexAsset !== 'off')) {
      const spSub = Number(brush.spacingPct);
      const spGate = (brush._params && Number.isFinite(Number(brush._params.plotSpacing))) ? spSub / Math.SQRT2 : spSub;
      if (spGate > 0 && spGate <= GRAIN_LAYER_MAX_SPACING) {
        const subPlain = textureGray(sub.textureInverted ? Object.assign({}, sub, { textureInverted: false }) : sub);
        if (subPlain && subPlain.w >= 1024 && grainHasPattern(subPlain)) {
          const subScale = 450 * (sub.textureScale || 1) / subPlain.w;
          if (subScale >= GRAIN_LAYER_MIN_SCALE && subScale <= 20) {
            return { custom: true, scale: subScale, plain: subPlain, rawBytes: sub._rawGrain, grainLayer: true, fromSubGrain: true };
          }
        }
      }
    }
    return null;
  }

  /* 【第293轮（作者：Claude）R292-02】不规则颗粒（纸纹 / Willow 之类）写成画世界独立纹理层，不再烘进笔尖。
     真机（WorkBuddy，MuMu 画世界 Pro，_probe/claude-watercolor292/results/report.md）：「吹石-水彩铺色」颗粒烘进笔尖后
     跟着笔尖走，4.2% 间距叠十几次被抹平（grain 0.0135，平滑实心一片）；改独立纹理层、固定画布（f99=0）颗粒就出来了
     （grain 0.23）；「每个笔尖设置纹理」开 = 和烘焙一样平（0.0163）。纹理深度照搬源 80% 太碎太白，
     手调到画世界界面 55% 最像原图（grain 0.061 vs 参考 0.063）→ 界面深度 = 源深度 × 0.69。
     **只在一支笔上标定过**，用户 2026-11-17 拍板先只放这一类：颗粒深度 ≥ 0.75、间距 ≤ 15%（密到会把烘焙颗粒叠平）。
     其余照旧烘焙；放宽前要先真机测别的笔刷。双笔不拆也不烘（dualBake:false 内嵌）时不走：第224轮实测
     内嵌副笔尖双笔 + 自定义纹理层不出墨。 */
  /* 【第366轮 Phase 2】独立颗粒层阈值与路由判据已归口至 core/model-hsjpro.js（画世界Pro 3.4.5 模型）。 */
  const GRAIN_LAYER_MIN_DEPTH = hsjModel.GRAIN_LAYER_MIN_DEPTH;
  const GRAIN_LAYER_MAX_SPACING = hsjModel.GRAIN_LAYER_MAX_SPACING;
  const GRAIN_LAYER_DEPTH_RATIO = hsjModel.GRAIN_LAYER_DEPTH_RATIO;
  const GRAIN_LAYER_MAX_SRC_DEPTH = hsjModel.GRAIN_LAYER_MAX_SRC_DEPTH;
  const GRAIN_LAYER_MAX_UI_DEPTH = hsjModel.GRAIN_LAYER_MAX_UI_DEPTH;
  const GRAIN_LAYER_MIN_SCALE = hsjModel.GRAIN_LAYER_MIN_SCALE;
  const grainStd = hsjModel.grainStd;
  const grainHasPattern = hsjModel.grainHasPattern;
  const grainLayerCandidate = hsjModel.grainLayerCandidate;

  /* 用写出侧的匹配规则预测是否会走已标定的颗粒层。笔刷与选项可在下次导出前改变。 */
  function grainLayerWillApply(brush, opts) {
    if (brush.source !== 'procreate') return false;
    const normalized = sanitizeBrushNumbers(brush);
    if (!normalized.hasTexture && !isLargeBundledPaperBrush(normalized, opts)) return false;
    const hasSubApp1 = !!(normalized.dualSubBrush && normalized.dualSubBrush._params &&
      Number(normalized.dualSubBrush._params.textureApplication) === 1 && normalized.dualSubBrush._rawGrain);
    if (!hasSubApp1 && !grainLayerCandidate(normalized, opts) && !isLargeBundledPaperBrush(normalized, opts)) return false;
    try {
      const match = bruIndependentTexture(normalized, opts || {});
      return !!(match && match.grainLayer);
    } catch (e) { return false; }
  }

  function bruTextureBytes(brush, match) {
    if (brush.source === 'bru') return brush._rawBruTexture;
    if (!match || !match.custom) return null;
    if (match.rawBytes && match.rawBytes.length) return match.rawBytes;
    /* 【第231轮】keepNativeId（BRU 往返单笔保留层）：优先回传源纹理原始字节——
       f6 保留源 UUID，而 App 侧 f6 即该字节块的 md5（bru.js parse 的校验口径），
       像素必须与 UUID 自洽，不能用重编码的 Grain PNG（md5 对不上）。 */
    if (match.keepNativeId && brush._rawBruTexture && brush._rawBruTexture.length) return brush._rawBruTexture;
    if (brush._rawGrain && brush._rawGrain.length && !brush._patternPixels) return brush._rawGrain;
    const t = match.plain, rgba = new Uint8Array(t.gray.length * 4);
    for (let i = 0; i < t.gray.length; i++) {
      const o = i * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = t.gray[i]; rgba[o + 3] = 255;
    }
    return png.encode(t.w, t.h, rgba);
  }

  /* 【第274轮】极小 + 二值 alpha 的笔尖按**最近邻**放大。
     Procreate 预设里有些笔尖是「Blank」这类 8×8 纯白方块（例如吹石「大号方块」），
     Procreate 放大时是硬边方块；我们原样把 8×8 交给目标软件，它用双线性/双三次放大，
     四角被磨圆、整体发虚 —— 用户看到的就是「方形笔尖变成圆的了」。
     只处理「边长 ≤32 且 alpha 只有 0/255」的图：这类图本来就没有软边信息，
     最近邻放大不引入任何损失；柔边笔尖（有中间灰度）一律不动。 */
  function expandTinyBinaryTip(brush, opts) {
    const t = brush && brush.tip;
    if (!t || !t.rgba || !(t.w > 0) || !(t.h > 0)) return brush;
    if (t.w > 32 || t.h > 32) return brush;
    /* 只处理正方形硬笔尖（Procreate 的 Blank/方头预设就是 8×8 方形）。
       窄长笔尖（3×1 之类）放大后采样点会变，属于另一类，不在这里顺手改。 */
    if (t.w !== t.h) return brush;
    let binary = true;
    for (let i = 3; i < t.rgba.length; i += 4) {
      const a = t.rgba[i];
      if (a !== 0 && a !== 255) { binary = false; break; }
    }
    if (!binary) return brush;
    const want = Math.max(64, Math.min(256, Math.round((brush.sizePx || 64) * 2)));
    if (want <= Math.max(t.w, t.h)) return brush;
    const scale = want / Math.max(t.w, t.h);
    const nw = Math.max(1, Math.round(t.w * scale)), nh = Math.max(1, Math.round(t.h * scale));
    const out = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(t.h - 1, Math.floor(y * t.h / nh));
      for (let x = 0; x < nw; x++) {
        const sx = Math.min(t.w - 1, Math.floor(x * t.w / nw));
        const so = (sy * t.w + sx) * 4, o = (y * nw + x) * 4;
        out[o] = t.rgba[so]; out[o + 1] = t.rgba[so + 1]; out[o + 2] = t.rgba[so + 2]; out[o + 3] = t.rgba[so + 3];
      }
    }
    return Object.assign({}, brush, { tip: { w: nw, h: nh, rgba: out }, _tipNearestExpanded: true });
  }

  /* 【第289轮】笔尖是不是「纯二值正方形」——画世界笔尖页把它显示成「方形笔触」(f41)。
     判据：正方形 + alpha 只有 0/255 + 四角不透明（满格方块）。菱形/十字这类二值但
     四角透明的笔尖不算：它们的形状是「图里画出来的」，不能切成方形档（会变成一整块实心方）。 */
  function isBinarySquareTip(t) {
    if (!t || !t.rgba || !(t.w > 1) || t.w !== t.h || t.rgba.length !== t.w * t.h * 4) return false;
    for (let i = 3; i < t.rgba.length; i += 4) {
      const a = t.rgba[i];
      if (a !== 0 && a !== 255) return false;
    }
    const last = t.w - 1;
    return t.rgba[3] === 255 && t.rgba[last * 4 + 3] === 255 &&
      t.rgba[last * t.w * 4 + 3] === 255 && t.rgba[(last * t.w + last) * 4 + 3] === 255;
  }

  /* 【第290轮（作者：Claude）】Procreate「焦边」→ 画世界「双笔：主笔 + 大一圈的深色辅助副笔」。
     画世界没有焦边。真机试验（2026-11-17，用户逐支试画四轮）：
       · 混边（各模式、亮度 1~40%）、湿边深度 40~100%：都不出框；
       · 中空 20：出框，但框 = 主颜色、芯 = 副颜色，蓝笔就是蓝框，且框太厚 → 用户否决；
       · 照用户给的原生参考「空心卡通」做双笔：副笔 = 同笔尖、RGB 涂成近黑 ff07050a、开「颜色」(f38，
         按笔尖自身颜色画)、比主笔大 53/50.35 倍 → **芯 = 画笔颜色、框固定深色**，1.05 倍厚度与参考一致（1.10/1.20 偏厚）；
       · 单笔「笔尖自带深边 + 颜色」：画出来是笔尖原色（白芯灰边），不乘画笔颜色 → 不可行。
     判据：非 BRU 源、不是 BRU 往返回来的（_bruExtra）、焦边 ≥ 0.5、没有纹理/颗粒
     （质感叠加这类纹理笔焦边=1 但原图没有明显框，不加）、本身不是双笔、源没自带中空、fidelity 没关。 */
  const BURNT_OUTLINE_RATIO = 53 / 50.35;        // 参考「空心卡通」副笔 f8 / 主笔 f8
  const BURNT_OUTLINE_COLOR = -16317174;         // 0xff07050a，参考的 f82（HOLLOWCOLOR）
  const BURNT_OUTLINE_RGB = [7, 5, 10];
  const BURNT_OUTLINE_SUB_NAME = '辅助';
  const BURNT_OUTLINE_SUFFIX = '-描边版';
  /* 单个 varint 字段的原始 wire 字节（f38/f141/f146 不在 BRU_KNOWN_FIELDS，走 _rawUnknown 原样写出） */
  function encodeBruVarint(n) {
    const bytes = [];
    while (n > 127) { bytes.push((n & 127) | 128); n = Math.floor(n / 128); }
    bytes.push(n);
    return bytes;
  }
  function rawVarintField(field, value) {
    return new Uint8Array(encodeBruVarint(field * 8).concat(encodeBruVarint(value)));
  }

  // BRU limits metadata on subsequent records to 64 KiB. A private PNG chunk
  // carries source assets without changing the decoded BRU tip or texture layer.
  const PC_GRAIN_CHUNK = 'bcPG';
  const PC_GRAIN_HEADER = 12;
  const PC_GRAIN_ASSET_MAX = 32 * 1024 * 1024;
  /* 【第348轮（作者：Lead）】独立的极简标记 chunk：只存「源无 Shape.png」这类**事实**，
     不存任何图像，体积几十字节。它不受 `opts.procreateGrainBridge` 影响——那个开关控制的是
     grain 原图备份（缪斯之梦 74MB），而这一条只是让「精简版」也能在回写时知道源本来没有 Shape，
     不至于凭空补一个合成硬圆把笔尖改硬。 */
  const PC_MARK_CHUNK = 'bcMK';
  const PC_MARK_MAX = 1024;

  // Each family can be restored independently after editing a different BRU control.
  // The native enumerations and wet-mix settings are not invertible from BRU values.
  // Group, key and control order are part of the optional bcPS v1 render payload.
  const PC_RENDER_GROUPS = [
    { keys: ['blendMode', 'extendedBlend', 'extendedBlend2', 'blendGammaCorrect'],
      controls: ['blendMode'] },
    { keys: ['dualBlendMode', 'dualBlendModeExtended'],
      controls: ['dualBlendMode', 'bruDualBlendMode', 'bruDualEnabled'], sourceControls: ['dualBlendMode', 'procreateDualBlendMode'] },
    { keys: ['burntEdgesAmount', 'burntEdgesBlendMode', 'burntEdgesBlendModeExtended'],
      controls: ['burntEdgesAmount', 'borderOn', 'borderBlend', 'borderBrightness', 'borderStrength', 'wetEdgesOn', 'wetEdgesDepth'] },
    { keys: ['wetEdgesAmount', 'dynamicsWetAccumulation', 'dynamicsWetnessJitter'],
      controls: ['wetEdgesOn', 'wetEdgesAmount', 'wetEdgesDepth', 'wetEdgesAccumulation', 'dynamicsWetnessJitter'] },
    { keys: ['dynamicsMix', 'dynamicsPressureMix', 'dynamicsMixSoftening', 'dynamicsLoad', 'dynamicsBlur', 'dynamicsBlurJitter',
             'renderingModulatedTransfer', 'renderingMaxTransfer', 'renderingRecursiveMixing'],
      controls: ['smudgeOn', 'smudgeAmount', 'dynamicsMix', 'dynamicsMixSoftening', 'dynamicsLoad', 'flowPct', 'opacity'],
      sourceControls: ['smudgeOn', 'smudgeAmount', 'dynamicsMix', 'dynamicsMixSoftening', 'dynamicsLoad'],
      usesPressure: true }
  ];
  function renderControlValues(brush, group) {
    return group.controls.map(function (key) { return brush[key] === undefined ? null : brush[key]; });
  }
  function savedRenderSettings(brush, baseline, opts) {
    return PC_RENDER_GROUPS.map(function (group) {
      if ((group.usesPressure && opts.pressure !== undefined) ||
          (group.sourceControls || group.controls).some(key => brush[key] !== brush._rawNormalized[key])) return null;
      const values = group.keys.map(function (key) {
        const v = brush._params[key];
        return Number.isFinite(v) || typeof v === 'boolean' ? v : null;
      });
      return values.some(v => v !== null) ? { values, controls: renderControlValues(baseline, group) } : null;
    });
  }
  function restoreRenderSettings(brush, saved, opts, restore) {
    if (!Array.isArray(saved)) return;
    PC_RENDER_GROUPS.forEach(function (group, i) {
      const record = saved[i];
      if (!record || (group.usesPressure && opts.pressure !== undefined) || !Array.isArray(record.values) ||
          record.values.length !== group.keys.length || !Array.isArray(record.controls) ||
          record.controls.length !== group.controls.length ||
          !renderControlValues(brush, group).every((v, j) => v === record.controls[j])) return;
      group.keys.forEach(function (key, j) {
        const v = record.values[j];
        if (Number.isFinite(v) || typeof v === 'boolean') restore[key] = v;
      });
    });
  }
  // Independent native settings, stamped against the quantized BRU.
  function readPcScalar(bytes) {
    if (!bytes || !png.isPng(bytes)) return null;
    for (let at = 8; at + 12 <= bytes.length;) {
      const n = util.u32(bytes, at), end = at + n + 12, type = util.ascii(bytes, at + 4, 4);
      if (end > bytes.length || type === 'IEND') return null;
      if (type === 'bcPS') {
        if (n > 8192 || util.u32(bytes, end - 4) !== util.crc32(bytes, at + 4, end - 4)) return null;
        try {
          const data = JSON.parse(util.utf8Decode(bytes.subarray(at + 8, end - 4)));
          if (data.version !== 1 || !data.native || !data.baseline) return null;
          for (const key of ['paintSize', 'minSize', 'maxSize', 'plotSpacing'])
            if (!Number.isFinite(data.native[key]) || data.native[key] < 0 || data.native[key] > 100) return null;
          for (const key of ['sizePx', 'minSizeRatio', 'maxSizePx', 'spacingPct'])
            if (!Number.isFinite(data.baseline[key])) return null;
          if (typeof data.baseline.pressureSize !== 'boolean' || typeof data.baseline.pressure !== 'boolean') return null;
          data.chunk = bytes.subarray(at, end);
          return data;
        } catch (_) { return null; }
      }
      at = end;
    }
    return null;
  }
  function writePcScalar(brush, baseline, opts) {
    const p = brush._params, before = brush._rawNormalized;
    if (!p || !before || !baseline) return null;
    const native = {}, snapshot = {};
    for (const key of ['paintSize', 'minSize', 'maxSize', 'plotSpacing']) {
      if (!Number.isFinite(p[key]) || p[key] < 0 || p[key] > 100) return null;
      native[key] = p[key];
    }
    for (const key of ['sizePx', 'minSizeRatio', 'maxSizePx', 'spacingPct']) {
      if (!Number.isFinite(baseline[key])) return null;
      snapshot[key] = baseline[key];
    }
    snapshot.pressureSize = !!baseline.pressureSize; snapshot.pressure = !!baseline.pressure;
    // Do not capture stale source settings after an in-memory edit.
    const sizeValid = opts.pressure === undefined && (opts.sizeScale || 1) === 1 && ['sizePx', 'minSizeRatio', 'maxSizePx', 'pressureSize', 'pressure'].every(k =>
      (k === 'sizePx' && brush._pcScalarSyncedSize) || brush[k] === before[k]);
    const spacingValid = !(opts.spacingOverride > 0) && brush.spacingPct === before.spacingPct;
    const render = savedRenderSettings(brush, baseline, opts);
    const data = util.utf8Encode(JSON.stringify({version: 1, native, baseline: snapshot, sizeValid, spacingValid, render}));
    if (data.length > 8192) return null;
    const chunk = new Uint8Array(data.length + 12), view = new DataView(chunk.buffer);
    view.setUint32(0, data.length); chunk.set(util.utf8Encode('bcPS'), 4); chunk.set(data, 8);
    view.setUint32(chunk.length - 4, util.crc32(chunk, 4, chunk.length - 4));
    return chunk;
  }

  // Raw assets of a Procreate dual brush whose secondary was baked into the BRU tip.
  const PC_DUAL_CHUNK = 'bcPD';
  const PC_DUAL_MAX = 32 * 1024 * 1024;
  function dualBridgeRead(bytes) {
    if (!bytes || !png.isPng(bytes)) return null;
    for (let at = 8; at + 12 <= bytes.length;) {
      const n = util.u32(bytes, at), end = at + n + 12;
      if (end > bytes.length || util.ascii(bytes, at + 4, 4) === 'IEND') return null;
      if (util.ascii(bytes, at + 4, 4) === PC_DUAL_CHUNK) {
        if (n < 12 || n > PC_DUAL_MAX || util.u32(bytes, at + 8) !== 1 ||
            util.u32(bytes, end - 4) !== util.crc32(bytes, at + 4, end - 4)) return null;
        const len = util.u32(bytes, at + 12);
        if (len > 4096 || 16 + len >= n + 8) return null;
        try {
          const state = JSON.parse(util.utf8Decode(bytes.subarray(at + 16, at + 16 + len)));
          if (!state || typeof state.fingerprint !== 'string') return null;
          return { state, archive: bytes.subarray(at + 16 + len, end - 4), chunk: bytes.subarray(at, end) };
        } catch (_) { return null; }
      }
      at = end;
    }
    return null;
  }
  function dualBridgePresent(bytes) {
    if (!bytes || !png.isPng(bytes)) return false;
    for (let at = 8; at + 12 <= bytes.length;) {
      const n = util.u32(bytes, at), type = util.ascii(bytes, at + 4, 4);
      if (type === PC_DUAL_CHUNK) return true;
      if (type === 'IEND' || at + n + 12 > bytes.length) break;
      at += n + 12;
    }
    return false;
  }
  function dualBridgeState(brush) {
    const b = (brush._bruDepthAsUi || brush._procreateDualDepthUi) && brush.hasTexture ? Object.assign({}, brush, { textureDepth: 1 - brush.textureDepth }) : brush;
    const ignored = new Set(['name', 'sizePx', 'source', 'pkgId', 'bruUuid', 'enabled', 'tipSource', 'oldTexId', 'textureCanvasSpace']);
    const normalized = withExportSettings(b, {}), state = {};
    Object.keys(normalized).forEach(function (key) {
      if (key[0] !== '_' && !ignored.has(key)) state[key] = normalized[key];
    });
    state.bridgeTextureBytes = b._rawBruTexture;
    state.bridgeGrainPixels = b._grainRgba;
    state.bridgePatternPixels = b._patternPixels;
    // Buffer and Uint8Array represent the same bytes at Node entry points.
    // Canonicalize without copying pixels so the writer and a file read agree.
    function canonical(v) {
      if (v instanceof Uint8Array && !(v instanceof Uint8ClampedArray)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v;
      if (Array.isArray(v)) return v.map(canonical);
      const out = {}; Object.keys(v).forEach(function (key) { out[key] = canonical(v[key]); });
      return out;
    }
    return util.md5(util.utf8Encode(util.brushFingerprint(canonical(state))));

  }
  // Library references describe one physical layer. Pair resolution attaches
  // link metadata and a child after parsing, neither changes this layer.
  function libraryBridgeState(brush) {
    const layer = Object.assign({}, brush);
    for (const key of ['dualOn','dualTip','dualBrush','dualSubBrush','bruDualRefUuid','bruDualEnabled','bruDualBlendMode','dualBlendMode','bruLinkInfo','bruLinkTemplate','embeddedTips','dualSubName','bruVersion']) delete layer[key];
    return dualBridgeState(layer);
  }
  const PC_ARCHIVE_CHUNK = 'bcPA';
  const PC_ARCHIVE_MAX = 4 * 1024 * 1024;
  function nativeArchiveUntouched(b) {
    // A Procreate archive rebuilt from a native BRU already carries the BRU
    // metadata and tip for its return trip. Appending a second backup changes
    // the tip's content ID while its original BRU metadata still refers to it.
    return !!(b && b.source === 'procreate' && !b._bruExtra && !b._bruTexParams && !b._bruPressure &&
      !b.shapeInverted && !b.flipX && !b.flipY && b._rawArchive && b._rawArchive.length <= PC_ARCHIVE_MAX &&
      b._rawBrushState === util.brushFingerprint(b) && b._rawGrainState === util.brushFingerprint({tip:b._grainRgba}));
  }
  function archiveLayerPrefix(b, version) {
    let normalized = b;
    if (version === 2 && b.tip && b.tip.rgba) {
      normalized = Object.assign({}, normalized, {tip:{w:b.tip.w, h:b.tip.h, rgba:b.tip.rgba}});
    }
    if (b.dynamicsControlAngle === undefined && (b.bruRotationMode || 0) > 0) {
      normalized = Object.assign({}, normalized, {dynamicsControlAngle:({1:6,2:5,3:2})[b.bruRotationMode]});
    }
    return libraryBridgeState(normalized) + ':' + String(b.sizePx) + ':';
  }

  const PC_PREVIEW_MAX = 2 * 1024 * 1024;
  function validNativePreview(bytes) {
    if (!bytes || bytes.length > PC_PREVIEW_MAX || !procreateGrainPng(bytes)) return false;
    const width = util.u32(bytes, 16), height = util.u32(bytes, 20);
    if (width > 2048 || height > 2048 || width * height > 4 * 1024 * 1024) return false;
    for (let at = 8; at + 12 <= bytes.length;) {
      const n = util.u32(bytes, at), end = at + n + 12;
      if (end > bytes.length || util.u32(bytes, end - 4) !== util.crc32(bytes, at + 4, end - 4)) return false;
      if (util.ascii(bytes, at + 4, 4) === 'IEND') {
        if (end !== bytes.length) return false;
        try { png.decode(bytes); return true; } catch (_) { return false; }
      }
      at = end;
    }
    return false;
  }
  function sourceNativePreview(brush) {
    const entries = brush && brush._rawEntries;
    if (!Array.isArray(entries) ||
        brush._rawTipState !== util.brushFingerprint({tip:brush.tip}) ||
        brush._rawGrainState !== util.brushFingerprint({tip:brush._grainRgba})) return null;
    const matches = entries.filter(e => e.name === 'QuickLook/Thumbnail.png');
    return matches.length === 1 && validNativePreview(matches[0].data) ? matches[0].data : null;
  }
  function readNativeArchive(bytes) {
    if (!bytes || !png.isPng(bytes)) return null;
    for (let at=8; at+12<=bytes.length;) {
      const n=util.u32(bytes,at), end=at+n+12, type=util.ascii(bytes,at+4,4);
      if (end>bytes.length || type==='IEND') return null;
      if (type===PC_ARCHIVE_CHUNK) {
        if (n<12 || n>PC_ARCHIVE_MAX || util.u32(bytes,end-4)!==util.crc32(bytes,at+4,end-4)) return null;
        const version=util.u32(bytes,at+8), len=util.u32(bytes,at+12);
        if ((version!==1 && version!==2) || len>2048) return null;
        const start=version===2 ? at+20 : at+16;
        const archiveLength=version===2 ? util.u32(bytes,at+16) : end-4-(start+len);
        if (start+len+archiveLength>end-4 || !archiveLength || (version===1 && start+len+archiveLength!==end-4)) return null;
        try { const state=JSON.parse(util.utf8Decode(bytes.subarray(start,start+len)));
          if (!state || typeof state.fingerprint!=='string') return null;
          const archive=bytes.subarray(start+len,start+len+archiveLength);
          if (util.ascii(archive,0,6)!=='bplist' || !procreate.isValidNativeArchive(archive)) return null;
          const thumb=version===2 ? bytes.subarray(start+len+archiveLength,end-4) : null;
          return {state,archive,thumbnail:validNativePreview(thumb) ? thumb : null,chunk:bytes.subarray(at,end)};
        } catch (_) {return null;}
      }
      at=end;
    }
    return null;
  }
  function writeNativeArchive(brush, baseline, opts) {
    const archive=brush._rawArchive;
    if (!archive || archive.length>PC_ARCHIVE_MAX) return null;
    const name = String(baseline.name || '');
    const fileName = sanitizeName(name, 0);
    const record = {version:2, fingerprint:archiveLayerPrefix(baseline, 2) + fileName,
      link:baseline.bruDualRefUuid || null, enabled:baseline.bruDualEnabled};
    if (record.link && Number.isInteger(baseline.bruDualBlendMode)) {
      const scalar = baseline._pcScalar || readPcScalar(baseline._rawTipPng);
      const dual = scalar && scalar.render && scalar.render[1];
      if (!dual || !Array.isArray(dual.controls) || dual.controls[1] !== baseline.bruDualBlendMode) record.dualMode = baseline.bruDualBlendMode;
    }
    if (name !== fileName) {
      const writtenName = opts._noFilePassthrough ? fileName : name;
      record.nameHash = util.md5(util.utf8Encode(writtenName));
    }
    const state=util.utf8Encode(JSON.stringify(record));
    let thumbnail=sourceNativePreview(brush);
    if (thumbnail && 12+state.length+archive.length+thumbnail.length>PC_ARCHIVE_MAX) thumbnail=null;
    const version=thumbnail ? 2 : 1, header=version===2 ? 12 : 8;
    const n=header+state.length+archive.length+(thumbnail ? thumbnail.length : 0);
    if (state.length>2048 || n>PC_ARCHIVE_MAX) return null;
    const out=new Uint8Array(n+12), view=new DataView(out.buffer);
    view.setUint32(0,n);out.set(util.utf8Encode(PC_ARCHIVE_CHUNK),4);view.setUint32(8,version);view.setUint32(12,state.length);
    if (version===2) view.setUint32(16,archive.length);
    out.set(state,8+header);out.set(archive,8+header+state.length);
    if (thumbnail) out.set(thumbnail,8+header+state.length+archive.length);
    view.setUint32(out.length-4,util.crc32(out,4,out.length-4));return out;
  }
  function editedArchiveDualMode(brush, state) {
    if (!state.link) return undefined;
    // Older native archives recorded the original f122 in the render sidecar.
    const render = brush._pcScalar && brush._pcScalar.render;
    const controls = render && render[1] && render[1].controls;
    const raw = brush._rawState || {};
    const previous = state.dualMode ?? (controls && controls[1]) ?? raw.bruDualBlendMode;
    const current = brush.bruDualBlendMode;
    if (Number.isInteger(current) && current !== previous) {
      // f122 and Procreate use different numeric enumerations for the same name.
      const name = Object.keys(procreate.dualBlendCodes).find(k => bru.dualBlendValue(k, -1) === current);
      return name === undefined ? 0 : procreate.dualBlendCodes[name];
    }
    if (brush.dualBlendMode === raw.dualBlendMode || brush.dualBlendMode === undefined) return undefined;
    const mode = brush.dualBlendMode;
    return typeof mode === 'number' ? Math.min(30, Math.max(0, Math.round(mode))) :
      procreate.dualBlendCodes[String(mode).toLowerCase().replace(/[^a-z]/g, '')] || 0;
  }
  function allowNativeProcreateRestore(opts) {
    return opts.fidelity !== false && !opts.forceRebuild && !opts.noTextureBake && opts.procreateGrainBridge !== false &&
      opts.pressure === undefined && !(opts.spacingOverride > 0) && (opts.sizeScale === undefined || opts.sizeScale === 1) &&
      !(opts.fgBgDyn > 0) && opts.grainBake !== false && opts.grainMode !== 'tip' &&
      ['scatter','textureDepth','minSizeRatio','minOpacityRatio','flowPct','pressureCurve','pressureCurves','prop18'].every(k => opts[k] === undefined);
  }
  function eligibleNativeArchive(brush, opts, checkChild, displayName) {
    const saved=brush && brush._nativeArchiveBackup;
    if (!saved || !allowNativeProcreateRestore(opts) ||
        (brush.bruDualRefUuid||null)!==(saved.state.link||null) || brush.bruDualEnabled!==saved.state.enabled) return null;
    if (saved.state.version !== undefined && saved.state.version !== 1 && saved.state.version !== 2) return null;
    const prefix = archiveLayerPrefix(brush, saved.state.version);
    if (!saved.state.fingerprint.startsWith(prefix)) return null;
    if (checkChild && saved.state.link) {
      if (!brush.dualOn || !brush.dualSubBrush ||
          (brush.dualSubBrush.pkgId !== saved.state.link && brush.dualSubBrush.bruUuid !== saved.state.link) ||
          !eligibleNativeArchive(brush.dualSubBrush,opts,false) ||
          util.brushFingerprint({tip:brush.dualTip}) !== util.brushFingerprint({tip:brush.dualSubBrush.tip})) return null;
    }
    const name = String(displayName === undefined ? (brush.name || '') : displayName);
    const originalName = saved.state.fingerprint.slice(prefix.length);
    const previousName = brush._rawState && brush._rawState.name;
    const explicitRename = typeof previousName === 'string' && previousName !== name;
    const sameName = saved.state.nameHash ? util.md5(util.utf8Encode(name)) === saved.state.nameHash : name === originalName && !explicitRename;
    const mode = editedArchiveDualMode(brush, saved.state);
    if (sameName && mode === undefined) return saved.archive;
    try {
      // Older backups record only the cleaned BRU name. Preserve native punctuation
      // when it agrees with the original archive itself.
      const native = plist.unarchive(saved.archive), changes = {};
      if (!sameName && (explicitRename || saved.state.nameHash || sanitizeName(name, 0) !== originalName || native.name !== name)) {
        changes.name = String(brush.name || '');
      }
      if (mode !== undefined) {
        changes.dualBlendMode = mode;
        if ('dualBlendModeExtended' in native) changes.dualBlendModeExtended = mode;
      }
      return Object.keys(changes).length ? bplist.patchKeyedArchive(saved.archive, changes) : saved.archive;
    } catch (_) { return null; }
  }
  function unchangedNativePreviewLayer(layer) {
    if (!layer) return false;
    const fingerprint = util.brushFingerprint(layer);
    return layer._rawBrushState === fingerprint ||
      (!!layer._pcNativeArchiveEligible && layer._pcNativePairState === fingerprint);
  }
  function dualBridgeWrite(brush, baseline, previewOriginal) {
    try {
      const generated = zip.read(procreate.writeBrush(brush, { _keepLibraryReferences: true }));
      const entries = [], allowed = /^(?:Sub01\/)?(?:Brush\.archive|Shape\.png|Grain\.png)$/;
      const sourcePair = previewOriginal || brush;
      let total = 0;
      for (const e of generated) {
        if (!allowed.test(e.name)) continue;
        total += e.size;
        if (total > PC_DUAL_MAX || e.size > (e.name.endsWith('Brush.archive') ? 4 * 1024 * 1024 : PC_GRAIN_ASSET_MAX)) return null;
        let data = e.data();
        const sub = e.name.startsWith('Sub01/');
        const original = sub ? brush.dualSubBrush : brush;
        const sourceLayer = sub ? sourcePair.dualSubBrush : sourcePair;
        if (sourceLayer && e.name.endsWith('Brush.archive') && sourceLayer._rawArchive &&
            unchangedNativePreviewLayer(sourceLayer) &&
            sourceLayer._rawTipState === util.brushFingerprint({tip:sourceLayer.tip}) &&
            sourceLayer._rawGrainState === util.brushFingerprint({tip:sourceLayer._grainRgba})) data = sourceLayer._rawArchive;
        if (original && e.name.endsWith('Grain.png') && original._rawGrain &&
            original._rawGrainState === util.brushFingerprint({tip: original._grainRgba})) data = original._rawGrain;
        if (original && e.name.endsWith('Shape.png') && original._rawShape &&
            original._rawTipState === util.brushFingerprint({tip: original.tip}) && !original.flipX && !original.flipY &&
            !!original.shapeInverted === !!(original._rawNormalized || {}).shapeInverted) data = original._rawShape;
        if (e.name.endsWith('.png') && !procreateGrainPng(data)) return null;
        entries.push({name: e.name, data});
      }
      for (const pair of [['', sourcePair], ['Sub01/', sourcePair.dualSubBrush]]) {
        const layer = pair[1], preview = sourceNativePreview(layer);
        if (preview && unchangedNativePreviewLayer(layer) && total + preview.length <= PC_DUAL_MAX) {
          entries.push({name:pair[0] + 'QuickLook/Thumbnail.png', data:preview});
          total += preview.length;
        }
      }
      if (!entries.some(e => e.name === 'Brush.archive') || !entries.some(e => e.name === 'Sub01/Brush.archive')) return null;
      const archive = zip.write(entries);
      const state = util.utf8Encode(JSON.stringify({ fingerprint: dualBridgeState(baseline),
        sizePx: baseline.sizePx, name: baseline.name, bruColor: baseline.bruColor,
        colorJitterFgBg: baseline.colorJitterFgBg }));
      const n = 8 + state.length + archive.length;
      if (n > PC_DUAL_MAX || state.length > 4096) return null;
      const chunk = new Uint8Array(n + 12), view = new DataView(chunk.buffer);
      view.setUint32(0, n); chunk.set(util.utf8Encode(PC_DUAL_CHUNK), 4);
      view.setUint32(8, 1); view.setUint32(12, state.length);
      chunk.set(state, 16); chunk.set(archive, 16 + state.length);
      view.setUint32(chunk.length - 4, util.crc32(chunk, 4, chunk.length - 4));
      return chunk;
    } catch (_) { return null; }
  }

  function procreateGrainPng(bytes) {
    return bytes && bytes.length >= 45 && bytes.length <= PC_GRAIN_ASSET_MAX &&
      png.isPng(bytes) && util.u32(bytes, 8) === 13 && util.ascii(bytes, 12, 4) === 'IHDR' &&
      util.u32(bytes, 16) > 0 && util.u32(bytes, 16) <= 4096 &&
      util.u32(bytes, 20) > 0 && util.u32(bytes, 20) <= 4096 &&
      util.ascii(bytes, bytes.length - 8, 4) === 'IEND';
  }

  // A native Procreate preset may name a library texture without embedding its pixels.
  function procreateLibraryGrain(path) {
    return typeof path === 'string' && path.length > 0 && path.length <= 512 && path !== '$null';
  }

  function readProcreateGrainChunk(bytes) {
    if (!bytes || !png.isPng(bytes)) return null;
    for (let at = 8; at + 12 <= bytes.length;) {
      const size = util.u32(bytes, at);
      const end = at + size + 12;
      if (end > bytes.length || util.ascii(bytes, at + 4, 4) === 'IEND') return null;
      if (util.ascii(bytes, at + 4, 4) === PC_GRAIN_CHUNK) {
        const head = at + 8;
        if (size < PC_GRAIN_HEADER || util.u32(bytes, head) !== 1) return null;
        const paramsLength = util.u32(bytes, head + 4);
        const grainLength = util.u32(bytes, head + 8);
        const images = head + PC_GRAIN_HEADER + paramsLength;
        const payloadEnd = end - 4;
        if (paramsLength > 2048 || images + grainLength > payloadEnd) return null;
        const grain = bytes.subarray(images, images + grainLength);
        const shape = bytes.subarray(images + grainLength, payloadEnd);
        if ((grain.length && !procreateGrainPng(grain)) || (shape.length && !procreateGrainPng(shape)) ||
            util.u32(bytes, payloadEnd) !== util.crc32(bytes, at + 4, payloadEnd)) return null;
        try {
          const rawJson = JSON.parse(util.utf8Decode(bytes.subarray(head + PC_GRAIN_HEADER, images)));
          const params = procreate.grainArchiveScalars(rawJson);
          if (params.grainDepth === undefined) return null;
          if (!grain.length) {
            if (!procreateLibraryGrain(rawJson._bundledGrainPath)) return null;
            params.bundledGrainPath = rawJson._bundledGrainPath;
          }
          const noShape = rawJson && rawJson._noShape === true;
          const bundledShapePath = rawJson && typeof rawJson._bundledShapePath === 'string' && rawJson._bundledShapePath ? rawJson._bundledShapePath : undefined;
          return { grain: grain.length ? grain : null, shape, shapeInverted: rawJson._shapeInverted === true, params, noShape, bundledShapePath, targetF123: Number.isFinite(rawJson._bruF123) && rawJson._bruF123 >= 0 && rawJson._bruF123 <= 1 ? rawJson._bruF123 : undefined, targetTextureMd5: typeof rawJson._bruTextureMd5 === 'string' && /^[0-9a-f]{32}$/i.test(rawJson._bruTextureMd5) ? rawJson._bruTextureMd5.toUpperCase() : undefined, targetSettings: rawJson._bruSettings && typeof rawJson._bruSettings === 'object' ? rawJson._bruSettings : null, targetTextureAbsent: rawJson._bruTextureAbsent === true, chunk: bytes.subarray(at, end) };
        } catch (e) { return null; }
      }
      at = end;
    }
    return null;
  }

  /* 【第348轮（作者：Lead）】`bcMK` 标记 chunk 的读写。
     与 `bcPG` 分开：`bcPG` 背的是 grain 原图（大），`bcMK` 只背「源无 Shape」这个布尔事实（几十字节）。 */
  function buildMarkChunk(noShape, bundledShapePath, library) {
    if (!noShape && !bundledShapePath && !library) return null;
    const obj = {};
    if (noShape) obj._noShape = true;
    if (bundledShapePath) obj._bundledShapePath = bundledShapePath;
    if (library) obj.library = library;
    const payload = util.utf8Encode(JSON.stringify(obj));
    if (payload.length > PC_MARK_MAX) return null;
    const chunk = new Uint8Array(payload.length + 12);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, payload.length);
    chunk.set(util.utf8Encode(PC_MARK_CHUNK), 4);
    chunk.set(payload, 8);
    view.setUint32(chunk.length - 4, util.crc32(chunk, 4, chunk.length - 4));
    return chunk;
  }

  /* 从一个 Procreate 源笔刷推断标记（只在源确实没有 Shape 时产出）。 */
  function writeProcreateMarkChunk(brush) {
    const noShape = !!(brush && !brush._rawShape && !brush.shapeFromLibrary && brush.tipSource === 'none');
    const bundled = brush && typeof brush.bundledShapePath === 'string' && brush.bundledShapePath ? brush.bundledShapePath : undefined;
    return buildMarkChunk(noShape, bundled);
  }

  function readProcreateMarkChunk(bytes) {
    if (!bytes || !png.isPng(bytes)) return null;
    for (let at = 8; at + 12 <= bytes.length;) {
      const size = util.u32(bytes, at);
      const end = at + size + 12;
      if (end > bytes.length || util.ascii(bytes, at + 4, 4) === 'IEND') return null;
      if (util.ascii(bytes, at + 4, 4) === PC_MARK_CHUNK) {
        const payloadEnd = end - 4;
        if (size > PC_MARK_MAX || util.u32(bytes, payloadEnd) !== util.crc32(bytes, at + 4, payloadEnd)) return null;
        try {
          const raw = JSON.parse(util.utf8Decode(bytes.subarray(at + 8, payloadEnd)));
          return {
            library: raw && raw.library && /^[0-9a-f]{32}$/.test(raw.library.fingerprint) &&
              (!raw.library.shapeRef || procreateLibraryGrain(raw.library.shapeRef)) &&
              (!raw.library.grainRef || procreateLibraryGrain(raw.library.grainRef)) &&
              (raw.library.shapeRef || raw.library.grainRef) ? {
                fingerprint:raw.library.fingerprint, version:raw.library.version, shapeRef:raw.library.shapeRef || null,
                grainRef:raw.library.grainRef || null, params:procreate.grainArchiveScalars(raw.library.params)
              } : null,
            noShape: !!(raw && raw._noShape === true),
            bundledShapePath: raw && typeof raw._bundledShapePath === 'string' && raw._bundledShapePath ? raw._bundledShapePath : undefined
          };
        } catch (e) { return null; }
      }
      at = end;
    }
    return null;
  }

  function writeProcreateGrainChunk(brush, unbakedTip, originalBrush, targetF123, targetTexture, targetSettings, targetHasTexture) {
    if (brush.source !== 'procreate' || brush._bruExtra || brush._bruTexParams) return null;
    const libraryOnly = !brush._rawGrain && procreateLibraryGrain(brush.bundledGrainPath) &&
      ((!brush._grainRgba && !brush.hasTexture) || brush.grainFromLibrary);
    if (!libraryOnly && !procreateGrainPng(brush._rawGrain)) return null;
    const grain = libraryOnly ? new Uint8Array(0) : brush._rawGrain;
    const params = procreate.grainArchiveScalars(brush._params);
    params.grainDepth = (libraryOnly || brush.hasTexture) ? (brush.textureDepth === undefined ? 0.6 : brush.textureDepth) : 0;
    if (Number.isFinite(targetF123) && targetF123 >= 0 && targetF123 <= 1 && targetTexture && targetTexture.length &&
        targetSettings && [targetSettings.scale, targetSettings.brightness, targetSettings.contrast].every(Number.isFinite)) {
      params._bruF123 = targetF123;
      params._bruTextureMd5 = util.md5(targetTexture).toUpperCase();
      params._bruSettings = targetSettings;
    }
    if (!targetHasTexture) params._bruTextureAbsent = true;
    if (libraryOnly) params._bundledGrainPath = brush.bundledGrainPath;
    // 第347轮（缺陷清单 L824）：源 Procreate 笔刷原本无 Shape.png（如缪斯之梦主笔「无 Shape、只有 Grain」）时，
    // 记录 _noShape 标记（及可选 bundledShapePath），经 BRU 往返回写 brushset 时不再凭空补合成硬圆 Shape.png。
    if (!brush._rawShape && !brush.shapeFromLibrary && brush.tipSource === 'none') {
      params._noShape = true;
      if (brush.bundledShapePath) params._bundledShapePath = brush.bundledShapePath;
    }
    let shape = new Uint8Array(0);
    const original = originalBrush || brush;
    if (libraryOnly && original.grainFromLibrary && original._rawShape &&
        original._rawTipState === util.brushFingerprint({tip:original.tip}) && !original.flipX && !original.flipY) {
      shape = original._rawShape;
      params._shapeInverted = !!original.shapeInverted;
    } else if (unbakedTip) {
      const { w, h, rgba } = unbakedTip;
      const gray = new Uint8Array(w * h);
      for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4 + 3];
      shape = png.encodeGray(w, h, gray);
    }
    if (shape.length && !procreateGrainPng(shape)) return null;
    const data = util.utf8Encode(JSON.stringify(params));
    const payloadLength = PC_GRAIN_HEADER + data.length + grain.length + shape.length;
    const chunk = new Uint8Array(payloadLength + 12);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, payloadLength);
    chunk.set(util.utf8Encode(PC_GRAIN_CHUNK), 4);
    view.setUint32(8, 1);
    view.setUint32(12, data.length);
    view.setUint32(16, grain.length);
    chunk.set(data, 20);
    chunk.set(grain, 20 + data.length);
    chunk.set(shape, 20 + data.length + grain.length);
    view.setUint32(chunk.length - 4, util.crc32(chunk, 4, chunk.length - 4));
    return chunk;
  }

  function addProcreateGrainChunk(bytes, chunk) {
    return util.concat([bytes.subarray(0, bytes.length - 12), chunk, bytes.subarray(bytes.length - 12)]);
  }

  function procreateGrainState(brush) {
    const { tip, texAssetId, hasTexture, textureDepth, textureInverted, textureScale,
      textureBrightness, textureContrast, textureRotation, bruTextureBlendMode, bruShapeInverted } = brush;
    return util.brushFingerprint({ tip, texAssetId, hasTexture, textureDepth, textureInverted, textureScale,
      textureBrightness, textureContrast, textureRotation, bruTextureBlendMode, bruShapeInverted });
  }

  function rememberProcreateGrain(brush, tipPng) {
    const carried = readProcreateGrainChunk(tipPng);
    if (!carried) return;
    brush._procreateGrainChunk = carried;
    brush._procreateGrainState = procreateGrainState(brush);
    brush._procreateGrainPixelState = util.brushFingerprint({tip:brush.tip, grain:brush._grainRgba, pattern:brush._patternPixels});
  }

  function unchangedProcreateGrain(brush) {
    const carried = brush._procreateGrainChunk;
    if (carried && !carried.grain && (brush.hasTexture || brush._rawBruTexture || brush._grainRgba ||
        brush._patternPixels || brush.texAssetId || brush.textureDepth > 0)) return null;
    return carried && brush._procreateGrainState === procreateGrainState(brush) ? carried : null;
  }
  function burntOutlineCandidate(brush, opts) {
    if (!brush || brush.source === 'bru' || brush._bruExtra) return false;
    if (opts && opts.fidelity === false) return false;
    if (brush.dualOn || brush.dualTip || brush.bruDualSubBrush || brush.bruDualRefUuid) return false;
    if (!(Number(brush.burntEdgesAmount) >= 0.5)) return false;
    if (brush.hasTexture || brush.hasGrain) return false;
    if (Number(brush.hollowPct) > 0) return false;
    return true;
  }
  function nativeDualBorderCandidate(brush, opts) {
    const sub = brush && brush.bruDualSubBrush;
    return !!(sub && brush._pcBurntBorderSubUuid && sub.bruUuid === brush._pcBurntBorderSubUuid &&
      brush.bruDualEnabled && brush.bruDualRefUuid === sub.pkgId && brush.burntEdgesAmount === 1 &&
      brush.burntEdgesBlendMode === undefined && brush.burntEdgesBlendModeExtended === undefined &&
      brush.colorPressureSecondary === undefined && brush.borderOn === undefined && brush.borderBlend === undefined &&
      brush.borderStrength === undefined && brush.borderBrightness === undefined &&
      opts.fidelity !== false && opts.pressure !== false && opts.burntOutline !== 'off');
  }
  function nativeBorderSubInPack(brush, list) {
    const linked = list.filter(s => s && s !== brush && (s.pkgId === brush.bruDualRefUuid || s.bruUuid === brush.bruDualRefUuid));
    return linked.length === 1 && linked[0].bruUuid === brush._pcBurntBorderSubUuid ? linked[0] : null;
  }
  /* burntOutline === 'both'（设置里「描边笔刷出两个版本」）：候选笔刷后面紧跟一支「-描边版」复制品。
     原对象保持同一个引用（双笔 indexOf 查找依赖它），只是在 both 模式下不加描边。 */
  function expandBurntOutlineVariants(list, opts) {
    if (!opts || opts.burntOutline !== 'both' || !Array.isArray(list)) return list;
    /* 幂等：app 为了进度条名字对得上会先展开一次，这里再进来不能二次复制 */
    if (list.some(function (b) { return b && b._burntOutlineCopy; })) return list;
    const out = [];
    list.forEach(function (b) {
      out.push(b);
      if (burntOutlineCandidate(b, opts)) {
        out.push(Object.assign({}, b, { name: (b.name || '') + BURNT_OUTLINE_SUFFIX, _burntOutlineCopy: true }));
      } else if (nativeDualBorderCandidate(b, opts)) {
        const linked = nativeBorderSubInPack(b, list);
        if (!linked) return;
        const subSuffix = '_副笔尖';
        const baseName = util.cutUtf16(sanitizeName(b.name, 0), 60 - BURNT_OUTLINE_SUFFIX.length - subSuffix.length);
        const name = baseName + BURNT_OUTLINE_SUFFIX;
        const pkgId = genUuid();
        const sub = Object.assign({}, linked, {
          name: name + subSuffix, pkgId, bruUuid: genUuid(), _burntOutlineCopy: true
        });
        out.push(Object.assign({}, b, {
          name, pkgId, bruUuid: genUuid(), bruDualRefUuid: pkgId, bruDualSubBrush: sub,
          dualSubName: sub.name, _pcBurntBorderSubUuid: sub.bruUuid, _burntOutlineCopy: true
        }), sub);
      }
    });
    return out;
  }
  /* 主笔不动（仍用画笔颜色），另建一支副笔：同笔尖但 RGB 涂深、关湿边、开 f38「颜色」+ f141 辅助 + f146，
     尺寸 ×BURNT_OUTLINE_RATIO，内嵌成画世界原生双笔（f119=1 + f121）。uuid/pkgId 关系照 buildBruDualPairBrushes。 */
  function applyBurntOutline(brush, opts) {
    const pkg = genUuid(), pri = genUuid(), sec = genUuid();
    let darkTip = brush.tip;
    if (darkTip && darkTip.rgba && darkTip.rgba.length === darkTip.w * darkTip.h * 4) {
      const r = new Uint8Array(darkTip.rgba);
      for (let i = 0; i < r.length; i += 4) { r[i] = BURNT_OUTLINE_RGB[0]; r[i + 1] = BURNT_OUTLINE_RGB[1]; r[i + 2] = BURNT_OUTLINE_RGB[2]; }
      darkTip = { w: darkTip.w, h: darkTip.h, rgba: r };
    }
    const subSrc = Object.assign({}, brush, {
      name: BURNT_OUTLINE_SUB_NAME, tip: darkTip,
      sizePx: (Number(brush.sizePx) > 0 ? Number(brush.sizePx) : 100) * BURNT_OUTLINE_RATIO,
      wetEdgesOn: false, wetEdgesAmount: 0,
      hollowColor: BURNT_OUTLINE_COLOR,
      bruUuid: sec, bruDualRefUuid: null, pkgId: pkg,
      _burntOutlineDone: true, _keepTipRgb: true,
      _rawUnknown: [rawVarintField(38, 1), rawVarintField(141, 1), rawVarintField(146, 1)]
    });
    const sub = makeBru(subSrc, Object.assign({}, opts, { embedSubTip: false }));
    return Object.assign({}, brush, {
      bruUuid: pri, bruDualRefUuid: pkg, pkgId: pkg,
      dualSubName: BURNT_OUTLINE_SUB_NAME, bruDualSubBrush: sub.meta, embeddedSubPng: sub.pngBytes, bruDualEnabled: true,
      hollowColor: BURNT_OUTLINE_COLOR,
      _rawUnknown: (Array.isArray(brush._rawUnknown) ? brush._rawUnknown : []).concat([rawVarintField(146, 1)]),
      _burntOutlineDone: true
    });
  }

  /* 【第294轮（作者：Lead）】BRU 记录可以内嵌 **多张** PNG：主笔尖之后的「副笔尖 + 副笔纹理」。
     原生实测（珠宝装饰·金属勾线02/03、金边装饰05）：f121 里是两组 (纹理 md5, 副笔尖 md5)，
     记录尾部紧跟两张 PNG（副笔尖 11~21KB + 副笔纹理 806KB，后者与主纹理同图）。
     以前只写回 embeddedTips[0]，第二张被静默丢弃 → 画世界里副笔那层没有纹理，用户看到「转换后纹路没了」。
     现在按源顺序把全部内嵌 PNG 逐字节拼接写回；记录 +0x73 的长度本来就是整段长度，容器字段不用改。 */
  function bruEmbeddedSubPng(brush) {
    if (!brush || brush.source !== 'bru' || !brush.bruDualRefUuid) return undefined;
    const tips = brush.embeddedTips || [];
    if (!tips.length) return undefined;
    const parts = [];
    for (let i = 0; i < tips.length; i++) {
      const t = tips[i];
      if (t && t.raw && t.raw.length) { parts.push(new Uint8Array(t.raw)); continue; }
      if (t && t.rgba && t.w > 0 && t.h > 0 && t.rgba.length === t.w * t.h * 4) { parts.push(png.encode(t.w, t.h, t.rgba)); continue; }
      break;   /* 解不出来的那张之后不再拼，宁可少一段也不写坏 */
    }
    if (!parts.length) return undefined;
    if (parts.length === 1) return parts[0];
    let total = 0;
    for (let i = 0; i < parts.length; i++) total += parts[i].length;
    const out = new Uint8Array(total);
    let at = 0;
    for (let i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
    return out;
  }

  /* 【第291轮（作者：Claude）R290-03】BRU 源双笔改「尺寸倍率」时，f121 里的副笔尺寸也按同倍率缩放。
     以前主笔 f8 放大了、f121 的副笔 f8 原样透传 → 描边类双笔（主笔 + 大一圈的深色副笔）框被主笔盖住消失。
     副笔的尺寸字段在 23 条原生 f121 里（楠 13 + 轻舟 10）全是 float32（wire 5），原位改 4 字节，长度不变，
     _rawMeta / bruLinkTemplate 其余字节逐字节保留。规则照主笔：f8×r（≤5000）、f9 同比例、
     f12 = max(新 f8, 原 f12)、f135 = f12/500、f136 = f8/f12；其它字段（f50 比例、f11 等）不动。 */
  function pbScan(buf, start, end) {
    const out = []; let i = start;
    const rv = function () { let s = 0, v = 0; for (;;) { if (i >= end) return -1; const c = buf[i++]; v += (c & 127) * Math.pow(2, s); if (!(c & 128)) return v; s += 7; if (s > 63) return -1; } };
    while (i < end) {
      const start = i, k = rv(); if (k < 0) break;
      const f = Math.floor(k / 8), w = k % 8;
      let off = i, value;
      if (w === 0) { value = rv(); if (value < 0) break; }
      else if (w === 5 || w === 1) { i += w === 5 ? 4 : 8; }
      else if (w === 2) { const len = rv(); if (len < 0) break; off = i; i += len; }
      else break;
      if (i > end) break;
      out.push({ f, w, start, off, len: i - off, end: i, value });
    }
    return out;
  }
  function scaleBruSubSizeInPlace(buf, start, end, ratio) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const fl = {};
    pbScan(buf, start, end).forEach(function (x) { if (x.w === 5 && fl[x.f] === undefined) fl[x.f] = x.off; });
    if (fl[8] === undefined) return false;
    const get = function (f) { return dv.getFloat32(fl[f], true); };
    const set = function (f, v) { if (fl[f] !== undefined) dv.setFloat32(fl[f], v, true); };
    const w0 = get(8);
    if (!(w0 > 0)) return false;
    const w1 = Math.max(1, Math.min(5000, w0 * ratio));
    set(8, w1);
    if (fl[9] !== undefined) set(9, get(9) * (w1 / w0));
    const max0 = fl[12] !== undefined ? get(12) : 500;
    const max1 = Math.max(w1, max0 > 0 ? max0 : 500);
    set(12, max1);
    set(135, max1 / 500);
    set(136, w1 / max1);
    return true;
  }
  function scaleBruLinkTemplate(tpl, ratio) {
    if (!(tpl && tpl.length) || !(Math.abs(ratio - 1) > 1e-6)) return tpl;
    const out = new Uint8Array(tpl);
    return scaleBruSubSizeInPlace(out, 0, out.length, ratio) ? out : tpl;
  }
  function scaleBruF121InMeta(meta, ratio) {
    if (!(meta && meta.length) || !(Math.abs(ratio - 1) > 1e-6)) return meta;
    const f121 = pbScan(meta, 0, meta.length).filter(function (x) { return x.f === 121 && x.w === 2; })[0];
    if (!f121) return meta;
    const out = new Uint8Array(meta);
    return scaleBruSubSizeInPlace(out, f121.off, f121.off + f121.len, ratio) ? out : meta;
  }

  function nativePressureSecondaryEdit(brush) {
    if (!brush || brush.source !== 'bru' || !brush._rawState) return undefined;
    const value = brush.colorPressureSecondary;
    if (!Number.isFinite(value) || value < 0 || value > 1 || value === brush._rawState.colorPressureSecondary) return undefined;
    return value;
  }

  // f114 is also present in disabled native pressure blocks. Preserve the
  // block until its public secondary value is explicitly edited.
  function editedPressureFields(bytes, value) {
    const fields = pbScan(bytes, 0, bytes.length);
    if (bytes.length && (!fields.length || fields[fields.length - 1].end !== bytes.length)) return null;
    let on110 = false, on124 = false;
    for (const field of fields) {
      if (field.f === 110 && field.w === 0) on110 = !!field.value;
      if (field.f === 124 && field.w === 0) on124 = !!field.value;
    }
    const enable = value > 0 && !on110 && !on124;
    const parts = fields.filter(x => x.f !== 114 && !(enable && x.f === 110))
      .map(x => bytes.subarray(x.start, x.end));
    if (enable) parts.push(rawVarintField(110, 1));
    if (value > 0) {
      const strength = new Uint8Array(4);
      new DataView(strength.buffer).setFloat32(0, value, true);
      parts.push(util.concat([new Uint8Array(encodeBruVarint(114 * 8 + 5)), strength]));
    }
    return parts;
  }

  function editEmbeddedPressure(meta, value) {
    if (value === undefined || !meta.bruLinkTemplate) return;
    const parts = editedPressureFields(meta.bruLinkTemplate, value);
    if (!parts) return;
    const inner = util.concat(parts);
    meta.bruLinkTemplate = inner;
    if (!meta._rawMeta) return;
    const bytes = meta._rawMeta, fields = pbScan(bytes, 0, bytes.length);
    const links = fields.filter(x => x.f === 121 && x.w === 2);
    if (links.length !== 1 || fields[fields.length - 1].end !== bytes.length) return;
    const link = links[0];
    const prefix = new Uint8Array(encodeBruVarint(121 * 8 + 2).concat(encodeBruVarint(inner.length)));
    meta._rawMeta = util.concat([bytes.subarray(0, link.start), prefix, inner, bytes.subarray(link.end)]);
  }

  /* 【第296轮（作者：Lead）】从原始 meta 里读 f7（笔尖图名字）——判据必须是源文件里的真值。 */
  function readMetaField7(meta) {
    if (!meta || !meta.length) return null;
    try {
      let i = 0;
      const n = meta.length;
      const rv = function () { let v = 0, sh = 0; for (;;) { if (i >= n) return -1; const x = meta[i++]; v += (x & 127) * Math.pow(2, sh); if (!(x & 128)) return v; sh += 7; if (sh > 63) return -1; } };
      while (i < n) {
        const tag = rv(); if (tag < 0) break;
        const f = Math.floor(tag / 8), w = tag % 8;
        if (w === 0) { if (rv() < 0) break; }
        else if (w === 5) i += 4;
        else if (w === 1) i += 8;
        else if (w === 2) {
          const len = rv(); if (len < 0 || i + len > n) break;
          if (f === 7) {
            let out = '';
            for (let k = i; k < i + len; k++) out += String.fromCharCode(meta[k]);
            return out;
          }
          i += len;
        } else break;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /* 【第297轮（作者：Lead）】源 BRU 记录的字段号集合（顶层 / f121 副笔子消息各一份）。
     用途：brushset 只能带「有 Procreate 对等位的参数」，源里**压根没有**的字段（f29/f32/f33/f35/f80/f87/f119/f120/f158）
     在转回 BRU 时会被写侧按默认值凭空写出——实测第296轮 C（brushset 往返）主笔多出 f33=100/f35=51，
     App 里「亮度 51 / 对比度 100」把纹理明暗差压平，这就是用户看到的「均匀色块」。
     记下存在性，转回时只写源里真有的字段，语义与原生「不写=取缺省」一致。 */
  function bruFieldNumberSet(meta) {
    if (!meta || !meta.length) return undefined;
    const out = Array.from(new Set(pbScan(meta, 0, meta.length).map(x => x.f)));
    return out.length ? out : undefined;
  }
  function bruSubFieldNumberSet(meta) {
    if (!meta || !meta.length) return undefined;
    const f121 = pbScan(meta, 0, meta.length).filter(function (x) { return x.f === 121 && x.w === 2; })[0];
    if (!f121) return undefined;
    return bruFieldNumberSet(meta.subarray(f121.off, f121.off + f121.len));
  }
  /* 写侧对这些字段有「不写 = 取缺省」的约定，因此可以安全地按源存在性省略。
     只登记这一类；f8/f9/f12 这种必写字段永远不进这张表。 */
  const BRU_OPTIONAL_FIELDS = [29, 32, 33, 35, 51, 65, 80, 83, 87, 95, 115, 119, 120, 158];
  function bruAbsentFields(fieldSet) {
    if (!Array.isArray(fieldSet) || !fieldSet.length) return undefined;
    const have = new Set(fieldSet);
    const out = BRU_OPTIONAL_FIELDS.filter(function (f) { return !have.has(f); });
    return out.length ? out : undefined;
  }
  /* 该字段在源 BRU 里是否「本来就没有」——只对 BRU_OPTIONAL_FIELDS 内的字段成立。 */
  function hasAbsent(brush, field) {
    if (!brush || BRU_OPTIONAL_FIELDS.indexOf(field) < 0) return false;
    if (Array.isArray(brush._bruAbsentFields) && brush._bruAbsentFields.indexOf(field) >= 0) return true;
    if (Array.isArray(brush._bruFieldSet) && brush._bruFieldSet.length) return brush._bruFieldSet.indexOf(field) < 0;
    return false;
  }
  /* 把源字段集合挂到 brushset 条目上（procreate.js 的 brushConvBruExtra 会写进 archive）。 */
  function attachBruFieldSets(b) {
    if (!b || b.source !== 'bru' || !b._rawMeta) return b;
    let out = b;
    if (out._bruExportFieldSet === undefined) {
      const fs1 = bruFieldNumberSet(out._rawMeta);
      if (fs1) out = Object.assign({}, out, { _bruExportFieldSet: fs1 });
    }
    if (out._bruExportSubFieldSet === undefined) {
      const fs2 = bruSubFieldNumberSet(out._rawMeta);
      if (fs2) out = Object.assign({}, out, { _bruExportSubFieldSet: fs2 });
    }
    return out;
  }

  /* 【第297轮（作者：Lead）】副笔纹理 PNG。
     源 BRU 的副笔记录尾部有**两张**内嵌图：副笔尖 + 副笔纹理（第295轮已把「两张都写回」修进 bruEmbeddedSubPng）。
     但走 brushset 往返时，Only Sub01 的形状能过去，第二张图无处存——第296轮真机 C 组实测
     `embeddedTotal` 2→1、`dual.texAssetId` 丢失、DB 副笔 texPath 被清空，副笔那层就成了纯色块。
     这里的关键事实（第296轮报告 §③-1）：**副笔纹理与主纹理常常是同一张图**
     （珠宝装饰 10 支全部 md5=6961E380，而主纹理块在往返里一直保留着）。
     所以只要 Extra 记下的 subTexId 与本次写出的主纹理 md5 相同，就把主纹理字节原样追加成第二张内嵌 PNG：
       · 同 md5 才拼，绝不造像素；
       · 顺序与原生一致（先副笔尖，后副笔纹理）；
       · f121 里副笔的 f6/f7 由 bru.js 按 sub.texId / embeddedSubPng 计算，与本函数自洽。 */
  function subEmbeddedPngFor(brush, textureBytes) {
    let base = brush.embeddedSubPng || bruEmbeddedSubPng(brush);
    if (base && base.length && brush._bruSubTipRaw && brush._bruSubTipRaw.length && !brush._bruSubBuiltinTipRef) {
      base = new Uint8Array(brush._bruSubTipRaw);
    }
    const wantId = brush._bruSubTexId ? String(brush._bruSubTexId).toUpperCase() : '';
    if (!wantId || !textureBytes || !textureBytes.length) return base;
    const needSubGrain = Number(brush._bruSubEmbeddedCount) >= 2 || !!brush._bruSubHasGrainPng;
    if (!needSubGrain) return base;
    if (util.md5(textureBytes).toUpperCase() !== wantId) return base;
    const tips = brush.embeddedTips || [];
    if (tips.length >= 2 || (tips.length === 1 && tips[0] && tips[0].isSubGrain)) return base;
    if (!base || !base.length) return new Uint8Array(textureBytes);
    const out = new Uint8Array(base.length + textureBytes.length);
    out.set(base, 0);
    out.set(textureBytes, base.length);
    return out;
  }

  /* 【第351/366轮】角度归一化归口至 core/ir.js（[0,360] 原样保留，含 360；越界值折入 [0,360)）。 */
  function normAngle360(v) {
    const res = ir.normalizeAngle(Number(v));
    return res === undefined ? v : res;
  }

  function makeBru(brush, opts) {
    opts = opts || {};
    const originalBrush = brush;
    brush = angleControlAliases(brush);
    if (brush && !brush._burntOutlineDone && opts.burntOutline !== 'off' && burntOutlineCandidate(brush, opts) &&
        (opts.burntOutline !== 'both' || brush._burntOutlineCopy === true)) {
      brush = applyBurntOutline(brush, opts);
    }
    /* 非 BRU 源才放大：BRU 原生往返要逐字节一致，动它的笔尖等于破坏透传。 */
    if (brush && brush.source !== 'bru' && opts.fidelity !== false) brush = expandTinyBinaryTip(brush, opts);
    /* 【第236轮·清理】这里原本写着第227轮的「全字段快照还原」方案——那段代码当年实测红 21 项，
       已回滚删除，注释却留了下来，容易让人以为存在「一次兜住所有字段」的路。
       现在的保真策略是两条腿：① 逐字段 Extra（brushConvBruExtra / brushConvBruTex / brushConvBruPressure）；
       ② 白名单外的未知字段原样透传（bru.js 的 BRU_KNOWN_FIELDS + _rawUnknown）。 */
    /* 【第224轮】带 _nativeDualFromBru 标记的 brushset（本工具从画世界原生双笔导出的）

       转回 bru 时还原内嵌副笔，而不是把副笔烘进主笔。第181轮那条「非 BRU 源禁止内嵌」

       是为了避开原生 Procreate 副笔的重影（真机实测），原生档案没有这个标记，行为不变。 */

    if (brush && brush.dualTip && (opts.embedSubTip || brush._nativeDualFromBru)) {
      /* 【第276轮】BRU 源的双笔刷**不要**走内嵌重建：它自己的 f121 链接已经是画世界原生的
         「主笔→副笔条目」结构，重建会把链接换成新 UUID，整包回读后 13 支里只剩 1 支还挂着双笔
         （R275-02 的实测：`makeBruPack(楠.bru 全量, {embedSubTip:true})` → dualOn 13→1；
         而 `embedSubTip:false` 走原路径 → 13→13）。非 BRU 源没有原生链接，才需要内嵌。 */
      /* 只跳过「**启用中 + 带原生链接 + 链接目标确实在这个包里**」的情况；
         `f119=0`（画世界关了双笔但缓存副图）、`forceEmbedSubTip`、单支导出（目标不在包里）
         都必须继续内嵌，否则副笔图会丢（bru_embedded_test / bru_embedded_ui_test 锁着）。 */
      if (brush.source === 'bru' && brush.bruDualRefUuid && brush.bruDualEnabled !== false &&
          !opts.forceEmbedSubTip && opts._linkTargetPresent === true) {
        return makeBru(brush, Object.assign({}, opts, { embedSubTip: false }));
      }
      return makeBruEmbedded(brush, Object.assign({}, opts, { forceEmbedSubTip: brush._nativeDualFromBru ? true : opts.forceEmbedSubTip }));

    }
    /* 同格式直抄：源就是 .bru、目标也是 .bru，且尺寸/间距/压感/烘焙等选项都没动过
       —— 原样返回源字节。画世界内置笔刷常常没有内嵌位图（450B 那类），任何重新
       生成都会换掉笔尖图案；透传是唯一能保证「导入后和原来一模一样」的路径。 */
    /* _noFilePassthrough：makeBruPack 合多支时用。整文件透传的结果是一个完整的单支 .bru，
       没有 meta/PNG，不能当包内条目（AUDIT-20261111-06）；合包时改走重建，仍保留 _rawMeta 字段级原样。 */
    if (brush._rawBru && brush._rawBru.length && !opts._noFilePassthrough && rawBrushUnchanged(brush, opts)) {
      return { bytes: new Uint8Array(brush._rawBru), pngBytes: null, meta: null,
        tipW: 0, tipH: 0, passthrough: true };
    }
    let tipImg = tipToRGBA(brush);
    const synthesizedTip = !tipImg;
    // 【第356轮】Procreate 内置 Brush-Preset-Flat-Ink 缺失时若回退为斜椭圆会丢失扁平直方笔头（如 #25 锡｜亮色叠加）；
    // 主笔无 Shape.png 且自身或未拆双笔的 Sub01 引用 Flat-Ink 时合成水平扁平笔头，避免 554px 斜灰块失真。
    const subFlatInk = !!(synthesizedTip && brush.source === 'procreate' && !brush._bruExtra &&
      brush.dualSubBrush && /flat[-_ ]?ink/i.test(String(brush.dualSubBrush.bundledShapePath || '')) &&
      !dualNeedsPair(brush, opts));
    const selfFlatInk = !!(synthesizedTip && brush.source === 'procreate' && !brush._bruExtra &&
      /flat[-_ ]?ink/i.test(String(brush.bundledShapePath || '')));
    if (!tipImg) {
      if (selfFlatInk || subFlatInk) {
        const n = 256, rgbaF = new Uint8Array(n * n * 4);
        const x0 = Math.floor(n * 0.43), x1 = Math.ceil(n * 0.57);
        const y0 = Math.floor(n * 0.14), y1 = Math.ceil(n * 0.86);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          const ax = x < x0 ? Math.max(0, 1 - (x0 - x) / 6) : (x > x1 ? Math.max(0, 1 - (x - x1) / 6) : 1);
          const ay = y < y0 ? Math.max(0, 1 - (y0 - y) / 14) : (y > y1 ? Math.max(0, 1 - (y - y1) / 14) : 1);
          const br = 0.82 + 0.18 * Math.sin(y * 0.65) * Math.cos(y * 0.23);
          const o = (y * n + x) * 4;
          rgbaF[o] = 255; rgbaF[o + 1] = 255; rgbaF[o + 2] = 255; rgbaF[o + 3] = Math.round(255 * ax * ay * br);
        }
        tipImg = { w: n, h: n, rgba: rgbaF };
      } else {
        // 【第362轮】Procreate 角度与圆度已原生写入 BRU f20/f22（同下方 L2015 位图规则），
        // 缺失 Shape.png 合成圆头时不再重复把 angle/roundness 烘进像素，避免画世界二次压扁与二次旋转。
        const synthSrc = brush.source === 'procreate' ? Object.assign({}, brush, { angle: 0, roundness: 100 }) : brush;
        tipImg = synthTip(synthSrc, 256, opts);
      }
    }
    const bakingDual = !subFlatInk && !brush.bruDualRefUuid && opts.dualBake !== false && brush.dualOn && brush.dualTip && (brush.dualTip.rgba || brush.dualTip.data) && opts.noDualBake !== true;
    if (bakingDual) {
      /* 【第219轮】副笔烘焙的保护阀。
         画世界的副笔是「另一笔画一遍」（位置/尺寸独立），Procreate 的副笔是「与主笔混合」，
         烘焙只能按 alpha 相乘去近似。对「主笔本身很稀」的笔尖（亮片/闪光粉粒），相乘等于把
         主笔再乘一次不到 0.3 的副笔覆盖 —— 实测楠.bru：
           · #35「13亮片」主笔 cov33.49 → 烘后 1.47（掉 96%）
           · #57「35亮片」主笔 cov7.60 → 烘后 5.67、alpha 均值 3.15 → 0.89（掉 72%）
         这类结果已不是「近似」，而是把笔尖吃掉。既然非 BRU 源无论如何都不会把副笔写成
         画世界原生双笔（第181轮：会「重影」），烘焙掉一半以上墨量时直接不烘更接近原笔。
         阈值 0.5 依据：楠.bru 11 支带副笔的笔刷里，掉墨少的 4 支（#50 等）只掉 18%，
         其余全部掉 51%~96%，中间没有样本，落点不敏感。 */
      const baked = bakeDualTip(tipImg, brush);
      const before = tipAlphaStats(tipImg), after = tipAlphaStats(baked);
      /* 只在「笔尖有结构」时启用：均匀笔尖（整块实心/纯 alpha）相乘等于整体调不透明度，
         那是第237轮锁定的正常合成，不能拦。 */
      const structured = before.sd > 0.01;
      if (baked === tipImg || opts.dualBakeGuard === false || !structured || after.mean >= before.mean * 0.5) tipImg = baked;
    }
    // 圆度/角度只在 bakeTipTransform 里应用一次（之前 abr 源会被压两次 → 笔刷变得又细又扁）
    if (brush.source !== 'bru' && !synthesizedTip) {
      // Procreate angle/roundness are written to native BRU f20/f22. Preserve
      // the shape canvas: also baking/cropping them deforms the same tip twice.
      const transform = brush.source === 'procreate' ? Object.assign({},brush,{angle:0,roundness:100}) : brush;
      tipImg = bakeTipTransform(tipImg, transform);
    }
    const maxTip = Math.max(16, Math.min(2048, opts.maxTipSize || 2048));
    let w = tipImg.w, h = tipImg.h, rgba = tipImg.rgba;
    const maxSide = Math.max(w, h);
    if (maxSide > maxTip) {
      const scale = maxTip / maxSide;
      const nw = Math.max(1, Math.round(w * scale));
      const nh = Math.max(1, Math.round(h * scale));
      rgba = png.resize(rgba, w, h, nw, nh);
      w = nw; h = nh;
    }
    // Use a separate native texture block for regular dots; unmatched textures
    // still fall back to baking. Never enable an empty independent layer.
    /* 【第206轮 R204-02（作者：Claude）】源纹理与画世界内置纹理逐像素相同 → 写 f6=ptN 独立纹理，不烘进笔尖。
       背景：网点类纹理烘进笔尖后每次落印网格跟着笔尖走，8% 间距连续落印把空隙填平（GIMP 长线中段 0% 亮格、
       MuMu 画世界长线 59,150 像素全实心，见第204轮）。官方原版是「无笔尖图 + pt65」，网格固定在画布上。
       bruTexMatch：'auto'（默认）= 精确匹配且是普通硬边圆，或高置信度的规则软网点。
       普通硬边圆单支用原生无图布局；多支保留笔尖 PNG 并独立引用纹理。第207轮实绘确认，
       带笔尖 PNG 的 B5 修正 f35 编码后可以出墨。'always' 允许非圆笔尖使用精确命中的纹理；
       'off' = 旧行为（烘焙）。用户显式选了 bruTexAsset（pt24 等）时让位给用户选项。
       只用预计算指纹表反查（hsj-textures-lib.matchKnown），不解码整库、不要求先下载纹理库。 */
    const match = bruIndependentTexture(brush, opts);
    const customTexture = bruTextureBytes(brush, match);
    const disc = match && !match.custom && !bakingDual && isPlainHardDisc(rgba, w, h);
    const texMatchId = match && (match.custom ? (customTexture && util.md5(customTexture).toUpperCase())
      : ((brush._nativeTexFromBru || opts.bruTexMatch === 'always' || disc) && match.id));
    const texMatchNoShape = !!(texMatchId && disc && !opts._packMember);
    // The brushset shape is a stand-in for these BRU nibs. If it was edited
    // or the original texture must be baked, keep the resulting bitmap.
    const nativeProcedural = brush.source === 'bru' && !brush.tip;
    const bridgeExtra = brush._bruExtra;
    const fallbackHash = bridgeExtra && (bridgeExtra.fallbackShapeHash || bridgeExtra.procShapeHash);
    const bridgeTipUnchanged = bridgeExtra && opts.fidelity !== false && !opts.forceRebuild &&
      !brush.flipX && !brush.flipY && !brush.shapeInverted && (!brush.hasTexture || !!texMatchId) &&
      brush._rawTipState === util.brushFingerprint({tip: brush.tip}) &&
      (!fallbackHash || (brush._rawShape && util.md5(brush._rawShape) === fallbackHash));
    const keepNoShape = !!(brush.bruProceduralTip && !bakingDual && (nativeProcedural || bridgeTipUnchanged));
    const builtinRef = builtinTipKey(brush);
    const bridgeBuiltin = !!(builtinRef && bridgeExtra && (bridgeExtra.builtinTipRef === builtinRef || brush._tipFromBuiltin === brush.oldTexId));
    const keepBuiltinTip = !!(!bakingDual && ((bridgeBuiltin && bridgeTipUnchanged) || brush._bruForceBuiltinTipRef));
    // Archive tone values are signed offsets. A brushset exported from BRU
    // can carry absolute BRU values in the same normalized fields.
    const grainTone = brush.source === 'procreate' && brush._params && !brush._bruTexParams && !brush._nativeTexFromBru
      ? { brightness: Math.max(-100, Math.min(100, Number(brush.textureBrightness) || 0)),
          contrast: Math.max(-100, Math.min(100, Number(brush.textureContrast) || 0)) }
      : null;
    let textureBaked = false;
    let unbakedTip;
    // A promoted sub-brush grain occupies the texture slot. The primary's
    // moving grain still contributes to coverage within each stamp.
    if (brush.source !== 'bru' && brush.hasTexture && opts.noTextureBake !== true && (!texMatchId || match.fromSubGrain)) {
      const texture = textureGray(brush);
      if (texture) {
        if (brush.source === 'procreate' && procreateGrainPng(brush._rawGrain)) unbakedTip = { w, h, rgba };
        rgba = new Uint8Array(rgba);
        bakeTextureIntoRGBA(rgba, w, h, {
          _patternPixels: { w: texture.w, h: texture.h, mode: 1, data: texture.gray },
          /* 以前这里只传像素， textureScale / grainDepthMinimum / textureRotation 全部丢失，
             导致「纹理缩放」在 BRU 路径上根本不生效（对着色世界就是这个路径）。 */
          textureScale: brush.textureScale,
          grainDepthMinimum: brush.grainDepthMinimum,
          textureRotation: brush.textureRotation,
          textureRotationIsRadians: !!grainTone
        }, brush.textureDepth === undefined ? 0.35 : brush.textureDepth, grainTone,
          /* 【第400轮】只有 Procreate 源且纹理烘进笔尖时才限制烘焙强度；ABR 路径（L3599）不传，行为不变。 */
          hsjModel.bakeAlphaFloor(brush));
        textureBaked = true;
        /* 【第400轮】把阻尼信息挂到笔刷上，供测试与损失报告引用（不改任何输出字段）。
           rawRatio = 阻尼前的原始保留率；damp = 衰减被等比减弱的比例；ratio = 最终保留率。 */
        if (rgba.__bakeDampScale !== undefined && rgba.__bakeDampScale !== 1) {
          brush._bakeDamped = { rawRatio: rgba.__bakeRawRatio, damp: rgba.__bakeDampScale, ratio: rgba.__bakeAlphaRatio };
        }
      }
    }
    // Keep native BRU RGB and its inversion flag together. Cross-format masks
    // already encode coverage in alpha: do not force shape inversion to repair
    // an unrelated missing texture. Native f29 and f32 are separate controls.
    // 画世界内置纹理（f6 资源 id + f28 开关）：默认关（App 版本不同，材质 id 可能缺失 →
    // 开了未知 id 的纹理笔迹几乎不出墨）。打开后 App 按文档空间采样材质，与烘进笔尖的预粒叠加。
    const texAssetReq = opts.bruTexAsset === undefined || opts.bruTexAsset === null || opts.bruTexAsset === '' ? 'off' : String(opts.bruTexAsset);
    const texAssetId = (brush.source !== 'bru' && texAssetReq !== 'off' && textureBaked)
      ? (texAssetReq === 'auto' ? 'pt24' : texAssetReq) : null;
    // 画世界 UI 的「纹理深度」= 1 - f123（真机原生导出 f123=0.21 时 UI 显示 79%），
    // 把源预粒深度映射到 UI 70%~90%（源 0 → 70%，源 1 → 90%）再取反写回。
    // 真机实测：UI 64% → hf 6.08，UI 79% → hf 7.05（同支笔刷无纹理时只有 2.69）。
    const texUiDepth = texAssetId
      ? Math.max(0, Math.min(0.9, 0.70 + 0.25 * Math.max(0, Math.min(1, brush.textureDepth === undefined ? 0.35 : brush.textureDepth)))) : null;
    const outTextureDepth = texAssetId ? (1 - texUiDepth) : brush.textureDepth;
    // 没有纹理层（非原生 BRU、也没有内置材质 id）时不要写 f123：
    // 画世界会把它当成「有纹理深度」而套默认材质，笔迹会比原笔刷花。
    let effectiveTextureDepth = (texAssetId || brush.source === 'bru') ? outTextureDepth : undefined;
    /* 【第366轮 Phase 2】纹理深度计算与 f123=1-uiDepth 换算归口至 core/model-hsjpro.js + core/ir.js。 */
    if (texMatchId) {
      const uiDepth = hsjModel.computeGrainUiDepth(brush, match);
      effectiveTextureDepth = hsjModel.depthToF123(uiDepth);
    }
    const nativeGrainJitter = brush.source === 'bru' ||
      (brush._bruTexParams && Number.isFinite(brush._bruTexParams.depthJitter));
    const mappedGrainTone = (texMatchId || texAssetId) && grainTone;
    // Undo the dark encoding of older bridge shapes. New bridge masks already
    // use positive coverage, and white RGB with that alpha preserves it.
    let encodeRgba = rgba;
    if (brush.source !== 'bru' && brush._bruExtra && brush.bruShapeRgbOpacity === true &&
        !brush._bruExtra.rgbOpacityLightShape && brush._bruRgbOpacityDark !== false) {
      encodeRgba = new Uint8Array(rgba.length);
      for (let i = 0; i < rgba.length; i += 4) {
        const a = rgba[i + 3];
        const v = a === 0 ? 0 : 255 - a;          // 形状外写黑（源就是这么存的），其余反相 → 图案进 RGB 暗部
        encodeRgba[i] = v; encodeRgba[i + 1] = v; encodeRgba[i + 2] = v;
        encodeRgba[i + 3] = a === 0 ? 0 : 255;    // alpha 只保留形状
      }
    } else if (brush.source !== 'bru' && !brush._keepTipRgb) {
      /* _keepTipRgb：第290轮焦边描边的深色副笔，靠笔尖自身 RGB（f38「颜色」）画出深框，不能规整成白 */
      encodeRgba = png.toMaskRgba(rgba);
    }
    const canRestoreTipRaw = !bakingDual && !textureBaked && (opts.sizeScale || 1) === 1 && (
      (brush._bruTipRaw && brush._bruTipRaw.length && bridgeTipUnchanged &&
        (!brush._bruTipShapeHash || (brush._rawShape && util.md5(brush._rawShape) === brush._bruTipShapeHash))) ||
      (brush._rawTipPng && brush._rawTipPng.length && brush._bruForceRawTipPng)
    );
    let pngBytes = canRestoreTipRaw
      ? new Uint8Array(brush._bruTipRaw || brush._rawTipPng)
      : png.encode(w, h, encodeRgba);
        /* 【第340轮（作者：Lead）】`keepNoShape`（程序化笔尖、无 Shape.png）以前会连 Procreate 的
       grain chunk 一起跳过 —— 缪斯之梦主笔正是这种（无 Shape、有 Grain.png），于是
       brushset → BRU → brushset 回来「颗粒来源」空白。App 侧仍然按 noShape 用内置笔尖、
       忽略这张 PNG，但 chunk 留在 PNG 上，我们自己的 parseBru 能读回来。 */
    /* 【第340轮（作者：Lead）】`opts.procreateGrainBridge === false` 关闭 chunk 写出。
       chunk 里是源 Grain.png 的原样副本，是 brushset → BRU → brushset 唯一能原图回写的途径，
       但对「只想在画世界Pro 里用」的人是纯冗余：缪斯之梦 34 支转出 84MB，带上后 158MB。
       默认仍然写（保住往返能力），要精简产物时显式关掉。 */
    if ((!keepNoShape || procreateGrainPng(brush._rawGrain) || procreateLibraryGrain(brush.bundledGrainPath)) &&
        !texMatchNoShape && opts.fidelity !== false &&
        !opts.noTextureBake && opts.procreateGrainBridge !== false) {
      const carried = brush.source === 'bru' && !canRestoreTipRaw && unchangedProcreateGrain(brush);
      const chunk = carried ? carried.chunk : writeProcreateGrainChunk(brush, unbakedTip, originalBrush, effectiveTextureDepth, customTexture, {
        scale: match && match.custom && !brush._nativeTexFromBru ? match.scale : brush.textureScale,
        brightness: hsjModel.compensateTextureBrightness(brush, match, mappedGrainTone, hasAbsent(brush, 35)),
        contrast: hsjModel.compensateTextureContrast(brush, match, mappedGrainTone, hasAbsent(brush, 33)),
        inverted: !!(match && match.noInvert ? false : brush.textureInverted),
        perTip: match && match.custom && brush.bruTexturePerTip === undefined ? false : !!brush.bruTexturePerTip,
        blend: Number(brush.bruTextureBlendMode || 0)
      }, !!(texAssetId || texMatchId));
      if (chunk) pngBytes = addProcreateGrainChunk(pngBytes, chunk);
    }
    /* 【第348轮（作者：Lead）】标记 chunk 独立于 `procreateGrainBridge`：那个开关管的是 74MB 的 grain
       原图备份，这个只背「源无 Shape」这个事实（几十字节），所以永远尝试写。
       `canRestoreTipRaw` 时 pngBytes 已经是源字节（本身带标记），不重复插。 */
    if (opts.fidelity !== false && !canRestoreTipRaw && !(brush.source === 'procreate' && (brush.shapeFromLibrary || brush.grainFromLibrary) && opts.procreateGrainBridge !== false)) {
      const markChunk = brush.source === 'bru'
        ? (brush._noShapeMark ? buildMarkChunk(brush._noShapeMark.noShape, brush._noShapeMark.bundledShapePath, brush._noShapeMark.library) : null)
        : writeProcreateMarkChunk(brush);
      if (markChunk) pngBytes = addProcreateGrainChunk(pngBytes, markChunk);
    }
    const sizeScale = opts.sizeScale || 1;
    let sizePx = (brush.sizePx || 100) * sizeScale;
    if (!isFinite(sizePx) || sizePx <= 0) sizePx = Math.max(4, Math.max(w, h));
    /* 【第229轮】不再把尺寸 round 到 2 位：源 BRU 的 f8 是 float32（70.12000274658203），
       round 之后往返变成 70，59 支笔刷各偏 0.005~0.12px。f32 原样存得住，交给编码器取整。 */
    /* 【第251轮】上限从 3000 提到 5000：珠宝装饰套里有 4003 / 3952 / 3648 px 的大笔刷，
       3000 的上限把它们直接截断（写侧 f8 是 float32，本来就存得下）。与 buildMetadata 的 5000 对齐。 */
    sizePx = Math.max(1, Math.min(BRU_MAX_SIZE_PX, sizePx));
    const maxSizePx = Math.max(sizePx, brush.source === 'procreate' && brush.maxSizePx > 0
      ? Math.min(BRU_MAX_SIZE_PX, brush.maxSizePx * sizeScale)
      : brush.maxSizePx || brush._rawMaxWidth || 500);
    // BRU 同时记录像素尺寸与归一化刻度。保留未编辑的原生刻度，编辑后让写侧按新尺寸计算。
    const nativeSize = brush.source === 'bru' ? brush._rawState : bridgeExtra;
    const keepMaxRatio = sizeScale === 1 && (!nativeSize || !Number.isFinite(nativeSize.maxSizePx) ||
      maxSizePx === nativeSize.maxSizePx);
    const keepSizeRatio = keepMaxRatio && (!nativeSize || sizePx === nativeSize.sizePx);
    let spacingPct = opts.spacingOverride > 0 ? opts.spacingOverride : brush.spacingPct;
    /* 【第186轮】Procreate 的 spacing 最小可调值是 1%，存成 0 表示「自动间距」而不是
       「无限密」。以前一律钳到 BRU 下限 0.1%，画世界按 dab 逐个盖印，256px 笔尖
       每 0.25px 落一次，网格/网点/描边这类低 alpha 笔尖的间隙被相邻 dab 填满，
       整支笔刷糊成一坨（用户实测两张截图：先黑带、后被我错误归一再变淡块）。
       现在 0（或负值/非数）按 10% 自动间距处理；明确的小值仍保 0.1 下限。 */
    if (!(spacingPct > 0)) spacingPct = BRU_AUTO_SPACING_PCT;
    spacingPct = Math.max(BRU_MIN_SPACING_PCT, Math.min(1000, spacingPct));
    const usePressure = opts.pressure === undefined ? (pressureSizeOn(brush) || !!brush.pressureOpacity) : !!opts.pressure;
    const bruPressure = brush.source === 'procreate' && opts.pressure === undefined ? brush._bruPressure : null;
    const useOriginalMinOpacity = bruPressure && brush._rawNormalized &&
      brush.minOpacityRatio === brush._rawNormalized.minOpacityRatio;
    // 笔迹浓度归一（画世界）：真机标定发现画世界按每个笔尖累加 alpha——间距 4.2% 时同一位置叠约 24 次，
    // α=0.18 的笔尖最终覆盖 1-(0.82)^24≈99%，必然画成纯黑（实测亮度 26.8、颇粒 hf 2.68），
    // 而 Procreate 原样张是中灰的半透明颇粒（目标覆盖 ~0.6）。
    // 实测同一支笔刷：不透明度 22% → 亮度 144.1、hf 9.01、颇孔 4.2%。
    // 所以这里按「目标覆盖度」反算每个笔尖应有的 alpha，再折成不透明度。
    /* 【第185轮撤回】曾在这里对 spacingPct<2 的笔刷强制开启浓度归一，
       结果 opacity 被反算到 0.05，网点/描边/双色笔刷整支变成半透明淡块
       （用户实测截图：像喷枪糊了一片）。归一的前提是「笔尖实心、叠加变黑」，
       而这些笔刷的笔尖本来就是低 alpha 的网纹/描边，归一等于把它抹平。
       恢复为只按用户选项决定。 */
    const densityMode = opts.bruDensity === 'auto' ? 'auto' : 'off';
    let densityOpacity = null, densityInfo = null;
    if (brush.source !== 'bru' && densityMode !== 'off') {
      const target = Math.max(0.2, Math.min(1, Number(opts.bruDensityTarget) || 0.6));
      const dabs = Math.max(1, Math.min(2000, 60 / spacingPct)); // 标定系数：实测有效叠加次数≈60/间距%（100/间距%偏高 1.7 倍）
      let alphaMean = 0;
      for (let i = 3; i < rgba.length; i += 4) alphaMean += rgba[i];
      alphaMean = alphaMean / (rgba.length / 4) / 255;
      const wanted = target >= 0.999 ? 1 : (1 - Math.pow(target, 1 / dabs));
      const baseOpacity = brush.opacity === undefined ? 1 : brush.opacity;
      if (dabs >= 3 && alphaMean > 0.004 && wanted < alphaMean) {
        const norm = Math.max(0.05, Math.min(1, wanted / alphaMean));
        if (norm < 0.98) {
          // 只能压不能抬：源不透明度为 0（显式零）时必须保持 0，不能凭空抬到地板值
          densityOpacity = baseOpacity <= 0.001 ? baseOpacity : Math.max(0.02, Math.min(baseOpacity, baseOpacity * norm));
          densityInfo = { dabs: Math.round(dabs), tipAlpha: Math.round(alphaMean * 1000) / 1000, target: target, opacity: Math.round(densityOpacity * 100) / 100 };
        }
      }
    }
    const rawUnchanged = !brush._rawState || Object.keys(brush._rawState).every(function (key) { return brush[key] === brush._rawState[key]; });
    // 单色白底的描边走 applyBurntOutline。已标定的原生双色对沿用画世界变暗、亮度和强度 100% 的默认值。
    const automaticBorder = opts._linkTargetPresent && nativeDualBorderCandidate(brush, opts) &&
      (opts.burntOutline !== 'both' || brush._burntOutlineCopy);
    const bruBorder = { on: !!(brush.borderOn || automaticBorder), blend: brush.borderBlend, brightness: brush.borderBrightness, strength: brush.borderStrength };
    const color = bruProcreateColor(brush);
    /* 画世界的「颜色压力」和「颜色动态」各有一个辅助颜色滑块。
       原生 Procreate 压力副色交给 bruColorPressure，倾斜和滚轮仍近似为随机副色。
       【第341轮（作者：Lead）】两边刻度不一样，这里必须折算：
       · Procreate 5.4.15 的「描边辅助颜色」是 power-2.2 刻度 —— archive 0.5 界面显示 73%、
         `jitterStrokeSecondary=0.0703` 显示 30%（本项目 iPad 实测）；
       · 画世界的 f109 是线性百分比 —— MatePad 实测 BRU 存 0.2277 显示 23%、0.0703 显示 7%。
       不折算的话缪斯之梦忍冬在 Procreate 是 30%、转到画世界只剩 7%，副色淡到几乎看不出
       （字段写了、强度不到原生四分之一，用户仍会认为「双色丢了」）。
       折算后两边读数一致，且 brushset 往返也回到原值（写侧按 `pow(.,2.2)` 折回，见 procreate.js）。
       只折「描边驱动」这一路（`colorPerTip === false`）：它是唯一实测过 power-2.2 的滑块
       （0.5→73%、0.0703→30%）。「图章辅助颜色」`jitterSecondary` 从未标定过非零值
       （实测样本都是 0 → 界面「无」），按未标定处理，不折算。 */
    const dualColorAmount = (function () {
      const a = Number(color ? color.secondaryFallback : brush.secondaryColorAmount), b = Number(brush.colorJitterFgBg);
      const x = isFinite(a) ? Math.max(0, Math.min(1, a)) : 0;
      const y = isFinite(b) ? Math.max(0, Math.min(1, b)) : 0;
      const v = Math.max(x, y);
      return brush.source === 'procreate' && brush.colorPerTip === false ? ir.secondaryToProcreate(v) : v;
    })();
    // A separately stored secondary still draws with the primary.
    // Pair preparation clears dualOn to skip baking.
    const linkedPrimary = brush.source === 'procreate' && !brush.dualOn &&
      brush.bruDualEnabled === true && brush.bruDualRefUuid && brush.bruDualSubBrush;
    const flowBrush = linkedPrimary ? Object.assign({}, brush, { dualOn: true }) : brush;
    let writtenDualMode = brush.bruDualBlendMode;
    const rawMode = brush.source === 'bru' && brush._rawState;
    if (rawMode && writtenDualMode === rawMode.bruDualBlendMode &&
        brush.dualBlendMode !== undefined && brush.dualBlendMode !== rawMode.dualBlendMode) {
      writtenDualMode = bru.dualBlendValue(brush.dualBlendMode, writtenDualMode);
    }
    const meta = {
      name: brush.name || '',
      bruShapeInverted: !!brush.bruShapeInverted,
      /* 【第289轮】方形笔尖 → 画世界「方形笔触」(f41)。原生 BRU 源读出来的值原样保留；
         非 BRU 源只在笔尖确实是「纯二值正方形」时置 true，柔边/异形笔尖一律不动。 */
      bruSquareTip: hsjModel.inferSquareTip(brush, opts, isBinarySquareTip),
      pkgId: brush.pkgId || opts.pkgId,
      /* f7(MASKTEXPATH) = 笔尖图在 App 里的文件名。第179轮用 exportBrushes 的两支
         原生样本验证：App 导出时 oldTexId 逐字节等于内嵌 PNG 的 md5，导入时 App 就
         按这个值在 textures/ 下建文件。据此定规则：
         · 源自己的 mask 名仍然对得上（_tipFromBuiltin === oldTexId，含 psN 占位）
           → 原样保留，别无谓改写用户文件；
         · 笔尖是补回来的内置图 / 重新烘焙过的 → 用内容 md5，保证名字与图一一对应；
         · 绝不能写空：v2.8.53 曾把内置来源的 f7 留空，App 没有文件名可用，
           导入后笔刷空白（这正是「导出还是不行」的原因之一）。 */
      /* 【第231轮】keepNativeId：无笔尖图布局的 f7 保持空串（源「眼睛」f7 就是空），
         其余照旧（笔尖 PNG 内容 md5 / 源内置占位名）。 */
      /* 【第238轮】原条件只认 `source === 'bru'`，可 brushset 往返回来 source 已变 procreate，
         于是永远写重编码 md5、App 认不出内置笔尖名 → 回退实心。放开到「带 _bruExtra 的往返笔刷」。 */
      /* 【第239轮】第238轮那版还要求 `_tipFromBuiltin === oldTexId`，可 `_tipFromBuiltin` 只有
         在「从内置库取到笔尖像素」（restoreHsjTips）时才赋值；本例源 oldTexId 是 32 字符 md5，
         builtinTipKey 判不出内置名 → 恒 undefined → 条件恒假 → 修了等于没修（verify238 实测）。
         现在只要求：来自 BRU 往返 + 源里有 f7，就沿用源名。 */
      /* 【第296轮（作者：Lead）】f7 必须与**实际写出的 PNG 字节**一致：App 就是拿 f7 去
         textures/ 里找图（第179轮实测：原生 oldTexId 逐字节等于内嵌 PNG 的 md5）。以前 BRU 源
         与往返源一律沿用 oldTexId，可写出口每次都会 png.encode() 重新编码，字节和 md5 都变了
         → f7 指向一张不存在的图，App 找不到笔尖/副笔图只能回退，用户看到「转换后还是不行」。
         规则：oldTexId 是 32 位 md5（内容指纹）→ 一律换成新 pngBytes 的 md5；
              oldTexId 不是 md5（App 内置资源占位名，如 psN/ptN）→ 保持原名，App 从自己库取。 */
      texId: keepNoShape ? '' : (function () {
        const oldId = brush.oldTexId || '';
        const keepNative = ((brush.source === 'bru' || !!brush._bruExtra) && oldId && (!bridgeBuiltin || keepBuiltinTip) && opts.fidelity !== false && !opts.forceRebuild) || (!!brush._bruForceBuiltinTipRef && !!oldId);
        /* 判据用**源 meta 里的真 f7**（oldTexId 可能来自别处，第296轮实测 #11/#14 的 oldTexId=ps22
           而原生 f7 其实是 32 位 md5）：源 f7 是 md5 → 一律换成本次写出的 PNG md5；
           源 f7 是内置占位名（psN/ptN）→ 保持原名，App 从自己库里取。 */
        const rawF7 = readMetaField7(brush._rawMeta);
        const src = rawF7 || oldId;
        const srcIsMd5 = /^[0-9a-f]{32}$/i.test(src);
        if (keepNative && !srcIsMd5) return src;
        return util.md5(pngBytes).toUpperCase();
      })(),
      sizePx: subFlatInk && brush.dualSubBrush && brush.dualSubBrush.sizePx > 0
        ? Math.max(1, Math.min(sizePx, Math.round(brush.dualSubBrush.sizePx * 0.86))) : sizePx,
      /* 【第195轮】优先用公开字段 maxSizePx（BRU 解析侧现在会回填 f12），再用私有 _rawMaxWidth 兜底。
         旧写法只认 _rawMaxWidth，导致 maxSizePx=800 的笔刷被压到 500，f12/f135/f136 全部失真。 */
      maxSizePx,
      spacingPct: subFlatInk ? Math.min(spacingPct, 2) : spacingPct,
      opacity: hsjModel.compensateOpacity(brush, densityOpacity !== null ? densityOpacity : (brush.opacity === undefined ? 1 : brush.opacity), match),
      minSizeRatio: usePressure ? (brush.minSizeRatio === undefined ? 0.1 : brush.minSizeRatio) : 1,
      _bruNativeSmallWidth: brush._bruNativeSmallWidthFromSource && sizeScale === 1 ? brush._bruNativeSmallWidth
        : ((keepNoShape || keepBuiltinTip) && bridgeTipUnchanged && opts.pressure === undefined &&
          sizeScale === 1 && brush.sizePx === bridgeExtra.sizePx && brush.minSizeRatio === bridgeExtra.nativeMinSizeRatio
          ? bridgeExtra.nativeSmallWidth : undefined),
      /* 【第297轮】源字段存在性（brushset 往返时由 brushConvBruExtra 带回）：
         写侧据此不再把「源里没有的字段」按默认值补出来。 */
      _bruAbsentFields: (function () {
        const fromSet = bruAbsentFields(brush._bruFieldSet);
        const fromExtra = Array.isArray(brush._bruAbsentFields) ? brush._bruAbsentFields : null;
        if (!fromSet && !fromExtra) return undefined;
        const out = [];
        (fromSet || []).concat(fromExtra || []).forEach(function (f) { if (out.indexOf(f) < 0) out.push(f); });
        return out.length ? out : undefined;
      })(),
      minOpacityRatio: usePressure ? (brush.minOpacityRatio === undefined ? 0.25 : brush.minOpacityRatio) : 1,
      bruSmallAlpha: useOriginalMinOpacity ? bruPressure.minOpacity : undefined,
      pressure: usePressure,
      // 把能写进 .bru 的其它参数一起带上（纹理/散布/抖动/锥度/湿边/混色/颜色动态/圆度硬度/流量）
      pressureSize: opts.pressure === undefined ? pressureSizeOn(brush) : !!opts.pressure,
      pressureOpacity: opts.pressure === false ? false : !!brush.pressureOpacity,
      /* 第194轮：压力页标定字段（f67/f117/f134/f138/f139）。默认值 = 画世界面板默认，
         undefined 时 bru.js 不写这些字段，输出与旧版完全一致。 */
      bruFlowSmooth: brush.bruFlowSmooth,
      bruFingerPressurePct: brush.bruFingerPressurePct,
      /* 【第356轮实机实证】画世界 f134（淡入淡出）不写时默认开启，会在无压感/手指划笔的起笔收笔强行把压感降到 0，
         导致带 f114 压力副色的 Procreate 双色笔（#05/#06/#15/#16/#19/#20/#23/#33/#34）两端长出多余黑色尖端/黑团；
         原生 Procreate 无锥度(!taperOn)时显式置 false（写 f134=1 关闭淡入淡出），不损真压感通道 f114。 */
      bruFadeInOut: hsjModel.defaultFadeInOut(brush),
      bruPressureSizeInfluence: brush.bruPressureSizeInfluence,
      bruPressureFlowInfluence: brush.bruPressureFlowInfluence,
      /* 【第399轮（作者：Lead）】接上第388轮烘焙流量守恒补偿：把烘焙后 alpha 保留率交给模型层，
         它据此在稀疏点距区间上调 flowPct，抵消 grainBake 的乘性压淡。
         hasTexLayer=true 表示纹理走了独立层、没烘进笔尖，不该补偿。 */
      flowPct: hsjModel.compensateFlowPct(flowBrush, spacingPct, sizePx, textureBaked, bruPressure,
        textureBaked ? { bakeAlphaRatio: rgba && rgba.__bakeAlphaRatio, hasTexLayer: !!texMatchId } : undefined),
      minFlowRatio: brush.minFlowRatio === undefined && bruPressure ? bruPressure.minFlow : brush.minFlowRatio,
      /* 【第350轮】回读 brushset 时 `flowPct` 现在总是给出来（取自 BRU 往返标记里的精确值），
         所以不能再拿「flowPct 未定义」当「用户没改过流量」的依据，否则 `bruSmallFlow`（f51 的
         小流量）在这条链路上一律丢。改成值比对：与标记一致（1e-6 内）就照旧还原。 */
      bruSmallFlow: bruPressure && brush.minFlowRatio === undefined &&
        (brush.flowPct === undefined || Math.abs(brush.flowPct - bruPressure.flow) <= 1e-6)
        ? bruPressure.smallFlow : undefined,
      bruLegacyMinWidth: opts.pressure === undefined && pressureSizeOn(brush) &&
        (brush.source === 'bru' ? brush.bruLegacyMinWidth : !!(bruPressure && bruPressure.legacyMinWidth)),
      roundness: brush.roundness,
      hardness: texMatchNoShape ? 1 : (brush.hardness === undefined ? hardnessFromAlpha(rgba, w, h) : brush.hardness),
      smoothingStrength: brush.smoothingStrength,
      /* 【第351轮】画世界「旋转」滑杆区间是 0–360，**收到负值一律按 0 处理**（第351轮真机实测：
         -35.37° / -269.44° / -1.17° 界面全显示 0°，旋转彻底丢失）。而 Procreate 的 shapeAngle
         本来就可以落在 [0,360) 之外——`🌗序章｜上色柔` 是 -35.37°（≡324.63°）、`✨晶冻` 的 Sub01
         是 -269.44°（≡90.56°）。原样写出等于把旋转写成 0。
         非 BRU 源统一归一化到 [0,360)；BRU 源原样保留（同格式 patch/透传不改用户文件）。
         已经在 [0,360] 内的值也原样保留——原生 BRU 里有 `angle = 360` 的笔刷（轻舟`毛流笔`），
         折成 0 会让往返基线多出一条假差异。 */
      angle: subFlatInk ? 0 : ((brush.source === 'bru' || !(brush.angle < 0 || brush.angle > 360)) ? brush.angle : normAngle360(brush.angle)),
      // ABR jitter is percent of a full circle; BRU stores the +/- degree range.
      angleJitterDeg: brush.source === 'abr' && brush.angleJitterDeg !== undefined ? Math.max(0, Math.min(180, brush.angleJitterDeg * 1.8)) : (brush.source === 'procreate' ? Math.max(0, Math.min(180, brush.angleJitterDeg || 0)) : brush.angleJitterDeg),
      // Native UI calibration: 0 off, 1 direction, 2 initial, 3 pressure, 4 stylus side rotation.
      // Procreate/Krita/MyPaint 等来源没有「跟随笔迹方向」这个控制：之前留 undefined 会落到写入端默认值 1
      // （笔迹方向），把角度随机（Procreate 的 Shape Scatter）在视觉上吞掉——同一支包浆从 .abr 进来是
      // mode 0、从 .brushset 进来却是 1。无显式值时一律 0（关）。
      bruRotationMode: brush.bruRotationMode !== undefined ? brush.bruRotationMode : (brush.source === 'abr' ? ({0:0,2:3,5:2,6:1}[brush.dynamicsControlAngle || 0] || 0) : 0),
      sizeJitterPct: brush.sizeJitterPct,
      spacingJitterPct: brush.spacingJitterPct,
      flowJitterPct: brush.flowJitterPct,
      countJitterPct: brush.countJitterPct,
      scatterOn: subFlatInk ? false : brush.scatterOn,
      // 【第366轮 Phase 2】散布跨引擎补偿归口至 core/model-hsjpro.js（14 支实测：Procreate→画世界Pro = 1/√cnt，ABR 沿用 0.15）。
      scatterPct: hsjModel.compensateScatterPct(brush, opts, subFlatInk),
      scatterBothAxes: brush.scatterBothAxes,
      scatterCount: brush.scatterCount,
      // App 内置纹理库资源 id（f6）：只在目标不是原生 BRU 且调用方/源笔刷指定了 id 时才写。
      // 原生 BRU 进来的笔刷原样保留自己已有的 id（raw 元数据路径会保持）。
      /* 【第231轮】keepNativeId：f6 沿用源 UUID（画世界私有材质 id，App 端纹理按此 id 存取；
         像素走 bruTextureBytes 的源原始字节，md5 与 UUID 自洽），不再被重编码 md5 改写。
         非 keep 路径：仅在「有纹理、未烘焙、ptN 引用或像素可附带」时透传源 texAssetId——
         烘焙输出再写 f6 会让 App 叠加/引用一份不该存在的纹理；无像素的 UUID 是空引用（224 轮不出墨）。 */
      texAssetId: (match && match.keepNativeId && brush.texAssetId) ? brush.texAssetId
        : (texMatchId || texAssetId
           /* 【第297轮】副笔（f121 子记录）显式带回的源 f6：副笔 hasTexture 恒 false，
              下面那条 hasTexture 闸门永远过不去，所以这条必须排在它前面。 */
           || (brush._bruForcedTexId && brush.texAssetId ? String(brush.texAssetId) : undefined)
           || (brush.source === 'bru' && brush.texAssetId)   // BRU 同格式重建：沿袭源 f6（227 轮口径；ptN 无像素、路径型悬空引用均照旧）
           || (((brush.hasTexture && !textureBaked && !opts.noTextureBake) && brush.texAssetId && (/^pt/i.test(String(brush.texAssetId)) || customTexture)) ? brush.texAssetId : undefined)
           || (opts && opts.texAssetId)),
      /* 【第227轮】f84 纹理混合模式：以前 meta 里根本没有这个键，bru.js 写侧收不到，
         往返后一律变 0（203 支 BRU 源里 45 支失真）。 */
      bruTextureBlendMode: brush.bruTextureBlendMode,
      bruTextureBytes: customTexture,
      hasTexture: brush.source === 'bru' ? brush.hasTexture : !!(texAssetId || texMatchId),
      // Fixed texture keeps the same dot grid through successive dabs. Native
      // A/B strokes of the original Huangtu bitmap reproduce the difference.
      /* 【第231轮】f99（bruTexturePerTip 的反相存储位）按源值写：源有值跟源，
         源没有（非 BRU 语义的 custom 纹理）才按既有推断置 false。 */
      bruTexturePerTip: match && match.custom && brush.bruTexturePerTip === undefined ? false : brush.bruTexturePerTip,
      // 第206轮：内置纹理精确命中时照抄原生结构（见上方 texMatch 注释）；未命中时这三项都是 undefined/false，输出不变
      noShape: (keepNoShape || texMatchNoShape) || undefined,
      bruBuiltinTipRef: keepBuiltinTip,
      _bruProceduralOmissions: bridgeTipUnchanged ? bridgeExtra.procOmissions : undefined,
      /* 第293轮：不规则颗粒纹理层不套第206轮网点那套「黑色 + f42」（真机测的是 f16=-1、f42 关） */
      bruColor: brush.bruColor !== undefined ? brush.bruColor : (texMatchId && !(match && match.grainLayer) ? -16777216 : undefined),

      bruShapeRgbOpacity: brush.bruShapeRgbOpacity !== undefined ? brush.bruShapeRgbOpacity : (texMatchId && !(match && match.grainLayer) ? true : undefined),
      textureInverted: match && match.noInvert ? false : brush.textureInverted,
      /* 【第224轮】往返场景用源里存下的 textureScale，不再按「笔刷尺寸/纹理宽」重算，

         否则 11px 的小笔刷把 512 纹理缩到 0.0215，平铺密到肉眼看就是不出墨。 */

      textureScale: match && match.custom && !brush._nativeTexFromBru ? match.scale : brush.textureScale,
      /* 【第224轮】往返场景的 textureBrightness/Contrast 是**绝对值**（源里读出来就是 51/100），

         不能再按「中性值 + 偏移」算一遍 —— 51+51 clamp 成 100、100+100 成 200，纹理会过曝变白，

         实测「还行」就是这样变得看不出墨。 */

      /* 【第366轮 Phase 2】纹理亮度 f35 与对比度 f33 补偿归口至 core/model-hsjpro.js。 */
      textureBrightness: hsjModel.compensateTextureBrightness(brush, match, mappedGrainTone, hasAbsent(brush, 35)),
      textureContrast: hsjModel.compensateTextureContrast(brush, match, mappedGrainTone, hasAbsent(brush, 33)),
      textureDepth: effectiveTextureDepth,
      grainDepthJitter: nativeGrainJitter || (brush.grainDepthJitter > 0 && (texMatchId || texAssetId))
        ? brush.grainDepthJitter : undefined,
      taperOn: brush.taperOn,
      /* 【第279轮】锥度起笔/收笔长度（f75/f76）**不进写侧**：BRU→BRU 由 `_rawUnknown` 原样透传
         已经逐字节保留；改成语义写回会引入两个新问题——① 与 Procreate 的长度单位不同
         （BRU 0~8 vs Procreate 0~1），② 跨格式回来后 Procreate 的默认值 0.2/0.3 会被当成
         「源里有值」写进 BRU（roundtrip_baseline 的 taperStartLengthPresence 180/180 红）。
         所以只读出来用于「跨格式提示」，不参与写出。 */
      /* 【第232轮】源 BRU 显式带 f77/f78 的标记必须传下去：bru.js 的写侧靠它决定
         「锥度开关关着也要把尺寸/透明度写出来」。少了这个键，轻舟「色块平铺」f77=0.36 往返成 1。 */
      _bruTaperFields: brush._bruTaperFields === true,
      /* 【第232轮·field-matrix】字段存在性旗标与原值：写侧「源有字段就写」靠它们
         （f59/f77/f78/f87/f104/f109——源里出现过的字段不再因开关关闭而消失）。 */
      _bruScatterCountField: brush._bruScatterCountField === true,
      _bruSmudgeAmountField: brush._bruSmudgeAmountField === true,
      _bruWetStrengthField: brush._bruWetStrengthField === true,
      _bruWetDepthField: brush._bruWetDepthField === true,
      _bruF109: brush._bruF109,
      _bruF87Raw: brush._bruF87Raw,
      _bruF31Field: brush._bruF31Field === true,
      _bruHollowAlpha: brush._bruHollowAlpha,
      _bruF135: keepMaxRatio ? brush._bruF135 : undefined,
      _bruF136: keepSizeRatio ? brush._bruF136 : undefined,
      taperSize: brush.taperSize,
      taperOpacity: brush.taperOpacity,
      /* 【第355轮实机对照】画世界湿边 f100=1 在固定画布颗粒层(#07/#13/#16)、高散布粒子(#33/#34) 及
         Procreate 轻湿边(<0.6, 受 f101 反向压黑)下会产生硬黑边/整条变黑；强湿边(>=0.6)非颗粒非散步笔保留湿边，
         且 f129 默认置 0（wetEdgesDepth=1）对齐画世界软水彩。BRU 源与 _bruExtra 往返完全不动。 */
      wetEdgesOn: (brush.source === 'procreate' && !brush._bruExtra && brush.wetEdgesOn &&
        ((match && match.grainLayer) || (brush.scatterOn && (brush.scatterPct || 0) >= 10) || Number(brush.wetEdgesAmount || 0) < 0.6))
        ? false : brush.wetEdgesOn,
      wetEdgesAmount: brush.wetEdgesAmount,
      wetEdgesDepth: (brush.source === 'procreate' && !brush._bruExtra && brush.wetEdgesDepth === undefined)
        ? 1 : brush.wetEdgesDepth,
      hollowPct: brush.hollowPct,
      antialiasLevel: brush.antialiasLevel,
      borderOn: bruBorder.on,
      borderBlend: bruBorder.blend,
      borderBrightness: bruBorder.brightness,
      borderStrength: bruBorder.strength,
      renderCount: brush.renderCount,
      speedPressure: !!brush.speedPressure,
      // #37 & 【第352轮真机实证】：画世界 mixColOpen=1 且无 mixColLen 时在纯白画布上 0 墨且禁用锥度/防抖；
      // 仅 Procreate 重度混色(dynamicsMix>=0.5)才自动开混色模式，轻湿混(<0.5)保持普通绘图笔正常出墨。
      smudgeOn: brush.smudgeOn || (brush.source === 'procreate' && brush.dynamicsMix >= 0.5) || (brush.smudgeOn !== undefined ? brush.smudgeOn : undefined),
      smudgeAmount: (brush.smudgeAmount > 0 || brush.source !== 'procreate') ? brush.smudgeAmount : (brush.dynamicsMix >= 0.5 ? brush.dynamicsMix : brush.smudgeAmount),
      colorDynamicsOn: (color ? color.enabled : brush.colorDynamicsOn) || dualColorAmount > 0.001,
      colorPerTip: brush.colorPerTip,
      colorJitterHue: color ? color.hue : brush.colorJitterHue,
      colorJitterSat: color ? color.saturation : brush.colorJitterSat,
      colorJitterVal: color ? color.brightness : brush.colorJitterVal,
      bruColorPressure: color && opts.pressure !== false ? color.pressure : undefined,
      /* 【第216轮】副色动态（Procreate jitterSecondary / 画世界「辅助颜色」f109）。
        来源是 Procreate 原生笔刷时 colorJitterFgBg 已在 procreate.js 解析出来，
        这里必须透传，否则转画世界时双色会丢。 */
      colorJitterFgBg: dualColorAmount > 0.001 ? dualColorAmount : brush.colorJitterFgBg,
      bruUuid: brush.bruUuid,
      bruDualRefUuid: brush.bruDualRefUuid,
      dualSubName: brush.dualSubName,
      bruDualSubBrush: brush.bruDualSubBrush,
      /* 副笔已经烘焙进笔尖时（bakingDual），画世界的「双笔刷」开关必须显式关掉。
         bru.js 写 f119 的规则是 `=== false ? 0 : 1`，undefined 也写 1 —— Procreate
         源的 bruDualEnabled 本来就是 undefined，于是笔尖里含一层副笔、双笔刷又画一层，
         同一笔落两次墨 = 用户看到的「重影」（黄土笔刷实测）。 */
      bruDualEnabled: bakingDual ? false : brush.bruDualEnabled,
      /* 【第290轮（作者：Claude）】BRU 源的「记录内嵌副笔尖」重转时别丢：f121 走 _rawMeta 原样带过去，
         副笔尖 PNG 却只在 embeddedTips 里（解码后的像素），以前没人写回 → 重转后副笔没有图。
         焦边描边的深色副笔（只有内嵌、包里没有独立副笔条目）重转一次框就没了；楠/轻舟的内嵌副图也一并被丢。
         按像素重编码写回（RGB 原样，BRU 源不走白遮罩）。 */
      embeddedSubPng: subEmbeddedPngFor(brush, customTexture),
      bruLinkTemplate: brush.source === 'bru' ? scaleBruLinkTemplate(brush.bruLinkTemplate, brush.sizePx > 0 ? sizePx / brush.sizePx : 1) : brush.bruLinkTemplate,
      dualBlendMode: brush.dualBlendMode === undefined ? (brush.dualBrush && brush.dualBrush.blend) : brush.dualBlendMode,
      bruDualBlendMode: writtenDualMode,
      /* 【第233轮】审计出的三个「写侧恒用常量」字段：源值必须透到写侧 */
      bruProtoVer: brush.bruProtoVer, hollowColor: brush.hollowColor,
      bruLegacyDirection: brush.bruLegacyDirection,
      oldTexId: brush.oldTexId,
      /* 第291轮 R290-03：改尺寸倍率时 f121 副笔尺寸同比例（见 scaleBruF121InMeta） */
      _rawMeta: opts.fidelity !== false && !opts.forceRebuild ? (brush.source === 'bru' ? scaleBruF121InMeta(brush._rawMeta, brush.sizePx > 0 ? sizePx / brush.sizePx : 1) : brush._rawMeta) : undefined,
      /* 【第232轮】未知字段原样透传（field-matrix D 表）：rebuild/brushset 路径靠它过桥。 */
      _rawUnknown: brush._rawUnknown,
      _rawOriginalName:brush._rawState && brush._rawState.name
    };
    const pressureEdit = nativePressureSecondaryEdit(brush);
    if (pressureEdit !== undefined) {
      const parts = editedPressureFields(util.concat(brush._rawUnknown || []), pressureEdit);
      if (parts) meta._rawUnknown = parts;
    }
    // Procreate's main canvas soft-light (17) maps to the calibrated BRU
    // canvas blend (f69=8). Do not infer from grain, dual or burnt-edge modes.
    // Conflicting archive twins and BRU roundtrip fields retain their state.
    const pcCanvas = brush._params;
    /* 【第399轮（作者：Lead）】第389轮把 f69 画布混合从「只认 17→8（晶冻柔光）」扩到
       全 12 项实机标定映射（1/2/3/4/9/10/11/13/14/16/17/21 → f69=1..12），
       归口 model-hsjpro.mapCanvasBlendMode（内部已做 archive 三值一致性拦截，不一致返回 null）。
       未映射的模式不在此处理：由 canvasBlendReport 进损失报告，不静默降级。 */
    if (brush.source === 'procreate' && !brush._bruExtra && !brush._pcLinkedSecondary && pcCanvas) {
      const mapped69 = hsjModel.mapCanvasBlendMode(brush);
      if (mapped69 !== null && mapped69 !== undefined) {
        const unknown = meta._rawUnknown || [];
        const bytes = util.concat(unknown);
        const fields = pbScan(bytes, 0, bytes.length);
        if ((!bytes.length || (fields.length && fields[fields.length - 1].end === bytes.length)) &&
            !fields.some(function (field) { return field.f === 69; })) {
          meta._rawUnknown = unknown.concat([rawVarintField(69, mapped69)]);
        }
      }
    }
    const embeddedEdit = nativePressureSecondaryEdit(brush.dualSubBrush);
    editEmbeddedPressure(meta, embeddedEdit === undefined ? opts._linkedPressureSecondary : embeddedEdit);
    /* 【第297轮（作者：Lead）】显式改动优先于「源里没有」：用户/调用方改过的字段一律写出去，
       不能因为「源 BRU 本来没有 f29/f35/f80/f115」就把改动吞掉
       （`bru_version_contract_test.js` 的「eye 改参数」用例锁的就是这一条）。
       对比基线取解析时的快照：BRU 源是 `_rawState`，brushset 源是 `_rawNormalized`。 */
    {
      const absentIn = meta._bruAbsentFields;
      if (absentIn && absentIn.length) {
        const base = brush._rawState || brush._rawNormalized || {};
        const EDIT_KEYS = {
          textureInverted: [29], bruShapeInverted: [32], textureContrast: [33], textureBrightness: [35],
          flowPct: [51], minFlowRatio: [51], colorPerTip: [65], smoothingStrength: [80],
          bruRotationMode: [115], bruDualEnabled: [119]
        };
        const keep = absentIn.slice();
        Object.keys(EDIT_KEYS).forEach(function (k) {
          /* 只在快照里**确实记过这个键**时才判定「改过」：快照缺键说明解析时本来就没这个语义，
             此时 meta 里的 false/0 只是 convert 侧兜底，不能当成用户改动（否则 f32/f51 会被全量补写）。 */
          if (!Object.prototype.hasOwnProperty.call(base, k)) return;
          if (meta[k] === base[k]) return;
          EDIT_KEYS[k].forEach(function (f) {
            const at = keep.indexOf(f);
            if (at >= 0) keep.splice(at, 1);
          });
        });
        meta._bruAbsentFields = keep.length ? keep : undefined;
      }
    }
    if(meta._rawMeta){
      const old=brush._rawState||{},fields=new Set();
      const mapping={name:[3],pkgId:[2],sizePx:[8,9,12,50,135,136],spacingPct:[17],opacity:[13,14],minSizeRatio:[9,50],minOpacityRatio:[14],
        pressure:[36,47,9,50,14],pressureSize:[36],pressureOpacity:[47],bruShapeInverted:[32],flowPct:[25,26,51],minFlowRatio:[26,51],angle:[20],angleJitterDeg:[21],bruRotationMode:[19,115],
        roundness:[22],hardness:[23],sizeJitterPct:[10],spacingJitterPct:[18],flowJitterPct:[27],countJitterPct:[60],
        /* 【第232轮】保真导出（原生 BRU 改参数再导出）只重写 mapping 里登记过的字段。
           f84 纹理混合模式、f43 速度压感、f16 画笔颜色以前都没登记，改了等于没改。 */
        bruTextureBlendMode:[84],speedPressure:[43],bruColor:[16],bruProtoVer:[37],hollowColor:[82],bruLegacyDirection:[19],bruSquareTip:[41],
        hasTexture:[28,123],texAssetId:[6],bruTexturePerTip:[99],textureInverted:[29],textureDepth:[123],grainDepthJitter:[125],textureScale:[24],textureBrightness:[35],textureContrast:[33],scatterOn:[56,57,58,59],
        scatterPct:[58],scatterCount:[59],scatterBothAxes:[57],taperOn:[74,77,78],taperSize:[77],taperOpacity:[78],wetEdgesOn:[100,101,129],
        colorPerTip:[65],
        wetEdgesAmount:[101],wetEdgesDepth:[129],borderOn:[92],borderBlend:[95],borderBrightness:[93],borderStrength:[94],renderCount:[97],
        bruUuid:[120],bruDualRefUuid:[119,120,121,122],dualSubName:[121],bruDualEnabled:[119],dualBlendMode:[122],bruDualBlendMode:[122],
        smudgeOn:[103,104],smudgeAmount:[104],smoothingStrength:[80],hollowPct:[44],antialiasLevel:[96],
        bruFlowSmooth:[67],bruFingerPressurePct:[117],bruFadeInOut:[134],
        bruPressureSizeInfluence:[138],bruPressureFlowInfluence:[139]};
      Object.keys(mapping).forEach(k=>{if(meta[k]!==old[k])mapping[k].forEach(f=>fields.add(f));});
      if (pressureEdit !== undefined) {
        fields.add(114);
        if (pressureEdit > 0) fields.add(110);
      }
      if (brush.maxSizePx !== old.maxSizePx) [12, 135, 136].forEach(f => fields.add(f));
      if(meta.texId!==brush.oldTexId)fields.add(7);
      if(brush.bruDualSubBrush)fields.add(121);
      meta._rawPatchFields=Array.from(fields);
    }
    if (brush.source === 'bru' && brush._pcScalar && !canRestoreTipRaw && opts.fidelity !== false &&
        !opts.noTextureBake && opts.procreateGrainBridge !== false) {
      const previousHash = util.md5(pngBytes).toUpperCase();
      pngBytes = addProcreateGrainChunk(pngBytes, brush._pcScalar.chunk);
      if (meta.texId === previousHash) meta.texId = util.md5(pngBytes).toUpperCase();
    }
    if (brush.source === 'bru' && !canRestoreTipRaw && brush._nativeArchiveBackup) {
      const archive = eligibleNativeArchive(brush, opts, true);
      if (archive) {
        const saved = brush._nativeArchiveBackup;
        const baseline = writtenDualMode === brush.bruDualBlendMode ? brush : Object.assign({}, brush, {bruDualBlendMode:writtenDualMode});
        const chunk = archive === saved.archive ? saved.chunk : writeNativeArchive({_rawArchive:archive}, baseline, opts);
        if (chunk) {
          const previousHash = util.md5(pngBytes).toUpperCase();
          pngBytes = addProcreateGrainChunk(pngBytes, chunk);
          if (meta.texId === previousHash) meta.texId = util.md5(pngBytes).toUpperCase();
        }
      }
    }
    if (brush.source === 'procreate' && brush._rawArchive && !brush._bruExtra && !brush._bruTexParams && opts.fidelity !== false &&
        !opts.noTextureBake && opts.procreateGrainBridge !== false) {
      try {
        const provisional = bru.writeBrush(Object.assign({png: pngBytes}, meta), opts);
        const baseline = bru.parseBru(provisional).brushes[0];
        const chunk = writePcScalar(brush, baseline, opts);
        if (chunk) {
          const previousHash = util.md5(pngBytes).toUpperCase();
          pngBytes = addProcreateGrainChunk(pngBytes, chunk);
          if (meta.texId === previousHash) meta.texId = util.md5(pngBytes).toUpperCase();
        }
      } catch (_) { /* A missing sidecar must never prevent conversion. */ }
    }
    if (brush.source === 'bru' && !canRestoreTipRaw && brush._procreateDualBridge &&
        opts.fidelity !== false && !opts.noTextureBake && opts.procreateGrainBridge !== false) {
      const previousHash = util.md5(pngBytes).toUpperCase();
      pngBytes = addProcreateGrainChunk(pngBytes, brush._procreateDualBridge.chunk);
      if (meta.texId === previousHash) meta.texId = util.md5(pngBytes).toUpperCase();
    }
    if (brush.source === 'procreate' && (bakingDual || subFlatInk) && brush.dualSubBrush &&
        opts.fidelity !== false && !opts.noTextureBake && opts.procreateGrainBridge !== false &&
        (opts.sizeScale === undefined || opts.sizeScale === 1) && !(opts.spacingOverride > 0) && opts.pressure === undefined) {
      // Parse the exact bytes that will be written to obtain the native unit and
      // quantization state. Pixel and texture edits invalidate restoration.
      try {
        const item = Object.assign({ png: pngBytes }, meta);
        const provisional = opts._noFilePassthrough ? bru.writePack([item], opts) : bru.writeBrush(item, opts);
        const baseline = bru.parseBru(provisional).brushes[0];
        const chunk = baseline && dualBridgeWrite(brush, baseline, allowNativeProcreateRestore(opts) ? originalBrush : brush);
        if (chunk) {
          const previousHash = util.md5(pngBytes).toUpperCase();
          pngBytes = addProcreateGrainChunk(pngBytes, chunk);
          if (meta.texId === previousHash) meta.texId = util.md5(pngBytes).toUpperCase();
        }
      } catch (_) { /* Keep the valid drawing if a backup cannot be made. */ }
    }
    if (brush.source === 'procreate' && opts.fidelity !== false && !opts.noTextureBake && opts.procreateGrainBridge !== false && !bakingDual && !subFlatInk) {
      const shapeRef = !brush._rawShape && brush.shapeFromLibrary && procreateLibraryGrain(brush.bundledShapePath) && brush._rawTipState === util.brushFingerprint({tip:brush.tip}) && !brush.flipX && !brush.flipY && !!brush.shapeInverted === !!(brush._rawNormalized || {}).shapeInverted ? brush.bundledShapePath : null;
      const grainRef = !brush._rawGrain && brush.grainFromLibrary && procreateLibraryGrain(brush.bundledGrainPath) && brush._rawGrainState === util.brushFingerprint({tip:brush._grainRgba}) && ['textureDepth','textureScale','textureBrightness','textureContrast','textureInverted','textureRotation','hasTexture'].every(k => brush[k] === (brush._rawNormalized || {})[k]) ? brush.bundledGrainPath : null;
      if (shapeRef || grainRef) try {
        const baseline = bru.parseBru(bru.writeBrush(Object.assign({png:pngBytes}, meta), opts)).brushes[0];
        const library = { version:2, fingerprint: libraryBridgeState(baseline), shapeRef, grainRef, params: procreate.grainArchiveScalars(brush._params) };
        const chunk = buildMarkChunk(false, undefined, library);
        if (chunk) { const old = util.md5(pngBytes).toUpperCase(); pngBytes = addProcreateGrainChunk(pngBytes, chunk); if (meta.texId === old) meta.texId = util.md5(pngBytes).toUpperCase(); }
      } catch (_) { /* keep the rendered BRU on backup failure */ }
    }
    if (brush.source === 'procreate' && ((brush._pcNativeArchiveEligible && originalBrush && originalBrush._pcNativePairState === util.brushFingerprint(originalBrush)) || nativeArchiveUntouched(originalBrush)) &&
        opts.fidelity !== false && !opts.forceRebuild && !opts.noTextureBake && opts.procreateGrainBridge !== false &&
        opts.pressure === undefined && !(opts.spacingOverride > 0) && (opts.sizeScale === undefined || opts.sizeScale === 1)) {
      try {
        const baseline=bru.parseBru(bru.writeBrush(Object.assign({png:pngBytes},meta),opts)).brushes[0];
        const chunk=writeNativeArchive(brush,baseline,opts);
        if (chunk) { const old=util.md5(pngBytes).toUpperCase();pngBytes=addProcreateGrainChunk(pngBytes,chunk);if(meta.texId===old)meta.texId=util.md5(pngBytes).toUpperCase(); }
      } catch (_) { /* native archive backup is optional */ }
    }
    const bytes = bru.writeBrush(Object.assign({ png: pngBytes }, meta), opts);
    return { bytes, pngBytes, meta, tipW: w, tipH: h, textureBaked, density: densityInfo };
  }

  /**
   * Convert a list of parsed brushes into ONE multi-brush .bru pack
   * (画世界Pro keeps the whole set together when importing a single .bru).
   */
  /* 【第281轮】把 makeBruPack 拆成「建包上下文 → 逐支转换 → 收尾 → 写盘」四步，
     让 async 版本可以在**每支之间**让出线程。目的不是好看：
     整包导出是一段同步重活，用户点「取消」的事件要等它算完才排得上队（第273轮遗留）。
     拆开之后，app 用 makeBruPackAsync 逐支 await，取消按钮才真的点得动。 */
  function matchingPressureLink(brush, byId) {
    const ref = brush && brush.bruDualRefUuid, sub = brush && brush.dualSubBrush;
    if (!ref || !sub || !sub._rawState || !brush._rawState || brush._rawState.bruDualRefUuid !== ref) return null;
    const linked = byId.get(ref) || byId.get(sub.bruUuid);
    if (!linked || linked === brush || !linked._rawState || (ref !== linked.pkgId && ref !== linked.bruUuid)) return null;
    const from = linked._rawState, nested = sub._rawState;
    if (from.pkgId !== ref && from.bruUuid !== ref) return null;
    if (from.bruUuid && nested.bruUuid && from.bruUuid !== nested.bruUuid) return null;
    return (from.colorPressureSecondary || 0) === (nested.colorPressureSecondary || 0) ? linked : null;
  }
  function bruPackContext(brushList, opts) {
    opts = opts || {};
    const packOpts = Object.assign({}, opts, { _noFilePassthrough: true, _packMember: brushList.length > 1 });
    const byId = new Map();
    brushList.forEach(function (b) {
      if (!b) return;
      for (const id of [b.pkgId, b.bruUuid]) {
        if (id) byId.set(id, byId.has(id) && byId.get(id) !== b ? null : b);
      }
    });
    const embeddedEdits = new Map();
    if (brushList.some(b => nativePressureSecondaryEdit(b && b.dualSubBrush) !== undefined)) {
      for (const b of brushList) {
        const linked = matchingPressureLink(b, byId);
        if (!linked || nativePressureSecondaryEdit(linked) !== undefined) continue;
        const edit = nativePressureSecondaryEdit(b.dualSubBrush);
        // Shared records inherit only an edit that every originally matching
        // parent agrees on. A parent left untouched counts as a distinct choice.
        embeddedEdits.set(linked, embeddedEdits.has(linked) && embeddedEdits.get(linked) !== edit ? null : edit);
      }
    }
    return { opts: opts, packOpts: packOpts, byId, embeddedEdits, used: new Map(), items: [] };
  }

  function bruPackAddItem(ctx, brushList, brush, i) {
    const ref = brush && brush.bruDualRefUuid;
    const itemOpts = Object.assign({}, ctx.packOpts, { _linkTargetPresent: !!ref && ctx.byId.has(ref) });
    if (brush && brush._pcBurntBorderSubUuid) {
      itemOpts._linkTargetPresent = !!nativeBorderSubInPack(brush, brushList);
    }
    const linked = matchingPressureLink(brush, ctx.byId);
    if (linked) itemOpts._linkedPressureSecondary = nativePressureSecondaryEdit(linked);
    const edit = ctx.embeddedEdits.get(brush);
    const entry = Number.isFinite(edit) ? Object.assign({}, brush, { colorPressureSecondary: edit }) : brush;
    const made = makeBru(entry, itemOpts);
    let base = sanitizeName(brush && brush.name, i);
    let name = base, k = 2;
    while (ctx.used.has(name.toLowerCase())) { name = base + ' (' + k + ')'; k++; }
    ctx.used.set(name.toLowerCase(), 1);
    ctx.items.push(Object.assign({}, made.meta, { name: name, png: made.pngBytes }));
    void brushList;
  }

  function bruPackFinalize(ctx, brushList) {
    const items = ctx.items;
    if (!items.length) throw new Error('没有可打包的笔刷');
    // Build embedded secondary metadata from the very same converted parameters
    // used for its standalone record (including scatter/size calibration).
    items.forEach(function (item, i) {
      if (!item.bruDualSubBrush) return;
      const sub = item.bruDualSubBrush;
      if (item.embeddedSubPng || sub.noShape || sub.bruBuiltinTipRef) {
        // makeBruEmbedded has already converted the secondary metadata.
        item.dualSubName = sub.name;
        return;
      }
      const ix = brushList.indexOf(sub);
      item.bruDualSubBrush = ix >= 0 ? items[ix] : makeBru(sub, ctx.packOpts).meta;
      item.dualSubName = item.bruDualSubBrush.name;
    });
    const opts = ctx.opts;
    const bytes = bru.writePack(items, { pkgId: opts.pkgId, fidelity: opts.fidelity, keepRawMeta: opts.keepRawMeta, spacingOverride: opts.spacingOverride });
    return { bytes: bytes, count: items.length, meta: items };
  }

  function makeBruPack(brushList, opts) {
    opts = opts || {};
    brushList = expandBurntOutlineVariants(brushList, opts);
    if (brushList.length === 1) {
      const only = makeBru(brushList[0], opts);
      if (only.passthrough) return { bytes: only.bytes, count: 1, meta: null, passthrough: true };
    }
    const ctx = bruPackContext(brushList, opts);
    brushList.forEach(function (brush, i) { bruPackAddItem(ctx, brushList, brush, i); });
    return bruPackFinalize(ctx, brushList);
  }

  /* 逐支 await 的整包导出：产出与 makeBruPack **逐字节相同**（同一套 addItem/finalize），
     只是每支之间让出线程，让取消按钮与进度条真正生效。
     hooks: { onBrush(i,total), shouldAbort() } —— shouldAbort 返回真时抛 code='ABORTED'。 */
  async function makeBruPackAsync(brushList, opts, hooks) {
    opts = opts || {};
    hooks = hooks || {};
    brushList = expandBurntOutlineVariants(brushList, opts);
    if (brushList.length === 1) {
      /* 单支也走异步：那一次同步重活最长（2048² 纹理烘焙），不让出的话取消照样点不到 */
      const only = makeBru(brushList[0], opts);
      if (only.passthrough) return { bytes: only.bytes, count: 1, meta: null, passthrough: true };
      await yieldTick();
      if (hooks.shouldAbort && hooks.shouldAbort()) throw abortError();
      const ctxOne = bruPackContext(brushList, opts);
      bruPackAddItem(ctxOne, brushList, brushList[0], 0);
      return bruPackFinalize(ctxOne, brushList);
    }
    const ctx = bruPackContext(brushList, opts);
    for (let i = 0; i < brushList.length; i++) {
      if (hooks.shouldAbort && hooks.shouldAbort()) throw abortError();
      await yieldTick();
      bruPackAddItem(ctx, brushList, brushList[i], i);
      if (hooks.onBrush) hooks.onBrush(i, brushList.length);
    }
    await yieldTick();
    if (hooks.shouldAbort && hooks.shouldAbort()) throw abortError();
    return bruPackFinalize(ctx, brushList);
  }

  function yieldTick() {
    return new Promise(function (resolve) {
      if (typeof setTimeout === 'function') setTimeout(resolve, 0);
      else resolve();
    });
  }

  function abortError() {
    const e = new Error('已取消');
    e.code = 'ABORTED';
    return e;
  }

  /**
   * Convert a list of parsed brushes into ONE .abr (v6) file.
   * v2 输出已移除：PS 2026 拒绝 v2，画世界Pro/PS 均支持 v6。
   */
  /** ABR -> ABR 直接原样导出：完全保留文件夹分组、动态参数、计算画笔等，
      是唯一能 100% 还原原版外观与分组的方式。 */
  function makeAbrPassthrough(bytes) {
    if (!bytes || !bytes.length) throw new Error('没有可导出的 ABR 数据');
    return { bytes: bytes, count: 0, passthrough: true };
  }

  /** 导出笔刷的真实纹理为 PNG（PS 里可「编辑→定义图案」手动指定，实现可调纹理） */
  function makeTexturePng(brush) {
    if (!brush) return null;
    if (brush._grainRgba && brush._grainRgba.w > 0) {
      return { bytes: png.encode(brush._grainRgba.w, brush._grainRgba.h, brush._grainRgba.rgba), w: brush._grainRgba.w, h: brush._grainRgba.h };
    }
    if (brush.grain && brush.grain.w > 0 && brush.grain.h > 0 && brush.grain.rgba && brush.grain.rgba.length === brush.grain.w * brush.grain.h * 4) {
      const g = brush.grain;
      return { bytes: png.encode(g.w, g.h, g.rgba), w: g.w, h: g.h };
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
      return { bytes: png.encode(w, h, out), w: w, h: h };
    }
    /* 【第187轮】前三路都是「笔刷自带像素」。BRU 的纹理只有资源 id（f6=ptN），
       没有像素，所以「导出纹理 PNG」对这类笔刷一直是空的。这里让 textureGray
       兜底（它会走到内置纹理库），导出的 PNG 才是用户真正看到的那张纹理。 */
    const t = textureGray(brush);
    if (t && t.w > 0 && t.h > 0 && t.gray && t.gray.length === t.w * t.h) {
      const out = new Uint8Array(t.w * t.h * 4);
      for (let i = 0; i < t.gray.length; i++) {
        const v = t.gray[i];
        out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
      }
      return { bytes: png.encode(t.w, t.h, out), w: t.w, h: t.h };
    }
    return null;
  }

  /** 取笔刷纹理的灰度数据（ABR patt 像素优先，其次 Procreate Grain） */
  function textureGray(brush) {
    if (!brush) return null;
    const inv = !!brush.textureInverted;
    if (brush._patternPixels && brush._patternPixels.w > 0) {
      const pp = brush._patternPixels, w = pp.w, h = pp.h;
      const gray = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        if (pp.mode === 3) { const o = i * 3; gray[i] = Math.round((pp.data[o] + pp.data[o + 1] + pp.data[o + 2]) / 3); }
        else gray[i] = pp.data[i];
      }
      if (inv) { for (let i = 0; i < gray.length; i++) gray[i] = 255 - gray[i]; }
      return { w: w, h: h, gray: gray };
    }
    if (brush._grainRgba && brush._grainRgba.w > 0) {
      const g = brush._grainRgba, w = g.w, h = g.h;
      const gray = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const o=i*4;
        const coverage=Math.round((g.rgba[o]+g.rgba[o+1]+g.rgba[o+2])*g.rgba[o+3]/765);
        gray[i]=inv?255-coverage:coverage;
      }
      return { w: w, h: h, gray: gray };
    }
    // Native GoPaint keeps its decoded, opaque RGB grain in a public field.
    // Bridge the image rather than dropping it at the common texture boundary.
    if (brush.grain && brush.grain.w > 0 && brush.grain.h > 0 && brush.grain.rgba) {
      const g = brush.grain, gray = new Uint8Array(g.w * g.h);
      if (g.rgba.length !== gray.length * 4) return null;
      for (let i = 0; i < gray.length; i++) {
        const o = i * 4, a = g.rgba[o + 3] / 255;
        const v = Math.round((g.rgba[o] + g.rgba[o + 1] + g.rgba[o + 2]) / 3 * a + 255 * (1 - a));
        gray[i] = inv ? 255 - v : v;
      }
      return { w: g.w, h: g.h, gray: gray };
    }
    /* 【第187轮】第四级来源：画世界 App 自带的 156 张内置纹理。
       画世界 BRU 的 f6 只存**资源 id**（`ptN`），不含像素；这类笔刷转到
       ABR / Procreate / Krita / GoPaint / SAI2 / SUT 时，过去一律按「缺纹理
       原图」降级，纹理被静默丢掉（用户反馈过网点笔刷变半透明块）。
       前面三级全是**用户素材**，任何覆盖都等于改坏原笔刷（第66/179轮踩过），
       所以内置库只垫在最末位，且必须：id 形如 ptN、库里真有这一号、用户没有
       显式关掉纹理（hasTexture === false）。
       解不开（progressive JPEG 等）时 hsj-textures-lib 返回 null，行为与改动前完全一致。 */
    if (brush.texAssetId && brush.hasTexture !== false) {
      const lib = isNode ? require('./hsj-textures-lib.js') : (root.BC && root.BC.hsjTextureLib);
      if (lib && typeof lib.gray === 'function') {
        const t = lib.gray(brush.texAssetId);
        if (t && t.w > 0 && t.h > 0 && t.gray && t.gray.length === t.w * t.h) {
          /* 一律复制：库内是 LRU 缓存数组，就地反相会污染下一个调用者 */
          const gray = new Uint8Array(t.gray.length);
          if (inv) { for (let i = 0; i < gray.length; i++) gray[i] = 255 - t.gray[i]; }
          else gray.set(t.gray);
          return { w: t.w, h: t.h, gray: gray, builtinTexture: String(brush.texAssetId) };
        }
      }
    }
    return null;
  }

  /* 纹理内容指纹：同内容只生成一个图案 */
  function textureKey(brush) {
    const t = textureGray(brush);
    if (!t) return '';
    return String(t.w) + 'x' + String(t.h) + ':' + util.md5(t.gray);
  }

  /** 生成 .pat 图案文件（PS 图案面板导入后，ABR 里的纹理引用才能解析）
      支持多纹理：按内容去重，一张纹理一个图案，全部打进同一个 .pat */
  function makePatternFile(brushList, opts) {
    opts = opts || {};
    const patMod = isNode ? require('./pat.js') : root.BC.pat;
    const seen = {};
    const list = [];
    for (const b of (brushList || [])) {
      const t = textureGray(b);
      if (!t) continue;
      const key = String(t.w) + 'x' + String(t.h) + ':' + util.md5(t.gray);
      if (seen[key]) continue;
      seen[key] = 1;
      list.push({ key: key, t: t, name: (b.textureName || 'brushconv-texture'), brushName: b.name });
    }
    // 文件名按用户要求回到「笔刷组名-纹理」：同一个组的所有纹理合成一个 .pat（多图案）
    const groupFileBase = sanitizeName(String(opts.groupName || '').trim() || '纹理图案', 0) + '-纹理';
    if (!list.length) {
      const made = patMod.buildGrainPat({ size: opts.size || 256, seed: opts.seed || 11 });
      return { bytes: made.bytes, count: 1, refs: new Map(), ref: { id: made.id, name: made.name }, width: made.width, height: made.height,
        files: [{ name: groupFileBase, bytes: made.bytes }] };
    }
    const records = [];
    const refs = new Map();
    let i = 0;
    for (const item of list) {
      i++;
      let base = String(item.name || 'texture').replace(/^.*=/, '');
      if (!base || base === 'brushconv-texture') base = String(item.brushName || ('纹理 ' + i));
      const nm = (base || ('纹理 ' + i)).slice(0, 26) + ' ' + item.t.w + 'x' + item.t.h + (i > 1 ? (' #' + i) : '');
      const p = patMod.buildPattern(nm, item.t.w, item.t.h, [item.t.gray, item.t.gray, item.t.gray], undefined, true);
      records.push(p);
      refs.set(item.key, { id: p.id, name: p.name, inversionBaked: true });
    }
    const bytes = patMod.buildPat(records);
    // 自检：用内置 .pat 读取器回读，确认图案数量/尺寸与预期一致（不需要真实 PS）
    let selfCheck = { ok: true, readCount: records.length, names: records.map(function (r) { return r.name; }) };
    try {
      const reader = isNode ? require('./patRead.js') : root.BC.patRead;
      if (reader && reader.readPat) {
        const back = reader.readPat(bytes);
        selfCheck.readCount = back.length;
        let pixelsOk = back.length === records.length;
        if (pixelsOk) {
          for (let idx = 0; idx < list.length; idx++) {
            const want = list[idx].t.gray, got = back[idx] && back[idx].gray;
            if (!got || got.length !== want.length) { pixelsOk = false; break; }
            for (let k = 0; k < want.length; k++) { if (want[k] !== got[k]) { pixelsOk = false; break; } }
            if (!pixelsOk) break;
          }
        }
        selfCheck.pixelsOk = pixelsOk;
        selfCheck.ok = pixelsOk && back.every(function (pt, idx) {
          return pt.width === list[idx].t.w && pt.height === list[idx].t.h;
        });
        selfCheck.names = back.map(function (x) { return x.name; });
      }
    } catch (e) { selfCheck.ok = false; selfCheck.error = e.message; }
    // 同一个组的所有图案放进这一个 PAT；图案 ID/名字就是各 ABR 里引用的那份，不需要再拆
    return { bytes: bytes, count: records.length, refs: refs, ref: records[0] ? { id: records[0].id, name: records[0].name, inversionBaked: true } : null, width: list[0].t.w, height: list[0].t.h, selfCheck: selfCheck, files: [{ name: groupFileBase, bytes: bytes }] };
  }

  // Batch outputs share one PAT. Preserve pixels, names and IDs, since
  // the matching ABRs/TPLs have already been written with those references.
  function mergePatternFiles(files) {
    const records = [], ids = new Map();
    const patMod = isNode ? require('./pat.js') : root.BC.pat;
    const reader = isNode ? require('./patRead.js') : root.BC.patRead;
    for (const bytes of files) {
      if (util.ascii(bytes,0,4) !== '8BPT' || util.u16(bytes,4) !== 1) throw Error('无效的 PAT 合集');
      const parts = reader.readPat(bytes);
      if (parts.length !== util.u32(bytes,6)) throw Error('PAT 图案记录不完整');
      for (const part of parts) {
        if (!part.id || !part.width || !part.height || part.gray.length !== part.width*part.height) throw Error('PAT 图案记录不完整');
        const key = part.width+'x'+part.height+':'+util.md5(part.gray);
        if (ids.has(part.id)) {
          if (ids.get(part.id) !== key) throw Error('PAT 图案 ID 冲突');
          continue;
        }
        ids.set(part.id,key);
        records.push(patMod.buildPattern(part.name,part.width,part.height,[part.gray,part.gray,part.gray],part.id,true));
      }
    }
    return {bytes:patMod.buildPat(records), count:records.length};
  }

  /* 【第285轮】原包透传判定：同步/异步两条导出路径共用同一套判断（从 makeAbrPack 提出） */
  function abrPackPassthrough(brushList, opts) {
    /* 【第266轮】原包透传：输入正好是源 .abr 的全部笔刷、顺序一致、且没有任何字段被改过
       → 直接回吐原始字节。以前每次导出都重建容器（头 + section 布局），
       66 / 503 支样本原样往返时字节全变。 */
    if (!(brushList.length && brushList[0] && brushList[0]._rawAbrPack &&
        opts.forceRebuild !== true && opts.fidelity !== false && opts.preserveRaw !== false &&
        /* 重新绑定图案（textureMode=pattern / patternRefs）时必须重建，否则 PAT ID 换不掉 */
        opts.textureMode !== 'pattern' && !opts.patternRefs && !opts.patternRef)) return null;
    const pack = brushList[0]._rawAbrPack;
    if (brushList.length !== pack.count) return null;
    if (!brushList.every(function (b, i) { return b && b._rawAbrPack === pack && b._rawAbrIndex === i; })) return null;
    for (const b of brushList) {
      /* 基线在 parseFile 收尾时记（见那里的注释）。这里是「比对」不是「初始化」：
         没有基线就说明不是同一次解析出来的对象，一律走重建，绝不能懒初始化——
         那会把「用户改过的当前值」当成原始值，导出等于什么都没改。 */
      if (b._rawAbrBase === undefined || b._rawAbrBase !== util.brushFingerprint(b)) return null;
    }
    return { bytes: new Uint8Array(pack.bytes), count: pack.count, passthrough: true };
  }

  /* 【第285轮】单支笔刷 → ABR 条目（原 makeAbrPack 里 forEach 回调体的原样搬移） */
  function abrPackItem(source, i, names, opts) {
    let brush=withExportSettings(source,opts);
    /* 【第286轮】Procreate 的 8×8 纯白方块（Blank 预设）写进 ABR 是「采样笔刷」：PS 会把 8×8 双线性放大到
       目标直径，硬边糊成软头（实测：吹石-大号方块 117px 笔尖在产物里仍是 8×8）。BRU 出口第274轮已处理
       （expandTinyBinaryTip），ABR 这条路一直没接。只在没有原生样本可透传时放大——带 _rawPreset 的
       情况要逐字节保留原始样本，动了反而是破坏保真。 */
    if (source.source !== 'bru' && !source._rawPreset && opts.fidelity !== false) {
      brush = expandTinyBinaryTip(brush, opts);
    }
    if(opts.pressure!==undefined){
      brush.dynamicsControlSize=opts.pressure?2:(source.dynamicsControlSize===2?0:source.dynamicsControlSize);
      if(opts.pressure===false && source.dynamicsControlOpacity===2)brush.dynamicsControlOpacity=0;
      if(opts.pressure===false)['Angle','Roundness','Scatter','Count','Flow'].forEach(k=>{if(source['dynamicsControl'+k]===2)brush['dynamicsControl'+k]=0;});
    }
    const keepRaw=opts.preserveRaw!==false && opts.fidelity!==false && !opts.forceRebuild;
    const tipChanged=!!source._rawPreset && source._rawTipState!==util.brushFingerprint({tip:brush.tip});
    const dualTipChanged=!!source._rawPreset && source._rawDualTipState!==util.brushFingerprint({tip:brush.dualTip});
    const dualChanged=!!source._rawPreset && source._rawDualState!==util.brushFingerprint({dualBrush:brush.dualBrush,dualOn:brush.dualOn,dualBlendMode:brush.dualBlendMode});
    const paths=new Set(),before=source._rawNormalized||{};
    const mapping={sizePx:['Brsh.Dmtr'],spacingPct:['Brsh.Spcn'],angle:['Brsh.Angl'],roundness:['Brsh.Rndn'],
      name:['Nm  ','Brsh.Nm  '],flipX:['Brsh.flipX'],flipY:['Brsh.flipY'],hardness:['Brsh.Hrdn'],
      pressure:['useTipDynamics','szVr.bVTy','minimumDiameter'],pressureSize:['useTipDynamics','szVr.bVTy','minimumDiameter'],
      pressureOpacity:['usePaintDynamics','opVr.bVTy','opVr.Mnm '],minSizeRatio:['minimumDiameter'],minOpacityRatio:['opVr.Mnm '],
      dynamicsControlSize:['useTipDynamics','szVr.bVTy'],dynamicsControlOpacity:['usePaintDynamics','opVr.bVTy'],
      sizeJitterPct:['useTipDynamics','szVr.jitter'],opacityJitterPct:['usePaintDynamics','opVr.jitter'],
      flowPct:['toolOptions.flow'],opacity:['toolOptions.Opct'],
      hasTexture:['useTexture'],textureDepth:['textureDepth'],textureScale:['textureScale'],textureInverted:['InvT']};
    Object.assign(mapping,{dynamicsControlAngle:['useTipDynamics','angleDynamics.bVTy'],dynamicsControlRoundness:['useTipDynamics','roundnessDynamics.bVTy'],
      dynamicsControlScatter:['scatterDynamics.bVTy'],dynamicsControlCount:['countDynamics.bVTy'],dynamicsControlFlow:['usePaintDynamics','prVr.bVTy'],
      angleJitterDeg:['useTipDynamics','angleDynamics.jitter'],roundnessJitterPct:['useTipDynamics','roundnessDynamics.jitter'],
      tiltJitterPct:['useTipDynamics','ttlVr.jitter'],minRoundnessRatio:['minimumRoundness'],
      scatterOn:['useScatter'],scatterPct:['scatterDynamics.jitter'],scatterCount:['Cnt ','useScatter'],scatterBothAxes:['bothAxes'],
      countJitterPct:['countDynamics.jitter','useScatter'],flowJitterPct:['prVr.jitter','usePaintDynamics'],
      colorDynamicsOn:['useColorDynamics'],colorJitterFgBg:['clVr.jitter'],colorPerTip:['colorDynamicsPerTip'],colorJitterHue:['H   '],colorJitterSat:['Strt'],colorJitterVal:['Brgh'],
      /* 【第277轮】clVr 的「控制源 / 最小值」以前没进补丁表：改了它们，keepRaw 路径不会重写
         clVr.bVTy / clVr.Mnm，导出后回读变回 null/undefined（实测 control.abr：设 5 / 0.42 → 回读 null）。
         同第270轮 ABR 基线那类「改了等于没改」，只是这次发生在属性子字段上。 */
      dynamicsControlColor:['clVr.bVTy'],colorMinRatio:['clVr.Mnm '],
      noise:['Nose'],buildUp:['Rpt '],wetEdgesOn:['Wtdg'],poseOn:['useBrushPose']});
    if(keepRaw && source._rawPreset)Object.keys(mapping).forEach(k=>{if(brush[k]!==before[k])mapping[k].forEach(p=>paths.add(p));});
    if(tipChanged)paths.add('Brsh.sampledData');
    if(keepRaw && source._rawPreset && source._rawFadeState!==JSON.stringify(brush.dynamicsFadeSteps||{}))
      ['szVr','opVr','angleDynamics','roundnessDynamics','ttlVr','scatterDynamics','countDynamics','prVr'].forEach(p=>paths.add(p+'.fStp'));
    if(dualChanged || dualTipChanged){['useDualBrush','Brsh.Dmtr','Brsh.Angl','Brsh.Rndn','Brsh.Spcn','Brsh.sampledData','Brsh.flipX','Brsh.flipY','useScatter','Cnt ','bothAxes','scatterDynamics.jitter','countDynamics.jitter'].forEach(p=>paths.add('dualBrush.'+p));}
    if(brush.dualBlendMode!==before.dualBlendMode)paths.add('dualBrush.BlnM');
    let tipImg = tipToRGBA(brush);
    if (!tipImg) tipImg = synthTip(brush, 256, opts);
    const synthesizeDual = brush.dualOn && brush.dualTip && (!keepRaw || !brush._rawDualObjc || dualTipChanged);
    const maxTip = Math.max(64, Math.min(2048, opts.maxTipSize || 2048));
    const dualCap = {};   // 副笔尖缩放后的实际尺寸（写 dualW/dualH 用）
    let w = tipImg.w, h = tipImg.h, rgba = tipImg.rgba;
    const maxSide = Math.max(w, h);
    if (maxSide > maxTip) {
      const scale = maxTip / maxSide;
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
      rgba = png.resize(rgba, tipImg.w, tipImg.h, w, h);
    }
    const name = String(names[i] || brush.name || ('brush_' + (i + 1)))
    // 纹理：ABR 现在可以写真实 patt 图案块；只有关闭 psTexture 时才退化为烘焙
    // 默认策略（越还原越好）：
    //  · 源有原始描述符（保留引用路径）→ 保留原纹理引用
    //  · 需要重建描述符（其他格式来源）→ 把纹理烘焙进笔尖（PS 不会从 ABR 导入图案，写图案引用会变空）
    const willUseRaw = keepRaw && !!brush._rawPreset;
    const textureMode = opts.textureMode === 'pattern';
    const patternRef = (brush.hasTexture && (textureMode || willUseRaw) &&
      ((opts.patternRefs && opts.patternRefs.get(textureKey(brush))) || opts.patternRef)) || null;
    // A new brush can only enable an independent texture with a real PAT
    // reference. Native presets may still retain their original reference.
    const usePsTexture = !!brush.hasTexture && (willUseRaw || (textureMode && !!patternRef));
    // Native presets otherwise pass through with their old Txtr ID, even
    // though the companion PAT owns a new ID. Patch just the binding fields.
    if (willUseRaw && patternRef) {
      ['Txtr', 'useTexture'].forEach(p => paths.add(p));
    }
    /* 引用了已烘入反转的 PAT 时 InvT 必须是 false；而 raw 源的原值本来就是 true，
       不把它列进 rawPatchPaths 的话 desc.patchDescriptor 根本不会改这个字段（#260）。 */
    const effectiveTextureInverted = patternRef && patternRef.inversionBaked ? false : !!brush.textureInverted;
    if (keepRaw && brush._rawPreset && effectiveTextureInverted !== !!brush.textureInverted) paths.add('InvT');
    // 只有拿到真实纹理像素才烘焙：纹理开关 + 缺原图时伪造程序化噪声会直接改变笔刷图案
    // （与第66轮 BRU「空纹理保持关闭、不用噪声兜底」的策略一致）。
    // 烘焙前复制 rgba：bakeTextureIntoRGBA 就地修改，否则会污染 brush.tip.rgba，
    // 同一支笔刷重复导出 ABR 会反复叠加，同一次运行里后续格式也会继承被烘焙的笔尖。
    if (brush.hasTexture && !usePsTexture && !textureMode && opts.noTextureBake !== true && textureGray(brush)) {
      rgba = new Uint8Array(rgba);
      bakeTextureIntoRGBA(rgba, w, h, brush, brush.textureDepth === undefined ? (brush.grainStrength === undefined ? 0.35 : brush.grainStrength) : brush.textureDepth);
    }
    const fade = abrTaperFade(brush); // 锥度→渐隐（无压感占用时），报告状态与写出共用同一判定
    return ({
      name: name, w: w, h: h, gray: abr.maskFromRGBA(rgba),
      sizePx: brush.sizePx, spacingPct: brush.spacingPct,
      angle: brush.angle, roundness: brush.roundness,
      flipY: !!opts.abrFlipY,
      brushFlipX: !!brush.flipX,
      brushFlipY: !!brush.flipY,
      pressureSize: pressureSizeOn(brush),
      pressureOpacity: !!brush.pressureOpacity,
      dynamicsControlSize: fade.sizeCtl !== undefined ? fade.sizeCtl : (brush.dynamicsControlSize == null ? (pressureSizeOn(brush) ? 2 : (brush.tiltSizeDyn > 0 ? 3 : 0)) : brush.dynamicsControlSize),
      dynamicsControlOpacity: fade.opacityCtl !== undefined ? fade.opacityCtl : (brush.dynamicsControlOpacity == null ? (brush.pressureOpacity ? 2 : (brush.tiltOpacityDyn > 0 ? 3 : 0)) : brush.dynamicsControlOpacity),
      dynamicsControlAngle: brush.dynamicsControlAngle === undefined ? (brush.tiltAngleDyn > 0 ? 3 : undefined) : brush.dynamicsControlAngle,
      dynamicsControlRoundness: brush.dynamicsControlRoundness === undefined ? (brush.tiltRoundnessDyn > 0 ? 3 : undefined) : brush.dynamicsControlRoundness,
      dynamicsControlScatter: brush.dynamicsControlScatter,
      dynamicsControlCount: brush.dynamicsControlCount,
      dynamicsControlFlow: brush.dynamicsControlFlow,
      dynamicsFadeSteps: (fade.sizeSteps !== undefined || fade.opacitySteps !== undefined)
        ? Object.assign({}, brush.dynamicsFadeSteps,
            fade.sizeSteps !== undefined ? { size: fade.sizeSteps } : null,
            fade.opacitySteps !== undefined ? { opacity: fade.opacitySteps } : null)
        : brush.dynamicsFadeSteps,
      smoothingStrength: brush.smoothingStrength,
      minRoundnessRatio: brush.minRoundnessRatio,
      opacityJitterPct: brush.opacityJitterPct,
      roundnessJitterPct: brush.roundnessJitterPct,
      tiltJitterPct: brush.tiltJitterPct,
      // ABR has one control source per parameter. Approximate a standalone
      // Procreate tilt amount by its equivalent minimum, never by random jitter.
      minSizeRatio: !pressureSizeOn(brush) && brush.tiltSizeDyn > 0 ? Math.min(brush.minSizeRatio === undefined ? 1 : brush.minSizeRatio, 1 - Math.min(1, brush.tiltSizeDyn)) : brush.minSizeRatio,
      minOpacityRatio: !brush.pressureOpacity && brush.tiltOpacityDyn > 0 ? Math.min(brush.minOpacityRatio === undefined ? 1 : brush.minOpacityRatio, 1 - Math.min(1, brush.tiltOpacityDyn)) : brush.minOpacityRatio,
      angleJitterDeg: brush.source === 'procreate' ? Math.max(0, Math.min(100, (brush.angleJitterDeg || 0) / 1.8)) : (brush.angleJitterDeg || 0),
      sizeJitterPct: brush.sizeJitterPct || 0,
      flowJitterPct: brush.flowJitterPct || 0,
      countJitterPct: brush.countJitterPct || 0,
      scatterOn: !!brush.scatterOn,
      scatterPct: brush.scatterPct || 0,
      scatterBothAxes: !!brush.scatterBothAxes,
      scatterCount: brush.scatterCount || 1,
      flowPct: brush.flowPct === undefined ? 1 : brush.flowPct,
      opacityPct: brush.opacity === undefined ? 1 : brush.opacity,
      dualUuid: synthesizeDual ? genUuid() : (dualChanged && brush.dualBrush ? brush.dualBrush.uuid : undefined),
      dualGray: synthesizeDual ? (function () {
        let t2 = brush.dualTip;
        if (t2 && !t2.rgba && t2.data) {
          const bpp = t2.bpp || 1;
          const rgba = new Uint8Array(t2.w * t2.h * 4);
          for (let i = 0; i < t2.w * t2.h; i++) {
            const a = bpp >= 3 ? Math.max(t2.data[i * bpp], t2.data[i * bpp + 1], t2.data[i * bpp + 2]) : t2.data[i];
            rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = a;
          }
          t2 = { w: t2.w, h: t2.h, rgba: rgba };
        }
        if (!t2 || !t2.rgba) return null;
        /* 副笔尖也必须遵守「笔尖最大边长」：以前直接写原图（Procreate 常见 2048²），
           一个采样就是 4MB，画世界 Pro 导入会在 BrushSectionParser 抛 NPE（实测）。 */
        let w2 = t2.w, h2 = t2.h, rgba2 = t2.rgba;
        const maxSide2 = Math.max(w2, h2);
        if (maxSide2 > maxTip) {
          const sc2 = maxTip / maxSide2;
          const nw2 = Math.max(1, Math.round(w2 * sc2)), nh2 = Math.max(1, Math.round(h2 * sc2));
          rgba2 = png.resize(rgba2, w2, h2, nw2, nh2);
          w2 = nw2; h2 = nh2;
        }
        dualCap.w = w2; dualCap.h = h2;
        return abr.maskFromRGBA(rgba2);
      })() : undefined,
      dualW: synthesizeDual ? (dualCap.w || (brush.dualTip && brush.dualTip.w)) : undefined,
      dualH: synthesizeDual ? (dualCap.h || (brush.dualTip && brush.dualTip.h)) : undefined,
      dualDiameter: brush.dualBrush && brush.dualBrush.diameter ? brush.dualBrush.diameter : undefined,
      dualBlend: (function () {
        const m = brush.dualBlendMode;
        const numMap = { 0: 'normal', 1: 'darken', 2: 'multiply', 3: 'colorBurn', 4: 'linearBurn', 5: 'lighten', 6: 'screen', 7: 'hardMix', 8: 'overlay', 9: 'softLight', 10: 'hardLight', 11: 'difference' };
        if (typeof m === 'number') return numMap[m] || 'hardMix';
        return m || 'hardMix';
      })(),
      dualName: (brush.dualBrush && brush.dualBrush.name) || ((brush.name || 'brush') + ' 2'),
      dualInfo: brush.dualBrush,
      hardness: brush.hardness,
      wetEdgesOn: !!brush.wetEdgesOn,
      wetEdgesAmount: brush.wetEdgesAmount,
      noise: !!brush.noise,
      buildUp: !!brush.buildUp,
      poseOn: !!brush.poseOn,
      poseAngle: brush.poseAngle,
      poseTiltX: brush.poseTiltX,
      poseTiltY: brush.poseTiltY,
      posePressure: brush.posePressure,
      wetnessDynamics: brush.wetnessDynamics,
      mixDynamics: brush.mixDynamics,
      colorDynamicsOn: !!brush.colorDynamicsOn,
      colorJitterFgBg: brush.colorJitterFgBg,
      /* 第262轮：颜色动态控制源/最小值透传（abr.js 写侧 clVr 的 bVTy/Mnm 回填用） */
      dynamicsControlColor: brush.dynamicsControlColor,
      colorMinRatio: brush.colorMinRatio,
      colorPerTip: brush.colorPerTip,
      colorJitterHue: brush.colorJitterHue,
      colorJitterSat: brush.colorJitterSat,
      colorJitterVal: brush.colorJitterVal,
      colorJitterPurity: brush.colorJitterPurity,
      psTexture: usePsTexture,
      patternRef: patternRef,
      textureDepth: brush.textureDepth,
      textureScale: brush.textureScale,
      textureBlendMode: (function () {
        if (brush.textureBlendMode) return brush.textureBlendMode;
        if (typeof brush.grainBlendMode === 'number' && isFinite(brush.grainBlendMode)) {
          const pcToPs = { 0: 'Nrml', 1: 'Mltp', 2: 'Drkn', 3: 'CBrn', 4: 'LBrn', 5: 'Lghn', 6: 'ScrN', 7: 'HrdM', 8: 'Ovrl', 9: 'SftL', 10: 'HrdL', 11: 'Dfrn', 12: 'Excl', 13: 'H   ', 14: 'Strt', 15: 'Colr', 16: 'Lmns', 19: 'LnrL', 20: 'VlLt', 21: 'PnLt' };
          return pcToPs[Math.round(brush.grainBlendMode)];
        }
        return undefined;
      })(),
      textureEnabled: !!brush.hasTexture,
      // PatternRef 里的 .pat 已经烘入了“是否需要反转”（inversionBaked），所以只要引用了它，
      // InvT 就必须是 false；否则 PS 会把已反转的图案再反转一次，纹理回到未反转原貌。
      // 以前多了 !willUseRaw 前置，只修了非 raw 重建路径，漏了 raw 源「改了参数→走重建」的兄弟路径（#260）。
      textureInverted: effectiveTextureInverted,
      // 源就是 ABR 时，保留原始描述符/样本字节（部分导出也能保住 PS 原版特性）
      rawPreset: keepRaw ? brush._rawPreset : undefined,
      rawPatchPaths: Array.from(paths), mainTipChanged:tipChanged,
      rawSample: keepRaw && !tipChanged ? brush._rawSample : undefined,
      /* 【第287轮 R270-02】保留原 preset（computedBrush 这类），而源**本来就没有**采样条目时，
         明确告诉写侧「别合成样本」：否则每支 computedBrush 都会被塞进一张 500×500 灰度图（实测整包
         41396B → 258056B），而 desc 里根本没有任何 sampledData 指向它。 */
      noSample: !!(keepRaw && !tipChanged && brush._rawPreset && !brush._rawSample),
      keepSampleUuids: keepRaw && !dualTipChanged && brush.dualBrush && brush.dualBrush.uuid ? [brush.dualBrush.uuid] : [],
      sampleMap: brush._sampleMap,
      rawDualObjc: keepRaw ? brush._rawDualObjc : undefined,
      rawDualChanged:dualChanged || dualTipChanged,
      dualOn: !!brush.dualOn,
      rle: opts.abrRle !== false,
      uuid: (opts.abrUuids && opts.abrUuids[i]) || (keepRaw && !tipChanged && brush._rawPreset ? brush.uuid : undefined)
    });
  }

  /* 【第287轮 R287-01】挑出「这批笔刷真正引用到的」纹理图案记录。
   * 以前的做法：合计超过 32MB 就**整块丢弃**（只留一条 console.warn）。实测代价很大 ——
   * `个人用.abr` 503 支改一支尺寸导出时，patt 段 149,558,936B → 196,884B，纹理图案全没了。
   * 而 PS 自己导出的这个源文件本来就是**一个 149MB 的 patt 段**，说明「32MB 上限」是我们自己的
   * 保守猜测，不是格式限制。现在照写：体积大只提示（PS 首次载入会慢），不再丢东西。
   * 只有「一条记录都没精确匹配到、但源里有整块 patt」时才退回保留源块（否则 Txtr 引用会悬空）。
   */
  const ABR_PATT_NOTICE_BYTES = 32 * 1024 * 1024;
  function selectAbrPatterns(brushList, opts) {
    const out = { records: null, block: null, warning: null, bytes: 0 };
    if (opts && opts.preserveRaw === false) return out;
    const seen = Object.create(null);
    const picked = [];
    for (const b of (brushList || [])) {
      const rec = b && b._patternRecord;
      if (!rec || !rec.data) continue;
      const key = (rec.id || '') + '|' + (rec.name || '');
      if (seen[key]) continue;
      seen[key] = 1;
      picked.push(rec);
    }
    if (picked.length) {
      let total = 0;
      for (const r of picked) total += r.data.length;
      out.records = picked;
      out.bytes = total;
      if (total > ABR_PATT_NOTICE_BYTES) {
        out.warning = '引用的纹理图案合计 ' + Math.round(total / 1048576) + 'MB，已随包写出（原来会整块跳过；体积大时 PS 首次载入会慢一些）';
      }
      return out;
    }
    const withPatt = (brushList || []).find(function (b) { return b && b._pattBlock && b._pattBlock.length; });
    if (withPatt) {
      out.block = withPatt._pattBlock;
      out.bytes = withPatt._pattBlock.length;
      if (out.bytes > ABR_PATT_NOTICE_BYTES) {
        out.warning = '源文件的纹理图案块 ' + Math.round(out.bytes / 1048576) + 'MB，已原样随包写出（原来超过 32MB 会被丢掉）';
      }
    }
    return out;
  }

  /* 【第285轮】条目就绪后的收尾：分组、图案块、写容器（原 makeAbrPack 后半段原样搬移） */
  function abrPackFinalize(items, brushList, opts) {
    if (!items.length) throw new Error('没有可写入 ABR 的笔刷');
    // 文件夹分组：按笔刷顺序把同组连续笔刷折叠成 phry token（组名/数量）
    const groups = [];
    let cur = null;
    for (const b of brushList) {
      const g = b.group || '';
      if (!cur || cur.name !== g) { cur = { name: g, count: 0 }; groups.push(cur); }
      cur.count++;
    }
    const hasNamed = groups.some(function (g) { return !!g.name; });
    const pat = selectAbrPatterns(brushList, opts);
    const bytes = abr.writeAbrV6(items, { groups: hasNamed ? groups : null, patternBlock: pat.block, patternRecords: pat.records, allowSubOneSpacing: !!opts.allowSubOneSpacing });
    if (pat.warning && !opts._patternWarned) { opts._patternWarned = true; console.warn(pat.warning); }
    return { bytes: bytes, count: items.length, meta: items, patternWarning: pat.warning || null, patternBytes: pat.bytes || 0 };
  }

  function makeAbrPack(brushList, opts) {
    opts = opts || {};
    const pass = abrPackPassthrough(brushList, opts);
    if (pass) return pass;
    // 重名会让 Photoshop 导入时去重/合并，导致预设与采样错位（画出来变成别的笔刷），
    // 这里统一给重名加序号
    const names = uniqueNames(brushList);
    const items = [];
    brushList.forEach(function (source, i) { items.push(abrPackItem(source, i, names, opts)); });
    return abrPackFinalize(items, brushList, opts);
  }

  async function abrPackFinalizeAsync(items, brushList, opts, hooks) {
    const groups = [];
    let cur = null;
    for (const b of brushList) {
      const g = b.group || '';
      if (!cur || cur.name !== g) { cur = { name: g, count: 0 }; groups.push(cur); }
      cur.count++;
    }
    const hasNamed = groups.some(function (g) { return !!g.name; });
    const pat = selectAbrPatterns(brushList, opts);
    const bytes = await abr.writeAbrV6Async(items,
      { groups: hasNamed ? groups : null, patternBlock: pat.block, patternRecords: pat.records, allowSubOneSpacing: !!opts.allowSubOneSpacing },
      { shouldAbort: hooks && hooks.shouldAbort, yieldTick: yieldTick });
    if (pat.warning && !opts._patternWarned) { opts._patternWarned = true; console.warn(pat.warning); }
    return { bytes: bytes, count: items.length, meta: items, patternWarning: pat.warning || null, patternBytes: pat.bytes || 0 };
  }

  /* 【第285轮 / 第304轮】可取消的 ABR 整包：逐支 await 且写容器阶段也走 writeAbrV6Async
     （在 samp 编码、desc 编码与最终合包各阶段定期让出线程并检查 shouldAbort），输出与同步版逐字节一致。 */
  async function makeAbrPackAsync(brushList, opts, hooks) {
    opts = opts || {};
    hooks = hooks || {};
    const pass = abrPackPassthrough(brushList, opts);
    if (pass) {
      if (hooks.onBrush) hooks.onBrush(brushList.length - 1, brushList.length, null);
      return pass;
    }
    const names = uniqueNames(brushList);
    const items = [];
    const total = brushList.length;
    for (let i = 0; i < total; i++) {
      if (hooks.shouldAbort && hooks.shouldAbort()) {
        const err = new Error('已取消');
        err.code = 'ABORTED';
        throw err;
      }
      /* 与 makeBruPackAsync 同一约定：onBrush(i, total, name) 0 基索引，帧间 await yieldTick 让出线程 */
      await yieldTick();
      items.push(abrPackItem(brushList[i], i, names, opts));
      if (hooks.onBrush) hooks.onBrush(i, total, names[i]);
    }
    return await abrPackFinalizeAsync(items, brushList, opts, hooks);
  }

  /** Supported import route documented by Udonman/CELSYS: ABR, not renamed SUT. */
  function makeTplPack(brushList, opts) {
    opts=opts||{};
    const textured=brushList.filter(b=>b.hasTexture&&textureGray(b));
    const pattern=opts.textureMode!=='bake'&&textured.length?makePatternFile(textured,{}):null;
    const settings=Object.assign({},opts,{textureMode:opts.textureMode==='bake'?'bake':'pattern',patternRefs:pattern?pattern.refs:undefined,patternRef:undefined});
    const made=makeAbrPack(brushList,settings);
    return {bytes:tpl.fromAbr(made.bytes,brushList,pattern&&pattern.bytes),count:made.count,
      warnings:['TPL 请从 Photoshop「工具预设」面板载入；跨软件的混色、擦除等工具行为需要在 PS 实际核对']};
  }

  /** Supported import route documented by Udonman/CELSYS: ABR, not renamed SUT. */
  function makeUdongmanPack(brushList, opts) {
    opts = opts || {};
    const made = makeAbrPack(brushList, Object.assign({ allowSubOneSpacing: opts.allowSubOneSpacing !== false }, opts));
    made.format = 'abr';
    made.target = 'udongman';
    made.importGuide = [
      '优动漫 PAINT / CLIP STUDIO PAINT：ABR 兼容导入',
      '优动漫 PAINT 1.10.5 及以上：在子工具面板菜单选择「载入子工具」，导入本包 .abr。',
      '不要在画布打开 ABR；导入后选择新笔刷，检查尺寸、间距、双笔和纹理，再对照原笔刷试画。',
      '这是 ABR 兼容格式，不是原生 SUT；不同引擎的动态、混色、双笔和纹理效果可能不同。',
      '需要原生 .sut（单色主笔尖/纹理素材）时请改用「优动漫 CSP 原生 .sut（实验）」目标，并核对其动态与混合限制。',
      '官方说明：https://www.udongman.cn/resource/details/doc/25050',
      'CSP：https://help.clip-studio.com/en-us/manual_en/150_tools/Importing_tools.htm'
    ].join('\n');
    // 前置本目标特有的提醒，但保留 makeAbrPack 自己的警告（纹理烘焙/间距钳位等）
    made.warnings = ['优动漫/CSP通过ABR兼容导入；动态/混色/双笔/纹理效果需在目标软件核对'].concat(made.warnings || []);
    return made;
  }

  /* 通用笔刷模型 → CSP Variant 列值（仅标量；模板缺列由 sutWrite 覆写时报错前过滤）。 */
  /* Effector blob: 48 B neutral (off) or 92 B with a linear pressure curve (on), copied
     from the structure of real CSP exports (三角 ok.sut BrushSizeEffector). */
  function sutEffectorBlob(on, minRatio) {
    const words = on
      ? [48, 240, 16, Math.round(Math.max(0, Math.min(1, minRatio)) * 100), 100, 0, 0, 0, 44, 0, 500, 0,
         12, 2, 16, 0, 0, 0, 0, 1072693248, 0, 1072693248, 0]
      : [48, 240, 0, 0, 100, 0, 0, 0, 0, 0, 500, 0];
    const out = new Uint8Array(words.length * 4), dv = new DataView(out.buffer);
    words.forEach(function (w, i) { dv.setUint32(i * 4, w, false); });
    return out;
  }

  function variantParamsForSut(brush) {
    const clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
    const num = function (v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; };
    const p = {};
    p.BrushSize = clamp(Math.round(num(brush.sizePx, 80)), 1, 4000);
    p.BrushSizeUnit = 0;
    p.BrushInterval = clamp(Math.round(num(brush.spacingPct, 10) * 10) / 10, 1, 1000);
    // 模板 G笔 的原始间距是「自动」（BrushAutoIntervalType=2），此时 CSP 忽略 BrushInterval；
    // 必须切成 0（手动）我们写的间距才生效。
    p.BrushAutoIntervalType = 0;
    p.Opacity = Math.round(clamp(num(brush.opacity, 1), 0, 1) * 100);
    p.BrushFlow = Math.round(clamp(num(brush.flowPct, 1), 0, 1) * 100);
    p.BrushHardness = Math.round(clamp(num(brush.hardness, 1), 0, 1) * 100);
    p.BrushThickness = clamp(Math.round(num(brush.roundness, 100)), 1, 100);
    // CSP native SUT rotation runs opposite to the common/ABR angle.
    let ang = (360 - num(brush.angle, 0)) % 360;
    if (ang < 0) ang += 360;
    p.BrushRotation = ang;
    // Pressure dynamics: every native Variant carries Size/Opacity Effector blobs;
    // header u32[2] bit 0x10 = pressure on, u32[3] = minimum percent (samples: 三角 ok.sut).
    p.BrushSizeEffector = sutEffectorBlob(!!brush.pressureSize, num(brush.minSizeRatio, 0.2));
    p.BrushOpacityEffector = sutEffectorBlob(!!brush.pressureOpacity, num(brush.minOpacityRatio, 0.3));
    // Taper: BrushUseIn / BrushUseOut toggle fade-in / fade-out (lengths in px-like units).
    {
      const explicitEnds = brush.taperStartLength !== undefined || brush.taperEndLength !== undefined;
      p.BrushUseIn = brush.taperOn && (!explicitEnds || num(brush.taperStartLength, 0) > 0) ? 1 : 0;
      p.BrushUseOut = brush.taperOn && (!explicitEnds || num(brush.taperEndLength, 0) > 0) ? 1 : 0;
      if (brush.taperStartLength !== undefined) p.BrushInLength = clamp(Math.round(num(brush.taperStartLength, 0) * 10) / 10, 0, 1000);
      if (brush.taperEndLength !== undefined) p.BrushOutLength = clamp(Math.round(num(brush.taperEndLength, 0) * 10) / 10, 0, 1000);
    }
    /* 双笔刷（副笔）：参考样本 sample_ceshi2.sut（UseDualBrush=1 / DualSize=30 / DualFlow=31 /
       DualHardness=80 / DualInterval=100 / DualSizeUnit=0），单位与主笔一致（0=px）。
       重建时副笔笔尖用 CSP 内置（DualUsePatternImage=0）；任意素材图块写入尚未接入。 */
    const dual = brush.dualOn && (brush.dualBrush || brush.dualTip || brush.dualSubBrush);
    if (dual) {
      const info = brush.dualBrush || {};
      const sub = brush.dualSubBrush || {};
      const mainPx = p.BrushSize;
      let subPx = num(info.diameter, 0);
      if (!subPx && num(info.ratio, 0) > 0) subPx = mainPx * num(info.ratio, 1);
      if (!subPx && num(sub.sizePx, 0) > 0) subPx = sub.sizePx;
      p.UseDualBrush = 1;
      p.DualSizeUnit = 0;
      p.DualSize = clamp(Math.round(subPx || Math.max(1, mainPx * 0.5)), 1, 4000);
      p.DualFlow = Math.round(clamp(num(sub.opacity, num(info.opacity, num(info.flowPct, num(info.flow, 1)))), 0, 1) * 100);
      p.DualHardness = Math.round(clamp(num(info.hardness, num(sub.hardness, 1)), 0, 1) * 100);
      p.DualInterval = clamp(Math.round(num(info.spacing, num(brush.spacingPct, 10)) * 10) / 10, 1, 1000);
      p.DualAutoIntervalType = 0; // 与主笔一致：手动间距，否则 CSP 忽略 DualInterval
      p.DualThickness = clamp(Math.round(num(info.roundness, 100)), 1, 100);
      let dAng = (360 - num(info.angle, num(brush.angle, 0))) % 360;
      if (dAng < 0) dAng += 360;
      p.DualRotation = dAng;
      p.DualUsePatternImage = 0;
      p.DualAdjustFlowByInterval = 0;
      // 合成模式：有源值就透传，否则显式写 0（通常），不要沿用模板的 1——
      // 实测模板默认 1 时画出来只剩副笔/很细，0 才是主副笔正常叠加。
      p.DualBrushCompositeMode = (brush.dualBlendMode !== undefined && isFinite(brush.dualBlendMode))
        ? clamp(Math.round(brush.dualBlendMode), 0, 30) : 0;
    } else {
      p.UseDualBrush = 0;
    }
    return p;
  }

  /** 优动漫 / CSP 原生 .sut 输出：以内嵌「G笔 2」（CSP 5.1.5 自己导出的新版结构）为模板做参数级覆写。
      真实写入：尺寸/间距(手动)/不透明度/流量/硬度/厚扁/旋转 + 笔刷名 + 双笔刷副笔参数（内置圆头副笔尖）。
      已知限制（写入 warnings 与随包说明）：
      · 有图主笔尖/纹理写入原分辨率单色素材；无笔尖图时用 CSP 内置圆形；
      · 副笔素材、彩色素材与复杂纹理混合尚未映射；
      · 压感动态（Effector 曲线 blob）暂未写入，模板里保留中性默认值。 */
  /** 在原生 SUT 上原位改写参数（保留 material.layer 笔尖/纹理、Effector 动态、素材引用）。 */
  function patchNativeSut(nat, opts, name, droppedCols) {
    const bytes = nat.group.bytes;
    const vt = sutVariantTable(bytes);
    if (!vt || !vt.rows.length) throw new Error('原 SUT 没有 Variant 表');
    const originals = csp.parseSut(bytes, nat.group.name).brushes;
    const overrides = [];
    function sameVariant(a, b) {
      return vt.columns.every(function (key) {
        if (key === 'VariantID') return true;
        const x = a[key], y = b[key];
        if (x instanceof Uint8Array && y instanceof Uint8Array) {
          return x.length === y.length && x.every(function (v, i) { return v === y[i]; });
        }
        return x === y;
      });
    }
    nat.members.forEach(function (m) {
      const original = originals.filter(function (b) { return b._rawSutVariantId === m.brush._rawSutVariantId; })[0];
      const row = vt.rows.filter(function (r) { return r.VariantID === m.brush._rawSutVariantId; })[0];
      if (!original || !row) throw new Error('找不到变体在原文件中的 Variant 行');
      const before = variantParamsForSut(original);
      const after = variantParamsForSut(withExportSettings(m.brush, opts));
      const changes = {};
      // Comparing the normalized projections identifies intentional edits.
      // Never round-trip untouched values: native units, subpixel precision,
      // automatic spacing and secondary compensation are not generic defaults.
      Object.keys(after).forEach(function (key) {
        const a = after[key], b = before[key];
        const same = (a instanceof Uint8Array && b instanceof Uint8Array)
          ? (a.length === b.length && a.every(function (v, i) { return v === b[i]; })) : a === b;
        if (!same) changes[key] = a;
      });
      // Minimum changes do not replace the original curve or other controls.
      ['BrushSizeEffector', 'BrushOpacityEffector'].forEach(function (key) {
        const native = row[key], changed = changes[key];
        if (!(native instanceof Uint8Array) || native.length < 16 || !(changed instanceof Uint8Array)) return;
        const src = new DataView(native.buffer, native.byteOffset, native.byteLength);
        const next = new DataView(changed.buffer, changed.byteOffset, changed.byteLength);
        if ((src.getUint32(8, false) & 16) !== (next.getUint32(8, false) & 16)) return;
        const patched = new Uint8Array(native);
        new DataView(patched.buffer).setUint32(12, next.getUint32(12, false), false);
        changes[key] = patched;
      });
      if (changes.BrushSize !== undefined) changes.BrushSizeUnit = after.BrushSizeUnit;
      if (changes.DualSize !== undefined) changes.DualSizeUnit = after.DualSizeUnit;
      if (changes.BrushInterval !== undefined) changes.BrushAutoIntervalType = after.BrushAutoIntervalType;
      if (changes.DualInterval !== undefined) changes.DualAutoIntervalType = after.DualAutoIntervalType;
      const params = filterSutParams(changes, vt.columns, droppedCols);
      // Apply the same edits to exact current/initial copies of this variant,
      // keeping distinct variants and every unedited blob/column unchanged.
      vt.rows.forEach(function (candidate, index) {
        if (sameVariant(row, candidate)) overrides.push({ params: params, variantIndex: index });
      });
      if (m.brush.name !== original.name && nat.group.count === 1) {
        overrides[overrides.length - 1].nodeName = m.brush.name;
      }
    });
    if (!overrides.length) throw new Error('没有可写入的参数');
    return sutWrite.buildSut(bytes, overrides);
  }

  function makeUdongmanSutPack(brushList, opts) {
    opts = opts || {};
    if (!sutWrite || !udongmanTemplate) throw new Error('优动漫原生 SUT 组件未加载（sutWrite/udongmanTemplate）');
    const tpl = udongmanTemplate.getBytes();
    const files = [];
    const nameSeq = {};
    const skipped = [];
    const srcList = Array.isArray(brushList) ? brushList : [];
    const preserved = new Set();
    let rebuiltCount = 0;
    let materialTipCount = 0, writtenTextureCount = 0, missingTextureCount = 0;
    let patchedCount = 0;
    const patchFails = [];
    const droppedCols = [];
    const dualCount = srcList.filter(function (b) { return b && b.dualOn && !b._rawSutGroup; }).length;
    for (const rawBrush of srcList) {
      let name, bytes;
      try {
        const native = rawSutGroup(rawBrush, srcList, opts);
        if (native && preserved.has(native)) continue;
        if (native) {
          preserved.add(native);
          const base = sanitizeName(native.count === 1 ? rawBrush.name : native.name, 0) || 'brush';
          nameSeq[base] = (nameSeq[base] || 0) + 1;
          name = nameSeq[base] > 1 ? base + ' ' + nameSeq[base] : base;
          files.push({name:name + '.sut', data:new Uint8Array(native.bytes)});
          continue;
        }
        const brush = withExportSettings(rawBrush, opts);
        if (!brush) continue;
        // 原生 SUT 被改过：先在原文件上原位改参数，保住笔尖/纹理/动态；
        // 只在结构不支持（旧版本列缺失、强制重建、切换压感）时才退回模板重建。
        // CSP 没有「固定翻转」字段：源带 flipX/flipY 时必须重建（把镜像烘进素材像素），
        // 原位改写会保留原来的笔尖像素，翻转等于没写。
        const hasFlip = !!(brush.flipX || brush.flipY);
        const nat = (!hasFlip && !opts.forceRebuild && opts.fidelity !== false &&
          !/^(on|off)$/.test(String(opts.pressureMode || ''))) ? nativeSutMembers(rawBrush, srcList) : null;
        if (nat && preserved.has(nat.group)) continue;
        const base0 = sanitizeName(nat && nat.group.count > 1 ? (nat.group.name || brush.name) : (brush.name || 'brush'), 0) || 'brush';
        nameSeq[base0] = (nameSeq[base0] || 0) + 1;
        name = nameSeq[base0] > 1 ? base0 + ' ' + nameSeq[base0] : base0;
        if (nat) {
          try {
            bytes = patchNativeSut(nat, opts, name, droppedCols);
            preserved.add(nat.group);
            files.push({ name: name + '.sut', data: bytes });
            patchedCount++;
            continue;
          } catch (e) {
            patchFails.push((rawBrush && rawBrush.name || '未命名') + '：' + e.message);
          }
        }
        let tip = tipToRGBA(brush);
        // 固定翻转烘进笔尖素材（CSP 侧没有翻转开关，素材像素就是唯一载体）
        if (tip && hasFlip) {
          const flipped = withFixedTipFlips({ tip: { w: tip.w, h: tip.h, rgba: tip.rgba }, flipX: !!brush.flipX, flipY: !!brush.flipY });
          tip = tipToRGBA(flipped);
        }
        if (tip) cspMaterial.validateSource(tip.w,tip.h,tip.rgba,4);
        if (brush.hasTexture) {
          const pp=brush._patternPixels,g=brush._grainRgba;
          if (pp && pp.w>0) cspMaterial.validateSource(pp.w,pp.h,pp.data,pp.mode===3?3:1);
          else if (g && g.w>0) cspMaterial.validateSource(g.w,g.h,g.rgba,4);
        }
        const texture = brush.hasTexture ? textureGray(brush) : null;
        if (tip || texture) {
          bytes = cspMaterial.build({name:name,params:variantParamsForSut(brush),
            tip:tip ? {w:tip.w,h:tip.h,mask:abr.maskFromRGBA(tip.rgba)} : null,
            texture:texture ? {w:texture.w,h:texture.h,mask:texture.gray} : null,
            textureDensity:Math.round(Math.max(0,Math.min(1,brush.textureDepth===undefined?1:brush.textureDepth))*100),
            textureScale:Math.max(1,Math.min(2000,(brush.textureScale===undefined?1:brush.textureScale)*100))});
          if(tip)materialTipCount++;
          if(texture)writtenTextureCount++;
        } else {
          bytes = sutWrite.buildSut(tpl, [{params:variantParamsForSut(brush),nodeName:name}]);
        }
        if(brush.hasTexture && !texture)missingTextureCount++;
      } catch (e) {
        // 单支失败不拖垮整包（#283）：跳过并记录，其余笔刷照常导出
        skipped.push((rawBrush && rawBrush.name || '未命名') + '：' + e.message);
        continue;
      }
      files.push({ name: name + '.sut', data: bytes });
      rebuiltCount++;
    }
    if (!files.length) {
      throw new Error(skipped.length
        ? '没有可导出的笔刷（' + skipped.slice(0, 3).join('；') + (skipped.length > 3 ? ' 等 ' + skipped.length + ' 支' : '') + '）'
        : '没有可导出的笔刷');
    }
    const warnings = rebuiltCount ? [
      '优动漫原生 .sut（实验）：尺寸/间距(手动)/不透明度/流量/硬度/厚扁/旋转已写入；有图主笔尖和纹理写入单色素材，无笔尖图时用内置圆形；压感动态、彩色与复杂混合仍需核对'
    ] : [];
    if (patchedCount) warnings.push('已修改的原生 SUT 在原文件上改写参数，笔尖、纹理、压感/角度动态与素材引用保持不变');
    if (patchFails.length) warnings.push('部分原生 SUT 无法原位改写，已退回模板重建（只写可读素材，原生动态不保留）：' + patchFails.slice(0, 3).join('；'));
    if (droppedCols.length) warnings.push('原 SUT 缺少列，未写入：' + droppedCols.slice(0, 8).join('、') + (droppedCols.length > 8 ? ' 等' : ''));
    if (materialTipCount) warnings.push('SUT 目标：' + materialTipCount + ' 支主笔尖已写入真实单色素材图块，保留原图分辨率；不代表动态和混合完全还原');
    if (writtenTextureCount) warnings.push('SUT 目标：' + writtenTextureCount + ' 支纹理已写入独立素材；强度/比例为跨软件近似，需在目标软件核对');
    if (missingTextureCount) warnings.push('SUT 目标：' + missingTextureCount + ' 支带纹理笔刷缺少可读纹理图片，纹理未写入，导入后可手动添加');
    if (dualCount) warnings.push('SUT 目标：' + dualCount + ' 支双笔刷已写入副笔参数（尺寸/流量/硬度/间距/角度），副笔笔尖用 CSP 内置圆形');
    if (skipped.length) warnings.unshift('已跳过 ' + skipped.length + ' 支无法写出 SUT 的笔刷：' + skipped.slice(0, 5).join('；') + (skipped.length > 5 ? ' 等' : ''));
    return {
      files: files,
      count: files.length,
      bytes: files.length ? files[0].data : new Uint8Array(0),
      fileName: files.length ? files[0].name : 'brush.sut',
      format: 'sut',
      target: 'udongman_sut',
      importGuide: !rebuiltCount ? (patchedCount
        ? '原生 SUT 参数级导出：在原始文件上改写尺寸/间距/不透明度/流量/硬度/厚扁/旋转，笔尖、纹理、动态和素材引用保持原样。在 CLIP STUDIO PAINT / 优动漫子工具面板中载入 .sut。'
        : '原生 SUT 未改动，已原样保留笔尖、纹理、动态及全部文件内容。在 CLIP STUDIO PAINT / 优动漫子工具面板中载入 .sut。') : [
        '优动漫 PAINT / CLIP STUDIO PAINT：原生 SUT 导入（实验性）',
        '1）解压后得到若干 .sut（每支笔刷一个文件）',
        '2）优动漫 PAINT：子工具面板 → 面板菜单 → 「载入子工具」，选择 .sut 导入（也可把 .sut 直接拖进子工具面板）',
        '3）导入后选中笔刷先试画核对',
        '',
        '重要说明（参数级导出的已知限制）：',
        '· 尺寸/间距（手动间距）/不透明度/流量/硬度/厚扁/旋转等参数已真实写入',
        '· 有图主笔尖/纹理写入独立单色素材，保留原图分辨率（上限4096×4096）；没有笔尖图时使用内置圆形',
        '· 彩色素材未映射；纹理强度/比例属于近似，复杂混合效果需在目标软件核对',
        '· 双笔刷：副笔的尺寸/流量/硬度/间距/角度会写入，副笔笔尖为内置圆形（尚未写入素材副笔尖）',
        '· 压感/角度等动态曲线暂未写入，导入后需按实际效果调整',
        '官方说明：https://www.udongman.cn/resource/details/doc/25050'
      ].join('\n'),
      warnings: warnings
    };
  }

  /** 优动漫 .mtd（绘画助手素材包）：把生成的 .sut 打进 zip 壳，双击可被绘画助手识别导入。
   *  实验性：官方 mtd 亦可能为「素材文件夹」形态（catalog.xml+加密 material.layer），
   *  该形态因 C2F 加密无法程序化生成参数，此处不做；zip+sut 形态未真机验证。 */
  function makeUdongmanMtdPack(brushList, opts) {
    const inner = makeUdongmanSutPack(brushList, opts);
    if (!inner.files.length) throw new Error('没有可导出的笔刷');
    const entries = inner.files.map(function (f) { return { name: f.name, data: f.data }; });
    const bytes = zip.write(entries);
    return {
      bytes: bytes,
      files: [{ name: 'brushes.mtd', data: bytes }],
      count: inner.count,
      fileName: (inner.fileName || 'brush.sut').replace(/\.sut$/i, '.mtd'),
      format: 'mtd',
      target: 'udongman_mtd',
      importGuide: [
        '优动漫 PAINT：.mtd 绘画助手素材包导入（实验性）',
        '1）双击 .mtd（需已安装优动漫「绘画助手」），或打开绘画助手 → 素材 → 本地管理 → 导入',
        '2）导入成功后素材出现在优动漫 PAINT 的素材库「下载」分类',
        '3）笔刷素材：素材面板拖到子工具面板即可使用；导入后先试画核对',
        '',
        '重要说明：',
        '· 包内为 .sut（同「优动漫 CSP 原生 .sut」目标的限制）：有图主笔尖/纹理写入单色素材，无笔尖图时用内置圆形，压感动态暂不写入',
        '· 此导出未经优动漫官方真机验证；如绘画助手拒绝导入，请改用「优动漫 CSP 原生 .sut」直接拖入子工具面板，或「优动漫 CSP .abr（兼容）」目标'
      ].join('\n'),
      warnings: [
        '优动漫 .mtd（实验）：zip+sut 壳，未经真机导入验证；素材/参数限制同 .sut 目标'
      ].concat(inner.warnings || [])
    };
  }

  // The BRU stamp's texture contributes to its coverage. The Procreate grain
  // layer cannot reproduce this compositing with an untextured round tip.
  function usesBruDabTexture(brush, opts) {
    return brush.source === 'bru' && brush.bruProceduralTip && brush.bruTexturePerTip &&
      !brush.tip && brush._rawBruTexture && brush.hasTexture && opts.noTextureBake !== true && opts.grainBake !== false;
  }

  function appSavedSmoothing(brush, fields) {
    // In 3.4.5 an omitted f80 displays 0%. Honour explicit edits made
    // after parsing, even though the legacy BRU reader defaults to 0.2.
    return fields && !fields.includes(80) && brush.smoothingStrength === (brush._rawState || {}).smoothingStrength
      ? 0 : brush.smoothingStrength;
  }
  function withSavedLayerSmoothing(brush, metadata) {
    if (!metadata || brush.bruProtoVer !== 31 || !(brush._nativeArchiveBackup || brush._procreateDualBridge)) return brush;
    const smoothingStrength = appSavedSmoothing(brush, bruFieldNumberSet(metadata));
    return smoothingStrength === brush.smoothingStrength ? brush : Object.assign({}, brush, {smoothingStrength});
  }
  function appSavedChanges(brush, previous, native, fields) {
    const changes = {};
    if (brush.bruColor !== previous.bruColor) changes.brushConvBruColor = brush.bruColor;
    if (brush.hollowColor !== previous.hollowColor) changes.brushConvBruHollowColor = brush.hollowColor;
    const smooth = appSavedSmoothing(brush, fields);
    if (Math.fround(smooth) !== previous.smoothingStrength) {
      if (smooth > previous.smoothingStrength) changes.plotSmoothing = smooth;
      else for (const key of ['plotSmoothing','plotMovingAverageStabilization','plotFFTSmoothingAmount']) {
        if (Number(native[key]) > smooth) changes[key] = smooth;
      }
    }
    return changes;
  }
  function verifiedLibraryReference(brush, library) {
    if (!library) return null;
    if (library.version !== 2) return dualBridgeState(brush) === library.fingerprint ? library : null;
    if (libraryBridgeState(brush) === library.fingerprint) return library;
    const fields = bruFieldNumberSet(brush._rawMeta);
    if (brush.bruProtoVer !== 31 || !fields || fields.includes(19) || fields.includes(80)) return null;
    // Native sharing replaces the default palette and omits zero-valued controls.
    // Validate the original layer, including all tip and texture pixels. Only the
    // source materials come from the backup; current drawing controls stay live.
    const previous = Object.assign({}, brush, {bruColor:-1, hollowColor:-1,
      bruLegacyDirection:brush.bruLegacyDirection ?? false, smoothingStrength:0});
    return libraryBridgeState(previous) === library.fingerprint ? library : null;
  }
  // Huashijie 3.4.5 writes the current palette on export and omits disabled
  // flags. Reconstruct the old BRU state only to verify all other controls
  // and pixels. The returned preset keeps the values observed on the device.
  function mergeAppSavedDual(brush, state, original, opts) {
    const fields = bruFieldNumberSet(brush._rawMeta);
    if (!fields || fields.includes(119) || brush.bruDualEnabled !== undefined || brush.bruDualRefUuid || brush.dualOn ||
        !Number.isInteger(state.bruColor) || !Number.isInteger(brush.bruColor) ||
        !Number.isInteger(brush.hollowColor) || !Number.isFinite(brush.smoothingStrength)) return false;
    const previous = Object.assign({}, brush, {
      bruColor: state.bruColor, hollowColor: original.hollowColor ?? -1,
      bruDualEnabled: false, bruLegacyDirection: brush.bruLegacyDirection ?? false,
      smoothingStrength: Math.fround(original.smoothingStrength)
    });
    if (dualBridgeState(previous) !== state.fingerprint) return false;
    const archive = eligibleNativeArchive(previous, opts, false) || original._rawArchive;
    const native = plist.unarchive(archive);
    const changes = appSavedChanges(brush, previous, native, fields);
    original._rawArchive = Object.keys(changes).length ? bplist.patchKeyedArchive(archive, changes) : archive;
    return true;
  }

  function sharedLayerArchive(brush, metadata, opts, isSecondary) {
    const saved = brush._nativeArchiveBackup, scalar = brush._pcScalar;
    const fields = bruFieldNumberSet(metadata);
    if (!saved || !scalar || !fields || !brush._rawState ||
        !Number.isInteger(brush.bruColor) || !Number.isInteger(brush.hollowColor)) return null;
    const native = plist.unarchive(saved.archive);
    const previous = Object.assign({}, brush, {
      bruDualRefUuid:saved.state.link, bruDualEnabled:saved.state.enabled,
      bruLegacyDirection:brush.bruLegacyDirection ?? false,
      bruColor:native.brushConvBruColor ?? -1, hollowColor:native.brushConvBruHollowColor ?? -1,
      smoothingStrength:Math.fround(Math.max(native.plotSmoothing || 0, native.plotMovingAverageStabilization || 0, native.plotFFTSmoothingAmount || 0)),
      sizePx:scalar.baseline.sizePx, spacingPct:scalar.baseline.spacingPct
    });
    // Sharing a linked sub-brush exposes its active diameter and its adjustable
    // maximum (f12) independently. Only reconstruct the old maximum to verify
    // the fingerprint, then apply the current value to the verified archive.
    const sourceRange = isSecondary && scalar.sizeValid && fields.includes(12) && procreate.nativeSizeRange(native);
    const canResize = sourceRange && sourceRange.slider <= 1 && procreate.nativeSizeDiameter(sourceRange,1) > 0 &&
      Math.round(sourceRange.high * 256) === scalar.baseline.maxSizePx && Number.isFinite(brush.maxSizePx) &&
      brush.sizePx > 0 && brush.maxSizePx >= brush.sizePx &&
      ['minSizeRatio','pressureSize','pressure','spacingPct'].every(key => brush[key] === scalar.baseline[key]);
    if (canResize) previous.maxSizePx = scalar.baseline.maxSizePx;
    let archive = eligibleNativeArchive(previous, opts, false);
    // Sharing also elides a zero f33. The legacy reader supplies 100 when it is
    // absent. Try the old explicit zero only for validation against all pixels
    // and controls; an edited texture contrast must keep the normal writer.
    if (!archive && !fields.includes(33) && brush.textureContrast === 100 && brush.textureContrast === brush._rawState.textureContrast) {
      previous.textureContrast = 0;
      archive = eligibleNativeArchive(previous, opts, false);
    }
    if (!archive) return null;
    const changes = appSavedChanges(brush, previous, native, fields);
    const resizeInRange = canResize && (brush.sizePx !== previous.sizePx || brush.maxSizePx !== previous.maxSizePx);
    if (!resizeInRange && brush.sizePx === previous.sizePx && brush.spacingPct === previous.spacingPct) {
      return Object.keys(changes).length ? bplist.patchKeyedArchive(archive, changes) : archive;
    }
    const before = Object.assign({}, brush, {sizePx:previous.sizePx, maxSizePx:previous.maxSizePx, spacingPct:previous.spacingPct});
    return procreate.patchArchive(Object.assign({}, brush, {_rawArchive:archive, _rawNormalized:before}), opts, changes,
      resizeInRange ? native : undefined);
  }

  function restoreSharedLinkedBrush(brush, output, opts) {
    const sub = brush.dualSubBrush, saved = brush._nativeArchiveBackup;
    if (!saved || !saved.state.link || saved.state.enabled !== true || saved.state.link === brush.bruDualRefUuid || !allowNativeProcreateRestore(opts) ||
        !brush.dualOn || !brush.bruDualEnabled || !sub || !output.dualSubBrush || !sub._nativeArchiveBackup ||
        brush.bruProtoVer !== 31 || brush.bruDualRefUuid !== brush.pkgId || sub.pkgId !== brush.pkgId ||
        !brush.bruLinkInfo || brush.bruLinkInfo.primary !== brush.bruUuid || brush.bruLinkInfo.packageId !== brush.pkgId ||
        !brush._rawState || brush._rawState.bruDualRefUuid !== brush.bruDualRefUuid || !brush.embeddedTips) return output;
    const stamp = brush.embeddedTips.find(tip => !tip.isSubGrain);
    if (!stamp || !stamp.raw || !sub.tip || !brush.dualTip || !brush._rawTipPng || util.md5(brush._rawTipPng).toUpperCase() !== brush.oldTexId ||
        util.md5(stamp.raw).toUpperCase() !== sub.oldTexId ||
        (brush.dualTip !== sub.tip && util.brushFingerprint({tip:brush.dualTip}) !== util.brushFingerprint({tip:sub.tip}))) return output;
    const selected = procreate.secondaryBrush(brush);
    const layer = Object.assign({}, sub, {tip:{w:sub.tip.w, h:sub.tip.h, rgba:sub.tip.rgba}});
    for (const key of ['name','sizePx','spacingPct','scatterOn','scatterCount','scatterBothAxes','scatterPct']) {
      if (selected[key] !== undefined) layer[key] = selected[key];
    }
    if (brush.embeddedTips.length > 1) {
      const texture = brush.embeddedTips[1];
      if (brush.embeddedTips.length !== 2 || !texture.raw || util.md5(texture.raw).toUpperCase() !== sub.texAssetId) return output;
      layer._rawBruTexture = sub._rawBruTexture || texture.raw;
      layer._grainRgba = sub._grainRgba || {w:texture.w, h:texture.h, rgba:texture.rgba};
    }
    const primaryArchive = sharedLayerArchive(brush, brush._rawMeta, opts);
    const secondaryArchive = primaryArchive && sharedLayerArchive(layer, brush.bruLinkTemplate, opts, true);
    if (!secondaryArchive) return output;
    const result = Object.assign({}, output, {_nativeArchiveRestore:primaryArchive,
      dualSubBrush:Object.assign({}, output.dualSubBrush, {_nativeArchiveRestore:secondaryArchive})});
    const old = layer._pcScalar.baseline;
    if (old.sizePx !== layer.sizePx || old.maxSizePx !== layer.maxSizePx) {
      const {plotSpacing} = plist.unarchive(secondaryArchive);
      const limit = 256 * procreate.nativeSizeRange({plotSpacing,maxSize:16}).high;
      if (Math.max(layer.sizePx,layer.maxSizePx) > limit + 0.5) {
        result._sharedSubSizeWarning = `「${brush.name}」的副笔当前笔径为 ${Math.round(layer.sizePx)} px、可调上限为 ${Math.round(layer.maxSizePx)} px，Procreate 在保存的点距下最多可用 ${Math.round(limit*10)/10} px`;
      }
    }
    return result;
  }

  function procreateExportTip(brush, opts, isSecondary) {
    if (opts.fidelity !== false && brush._rawArchive && !opts.forceRebuild) return brush;
    if (brush.source === 'bru') {
      brush = withSavedLayerSmoothing(brush, brush._rawMeta);
      if (brush.dualSubBrush && brush.bruLinkTemplate) {
        const sub = withSavedLayerSmoothing(brush.dualSubBrush, brush.bruLinkTemplate);
        if (sub !== brush.dualSubBrush) brush = Object.assign({}, brush, {dualSubBrush:sub});
      }
    }
    if (brush.source === 'bru' && brush._pcScalar && opts.fidelity !== false && !opts.noTextureBake) {
      const saved = brush._pcScalar, base = saved.baseline, native = saved.native, restore = {};
      if (opts.pressure === undefined && (opts.sizeScale === undefined || opts.sizeScale === 1) && saved.sizeValid &&
          ['sizePx', 'minSizeRatio', 'maxSizePx', 'pressureSize', 'pressure'].every(k => brush[k] === base[k]))
        Object.assign(restore, {paintSize: native.paintSize, minSize: native.minSize, maxSize: native.maxSize});
      if (!(opts.spacingOverride > 0) && saved.spacingValid && brush.spacingPct === base.spacingPct)
        restore.plotSpacing = native.plotSpacing;
      restoreRenderSettings(brush, saved.render, opts, restore);
      brush = Object.assign({}, brush, { _pcScalarRestore: restore });
    }
    if (brush.source === 'bru' && brush._procreateDualBridge && allowNativeProcreateRestore(opts)) {
      const backup = brush._procreateDualBridge, state = backup.state;
      const same = dualBridgeState(brush) === state.fingerprint;
      const colorEdit = Number.isFinite(state.colorJitterFgBg) && Number.isFinite(brush.colorJitterFgBg) &&
        brush.colorJitterFgBg >= 0 && brush.colorJitterFgBg <= 1 && brush.colorJitterFgBg !== state.colorJitterFgBg &&
        dualBridgeState(Object.assign({}, brush, {colorJitterFgBg:state.colorJitterFgBg})) === state.fingerprint;
      if (same || colorEdit || (brush.bruDualEnabled === undefined && !brush.bruDualRefUuid && !brush.dualOn)) {
        try {
          const entries = zip.read(backup.archive);
          let total = 0;
          const names = new Set(entries.map(function (e) { return e.name; }));
          if (names.size !== entries.length || !names.has('Brush.archive') || !names.has('Sub01/Brush.archive')) throw new Error('invalid bridge assets');
          if (entries.length < 2 || entries.length > 8 || entries.some(function (e) {
            total += e.size;
            return !/^(?:Sub01\/)?(?:Brush\.archive|Shape\.png|Grain\.png|QuickLook\/Thumbnail\.png)$/.test(e.name) ||
              e.size > (e.name.endsWith('Brush.archive') ? 4 * 1024 * 1024 :
                e.name.endsWith('QuickLook/Thumbnail.png') ? PC_PREVIEW_MAX : PC_GRAIN_ASSET_MAX);
          }) || total > PC_DUAL_MAX) throw new Error('invalid bridge assets');
          const usable = entries.filter(function (e) {
            if (!e.name.endsWith('QuickLook/Thumbnail.png')) return true;
            try { return validNativePreview(e.data()); } catch (_) { return false; }
          });
          const archive = usable.length === entries.length ? backup.archive :
            zip.write(usable.map(e => ({name:e.name, data:e.data()})));
          const original = procreate.parse(archive, 'restored.brush', {}).brushes[0];
          if (original && original.dualSubBrush && (same || colorEdit || mergeAppSavedDual(brush, state, original, opts))) {
            if (colorEdit) {
              const key = brush.colorPerTip === false ? 'jitterStrokeSecondary' : 'jitterSecondary';
              const native = plist.unarchive(original._rawArchive);
              if (!Object.prototype.hasOwnProperty.call(native, key)) throw new Error('missing source color field');
              const value = brush.colorPerTip === false ? Math.pow(brush.colorJitterFgBg, 2.2) : brush.colorJitterFgBg;
              original._rawArchive = bplist.patchKeyedArchive(original._rawArchive, {[key]:value});
            }
            if (!same || brush.sizePx !== state.sizePx) {
              for (const layer of [original, original.dualSubBrush]) {
                if (Array.isArray(layer._rawEntries)) layer._rawEntries = layer._rawEntries.filter(e => e.name !== 'QuickLook/Thumbnail.png');
              }
            }
            original._dualBridgeOriginalGrain = true;
            original.dualSubBrush._dualBridgeOriginalGrain = true;
            if (original.dualSubBrush.name === '') original.dualSubBrush._dualBridgeOriginalName = true;
            // Only transfer edits made after BRU export; original Procreate
            // settings remain authoritative when BRU quantization did not change.
            for (const key of ['sizePx', 'name']) {
              if (brush[key] !== state[key] && brush[key] !== undefined) original[key] = brush[key];
            }
            return original;
          }
        } catch (_) { /* Damaged backup: keep the current BRU appearance. */ }
      }
    }
    if (brush.source === 'bru' && opts.fidelity !== false && !opts.noTextureBake) {
      const mark = brush._noShapeMark;
      let lib = verifiedLibraryReference(brush, mark && mark.library);
      let carried = lib && brush._procreateGrainChunk ? brush._procreateGrainChunk : (mark && mark.library && !lib ? null : unchangedProcreateGrain(brush));
      const candidate = brush._procreateGrainChunk;
      if (candidate && candidate.targetTextureAbsent && brush.hasTexture) {
        carried = null;
        lib = null;
      }
      const currentF123 = 1 - brush.textureDepth;
      const target = candidate && candidate.targetSettings;
      const settingsMatch = target && Number.isFinite(target.scale) && Number.isFinite(target.brightness) &&
        Number.isFinite(target.contrast) && Math.abs(brush.textureScale - target.scale) < 1e-5 &&
        Math.abs(brush.textureBrightness - target.brightness) < 1e-5 && Math.abs(brush.textureContrast - target.contrast) < 1e-5 &&
        !!brush.textureInverted === target.inverted && !!brush.bruTexturePerTip === target.perTip &&
        Number(brush.bruTextureBlendMode || 0) === target.blend;
      const textureMatches = candidate && candidate.targetTextureMd5 && brush.hasTexture && brush._rawBruTexture &&
        util.md5(brush._rawBruTexture).toUpperCase() === candidate.targetTextureMd5;
      if (candidate && candidate.targetF123 !== undefined && (!brush.hasTexture ||
          (!brush._rawBruTexture && (!isSecondary || Math.abs(currentF123 - candidate.targetF123) > 1e-6)) ||
          (brush._rawBruTexture && (!textureMatches || !settingsMatch)))) carried = null;
      const editedDepth = candidate && settingsMatch && candidate.targetF123 !== undefined && candidate.targetTextureMd5 &&
        brush.hasTexture && brush._rawBruTexture && util.md5(brush._rawBruTexture).toUpperCase() === candidate.targetTextureMd5 &&
        brush._procreateGrainPixelState === util.brushFingerprint({tip:brush.tip, grain:brush._grainRgba, pattern:brush._patternPixels}) &&
        Number.isFinite(currentF123) && Math.abs(currentF123 - candidate.targetF123) > 1e-6;
      if (editedDepth && carried) {
        carried = Object.assign({}, carried, {params:Object.assign({}, carried.params, {grainDepth:Math.max(0, Math.min(1, 1 - currentF123))})});
      }
      if (lib) {
        const params = Object.assign({}, carried ? carried.params : lib.params);
        if (lib.grainRef) params.bundledGrainPath = lib.grainRef;
        const restored = Object.assign({}, carried || {grain:null,shape:new Uint8Array(0)}, {params, noShape:!!lib.shapeRef, bundledShapePath:lib.shapeRef || undefined});
        let tip = brush.tip;
        if (!lib.shapeRef && carried && carried.shape.length) {
          const shape = procreate.decodeShape({data:function () { return carried.shape; }}, !!carried.shapeInverted);
          if (shape) tip = shape;
        }
        brush = Object.assign({}, brush, {tip, bruShapeRgbOpacity:false, hasTexture:params.grainDepth > 0, textureDepth:params.grainDepth, _carriedProcreateGrain:restored});
      } else if (carried) {
        let tip = brush.tip;
        if (carried.shape.length) {
          const shape = procreate.decodeShape({ data: function () { return carried.shape; } }, false);
          if (shape) tip = shape;
        }
        /* 第340轮（Lead）：以前只在「没有 shape」或「tip 被换掉」时才挂 _carriedProcreateGrain，
           于是 shape 与 tip 恰好相同时 Grain.png 不会被写回——缪斯之梦这种「无 Shape.png、只有 Grain」
           的主笔正好命中最坏分支，转回来颗粒来源就空白。改为只要 chunk 在就挂上。 */
          brush = Object.assign({}, brush, {
            tip, bruShapeRgbOpacity: false, hasTexture: carried.params.grainDepth > 0,
            textureDepth: carried.params.grainDepth, _carriedProcreateGrain: carried
          });

      } else {
        /* 【第348轮（作者：Lead）】精简版（不含 grain chunk）但带了 `bcMK` 标记时：回写必须知道
           「源本来就没有 Shape.png」，否则会凭空补一个合成硬圆、把笔尖改硬。
           这里构一个「只有标记、没有 grain」的 carried —— grainDepth 记 0，所以也不会写 Grain.png
           （精简版本来就不背 grain 原图，那是 74MB 的取舍）。 */
        if (mark && !mark.library && (mark.noShape || mark.bundledShapePath)) {
          brush = Object.assign({}, brush, {
            hasTexture: false, textureDepth: 0,
            _carriedProcreateGrain: {
              grain: null, shape: new Uint8Array(0), params: { grainDepth: 0 },
              noShape: mark.noShape === true, bundledShapePath: mark.bundledShapePath, chunk: null
            }
          });
        }
      }
      const sub = brush.dualSubBrush;
      if (!isSecondary && sub && (sub._procreateGrainChunk || sub._pcScalar || sub._noShapeMark)) {
        const restored = procreateExportTip(prepareBruForCrossFormat(sub), opts, true);
        if (restored._carriedProcreateGrain || restored._pcScalarRestore) brush = Object.assign({}, brush, { dualSubBrush: restored, dualTip: restored.tip });
      }
    }
    if (brush.source === 'bru' && (!brush.tip || brush._tipFromBuiltin === brush.oldTexId)) {
      const builtinRef = builtinTipKey(brush);
      if (builtinRef) brush = Object.assign({}, brush, { _bruBuiltinTipRef: builtinRef });
    }
    const tip = tipToRGBA(brush);
    if (tip) return Object.assign({}, brush, { tip });
    const shape = Object.assign({}, brush, { angle: 0, roundness: 100 });
    if (!usesBruDabTexture(brush, opts)) {
      return Object.assign({}, brush, { tip: synthTip(shape, 256, opts) });
    }
    const texture = textureGray(brush);
    if (!texture) return Object.assign({}, brush, { tip: synthTip(shape, 256, opts) });
    const brightnessBlend = brush.bruTextureBlendMode === 14;
    const histogram = new Uint32Array(256);
    for (const value of texture.gray) histogram[brightnessBlend ? 255 - value : value]++;
    // Suppress the background of a photographic grain so each dab keeps its
    // particles and has transparent gaps. The brightness mode uses dark grain
    // details as ink on a light canvas, observed in the BRU reference strokes.
    let background = 0;
    let total = histogram[0];
    const cutoff = texture.gray.length * (brightnessBlend ? 0.55 : 0.15);
    while (total < cutoff && background < 254) total += histogram[++background];
    if (background >= 254) return Object.assign({}, brush, { tip: synthTip(shape, 256, opts) });
    /* 【第219轮】曲线口径分两种：
       · 亮度混合（f14/亮度）：源纹理是「浅底 + 深色细节」，投影到笔尖时要压掉底色、拉对比，
         所以走 level² 的平方曲线（22 支实测已还原，保持原样）；
       · 其它混合（正片叠底/正常）：纹理本身已经是「墨在透明底上」，平方曲线会把本来就很暗的
         亮点再压一次。楠.bru「35亮片闪光粉粒效果」实测：纹理反相后 mean 4.78 / cov 9.96% / p99 157，
         平方曲线输出 mean 1.39 / cov 3.70% / p99 59（缩略图里几乎看不到亮片，用户报「还是没还原」），
         改走线性后 mean 4.12 / cov 9.94% / p99 135，与源纹理一致。 */
    const curve = new Uint8Array(256);
    const brightness = Number.isFinite(brush.textureBrightness) && brush.textureBrightness !== 51 ? brush.textureBrightness / 200 : 0;
    const contrast = Number.isFinite(brush.textureContrast) && brush.textureContrast !== 100 ? brush.textureContrast / 100 : 0;
    for (let i = background + 1; i < curve.length; i++) {
      const level = (i - background) / (255 - background);
      const adjusted = Math.max(0, Math.min(1, level * (1 + contrast + brightness)));
      curve[i] = Math.round(255 * (brightnessBlend ? adjusted * adjusted : adjusted));
    }
    /* 【第223轮】按需取采样边长，不再一律 2048。

       第199轮固定 512 把 241 支大笔尖压糊，第221轮改成固定 2048 又走向另一个极端：

       楠.bru 59 支全部 maxW=500、sizePx 最大 499，源纹理最大 840，却每支都生成 2048² 的

       Shape.png（59 个共 36.5MB，整个 brushset 45MB）。Shape 的分辨率只需要覆盖

       「源纹理细节」和「笔刷最大显示尺寸」两者的较大值，超过就是纯浪费。

       上限仍是 Procreate 的 2048。 */

    const capTip = Math.max(64, Math.min(2048, opts.maxTipSize || 2048));

    const needTip = Math.max(texture.w, texture.h, brush.maxSizePx || 0, brush.sizePx || 0);

    const side = Math.max(64, Math.min(capTip, needTip));
    const scale = Math.max(0.02, Math.min(20, brush.textureScale || 1));
    const sampleSpan = Math.max(texture.w, texture.h) / scale;
    const sampleAxis = function (pixel, length) {
      const coord = 0.5 + ((pixel + 0.5) / side - 0.5) * sampleSpan / length;
      return Math.min(length - 1, Math.floor((coord - Math.floor(coord)) * length));
    };
    const sampleX = new Uint32Array(side);
    for (let x = 0; x < side; x++) sampleX[x] = sampleAxis(x, texture.w);
    /* 【第220轮】逐笔尖纹理（f99=1 / bruTexturePerTip）是「落墨遮罩」：白 = 满墨，Dab 就是纹理本身。
       原版 楠.bru #56~#59（34/35/36/37亮片）的 _grainRgba 是 840×840、alpha 全 255、RGB 均值 250.2
       （大面积白 + 稀疏暗点），画出来是用户截图里的「块」。
       旧实现按「照片类纹理」处理：先按 f29 反转、再压 background、再套亮度/对比度曲线、最后乘一层
       圆形 synthTip 遮罩 —— 实测把墨压掉 96%（sampled 均值 4.76 → stamp cov 7.60% → 往返后 4.0%/3.1），
       变成「稀疏颗粒」。这里对非亮度混合的逐笔尖纹理改成**正相直通**：
         · 用未反转的纹理覆盖率（REVERSETEX 只影响独立的纹理层，不影响逐笔尖落墨遮罩）
         · 不压 background、不做亮度/对比度曲线、不乘圆盘遮罩
       亮度混合（f14）那条分支是第198/219轮为「浅底+深色细节」定的，保持原样不动。 */
    /* 【第222轮】亮度混合（f14）也并入正相直通。判据不是混合模式，而是「这颗纹理是不是笔尖落墨遮罩」：

       usesBruDabTexture 为真时白=满墨、Dab 就是纹理本身，压背景和平方曲线都会吃掉浅底。

       楠.bru 里 34/35/36/37（f2）先前已修成块状，而 6/12/19/33 等 f14 的仍是稀疏颗粒——同一批笔刷被分成两种样子。

       实测 idx54「33亮片」源纹理 m232 c100%，旧平方曲线只出 m14.8 c15%，直通后恢复浅底满墨。

       f14 的平方曲线保留在下方（已不可达），作为需要时改回来的对照。 */

    {
      /* 【第282轮·性能】这段是「2048² 逐像素」热点。两点改动：
         ① 一次 Uint32 写整像素（替代 4 次字节写）；
         ② 填充时顺手记最大 alpha，省掉后面再扫一遍 4·side² 的 `.some()`。
         ⚠ 对照方法：导出字节里含**随机 UUID**（同一输入两次跑 md5 都不同），所以不能拿整文件
         做基准；这里只比 **tip 像素 md5**（67 支笔刷前后完全一致）。
         另外第一版把 `0xffffffff | (a<<24)` 当遮罩写，按 int32 解释 -1 会把 alpha 钉成 255——已修。 */
      const rawGray = new Uint8Array(texture.gray.length);
      for (let i = 0; i < rawGray.length; i++) rawGray[i] = brush.textureInverted ? 255 - texture.gray[i] : texture.gray[i];
      const flat = new Uint8Array(side * side * 4);
      const flat32 = new Uint32Array(flat.buffer);
      let maxAlpha = 0;
      for (let y = 0; y < side; y++) {
        const row = sampleAxis(y, texture.h) * texture.w;
        const base = y * side;
        for (let x = 0; x < side; x++) {
          const a = rawGray[row + sampleX[x]];
          if (a > maxAlpha) maxAlpha = a;
          flat32[base + x] = ((a << 24) | 0x00ffffff) >>> 0;
        }
      }
      if (!maxAlpha) {
        return Object.assign({}, brush, { tip: synthTip(shape, 256, opts) });
      }
      return Object.assign({}, brush, { tip: { w: side, h: side, rgba: flat }, hasTexture: false, textureDepth: 0, _bruGrainInTip: true,
        /* 【第231轮】记录烘焙前的源纹理语义，brushset 存档据此带回 hasTexture/depth（verify230）。 */
        _bruTexOrig: { hasTexture: brush.hasTexture, textureDepth: brush.textureDepth } });
    }
    const stamp = synthTip(shape, side, opts);
    for (let y = 0; y < side; y++) {
      const row = sampleAxis(y, texture.h) * texture.w;
      for (let x = 0; x < side; x++) {
        const value = texture.gray[row + sampleX[x]];
        const offset = (y * side + x) * 4 + 3;
        stamp.rgba[offset] = Math.round(stamp.rgba[offset] * curve[brightnessBlend ? 255 - value : value] / 255);
      }
    }
    if (!stamp.rgba.some(function (value, i) { return i % 4 === 3 && value > 0; })) {
      return Object.assign({}, brush, { tip: synthTip(shape, 256, opts) });
    }
    return Object.assign({}, brush, { tip: stamp, hasTexture: false, textureDepth: 0, _bruGrainInTip: true,
      /* 【第231轮】同上。 */
      _bruTexOrig: { hasTexture: brush.hasTexture, textureDepth: brush.textureDepth } });
  }

  /** Convert one brush to a Procreate .brush file (zip). */
  function makeProcreateBrush(brush, opts) {
    opts = opts || {};
    brush=withExportSettings(brush,opts);
    // 还原优先：源本身就是 Procreate，且没有强制重建时，直接原样打包
    if (opts.fidelity !== false && brush._rawArchive && !opts.forceRebuild) {
      const bytes = procreate.writeBrush(brush, opts);
      return { bytes: bytes, name: brush.name || 'brush', passthrough: procreate.unchanged(brush,opts), nativePatched:!procreate.unchanged(brush,opts) };
    }
    let b2 = procreateExportTip(brush, opts);
    b2 = restoreSharedLinkedBrush(brush, b2, opts);
    const nativeArchive = eligibleNativeArchive(brush, opts, true);
    if (nativeArchive) b2 = Object.assign({}, b2, {_nativeArchiveRestore:nativeArchive,
      _nativeThumbnailRestore:brush._nativeArchiveBackup && nativeArchive === brush._nativeArchiveBackup.archive ? brush._nativeArchiveBackup.thumbnail : null});
    if (nativeArchive && brush.dualSubBrush && b2.dualSubBrush) {
      const childArchive = eligibleNativeArchive(prepareBruForCrossFormat(brush.dualSubBrush),opts,false);
      if (childArchive) b2 = Object.assign({},b2,{dualSubBrush:Object.assign({},b2.dualSubBrush,{_nativeArchiveRestore:childArchive,
        _nativeThumbnailRestore:brush.dualSubBrush._nativeArchiveBackup && childArchive === brush.dualSubBrush._nativeArchiveBackup.archive ? brush.dualSubBrush._nativeArchiveBackup.thumbnail : null})});
    }
    const bytes = procreate.writeBrush(b2, opts);
    const warnings = b2._bruGrainInTip ? ['画世界逐笔尖纹理已合成到形状中，目标软件的混合与深度动态为近似效果'] : [];
    if (b2._sharedSubSizeWarning) warnings.push(b2._sharedSubSizeWarning);
    if (b2._procreateDualBridge || b2._procreateDualBridgeInvalid) warnings.push('副笔源备份损坏或当前设置已更改，无法安全恢复原副笔；保留当前画世界笔刷内容');
    return { bytes: bytes, name: brush.name || 'brush', warnings };
  }

  /** Convert a whole set to one Procreate .brushset file (zip). */
  /* 【第285轮】前背景色动态选项归一（从 makeProcreateBrushset 提出：同步/异步共用同一口径） */
  function brushsetFgBgDyn(opts) {
    return (opts.fgBgDyn === undefined || opts.fgBgDyn === null || !isFinite(Number(opts.fgBgDyn)))
      ? 0 : Math.max(0, Math.min(1, Number(opts.fgBgDyn)));
  }

  /* 【第285轮】单支笔刷 → brushset 条目（原 makeProcreateBrushset 里 map 回调体的原样搬移） */
  function brushsetItem(b, i, names, opts, fgBgDynOpt) {
    b=withExportSettings(b,opts);
    if (fgBgDynOpt > 0) {
      b = Object.assign({}, b, { colorJitterFgBg: fgBgDynOpt, colorDynamicsOn: true });
      /* 原生 Procreate 笔刷带着 _rawArchive 时会走 raw 透传（procreate.writeBrush 里的 unchanged()），
         那样新写入的字段会被原样档案覆盖掉。既然用户明确要求开前背景色动态，就剥掉原始档案强制重建。 */
      delete b._rawArchive; delete b._rawBrushState; delete b._rawGrainState;
    }
    const archiveDisplayName = names[i] === sanitizeName(b.name, i) ? b.name : names[i];
    if (b.name !== names[i]) b = Object.assign({}, b, { name: names[i] });
    /* 【第297轮】源 BRU 的字段存在性随 brushset 一起带走（转回时决定「该不该写」）。 */
    let restored = procreateExportTip(b, opts);
    restored = restoreSharedLinkedBrush(b, restored, opts);
    const nativeArchive = eligibleNativeArchive(b, opts, true, archiveDisplayName);
    if (nativeArchive) restored = Object.assign({}, restored, {_nativeArchiveRestore:nativeArchive,
      _nativeThumbnailRestore:b._nativeArchiveBackup && nativeArchive === b._nativeArchiveBackup.archive ? b._nativeArchiveBackup.thumbnail : null});
    if (b.dualSubBrush && restored.dualSubBrush &&
        util.brushFingerprint({tip:b.dualTip}) === util.brushFingerprint({tip:b.dualSubBrush.tip})) {
      const child = prepareBruForCrossFormat(b.dualSubBrush);
      const subArchive = eligibleNativeArchive(child, opts, false);
      if (subArchive) restored = Object.assign({}, restored, {dualSubBrush:Object.assign({},restored.dualSubBrush,{_nativeArchiveRestore:subArchive,
        _nativeThumbnailRestore:child._nativeArchiveBackup && subArchive === child._nativeArchiveBackup.archive ? child._nativeArchiveBackup.thumbnail : null})});
    }
    return attachBruFieldSets(restored);
  }

  function brushsetWarnings(list) {
    /* 【第194轮】纹理丢失必须报出来。画世界 BRU 的 texAssetId 有两种形态：
         ptN（内置素材库能解）→ 现在会写进 Grain.png；
         32 位 UUID（画世界私有材质，库里没有）→ Grain.png 只能留空。
       以前这里连 warnings 字段都没有，用户拿到的 brushset 里几十支笔刷没纹理却毫无提示，
       在 Procreate 里表现就是笔尖发糊/发花（楠.bru 实测 38/46 支属后者）。 */
    const warnings = list.map(b => b._sharedSubSizeWarning).filter(Boolean);
    const bridgeFallback = list.filter(function (b) { return b._procreateDualBridge || b._procreateDualBridgeInvalid; }).length;
    if (bridgeFallback) warnings.push(bridgeFallback + ' 支笔刷的副笔源备份损坏或当前设置已更改，无法安全恢复原副笔，已保留当前画世界笔刷内容');
    const baked = list.filter(function (b) { return b._bruGrainInTip; }).length;
    if (baked) warnings.push(baked + ' 支画世界笔刷的逐笔尖纹理已合成到形状中，混合与深度动态为近似效果');
    /* 【第232轮】未知字段总量超 4KB/支 安全阀触发时的告警（透传被跳过，字段不随 brushset 保留）。 */
    const skippedUnknown = list.filter(function (b) { return b._rawUnknownSkipped; }).length;
    if (skippedUnknown) warnings.push(skippedUnknown + ' 支笔刷的未知字段总量超过 4KB，已跳过透传（这些字段不随 brushset 保留）');
    const noTex = list.filter(function (b) {
      try { return b && b.hasTexture && !b._carriedProcreateGrain && !textureGray(b); } catch (e) { return false; }
    });
    if (noTex.length) {
      const sample = noTex.slice(0, 3).map(function (b) { return String(b.name || '未命名'); }).join('、');
      warnings.push('纹理：' + noTex.length + ' 支笔刷引用的画世界私有材质（32 位 UUID）不在内置素材库中，' +
        'Grain.png 已留空（' + sample + (noTex.length > 3 ? ' 等' : '') + '）——这会让它们在 Procreate 里缺少纹理质感');
    }
    return warnings;
  }

  /* 【第285轮】收尾：写 brushset 容器 + 纹理/未知字段告警（原后半段原样搬移） */
  function brushsetFinalize(list, opts) {
    const bytes = procreate.writeBrushset(list, opts);
    return { bytes: bytes, count: list.length, warnings: brushsetWarnings(list) };
  }

  async function brushsetFinalizeAsync(list, opts, hooks) {
    const bytes = await procreate.writeBrushsetAsync(list, opts, {
      shouldAbort: hooks && hooks.shouldAbort,
      yieldTick: yieldTick
    });
    return { bytes: bytes, count: list.length, warnings: brushsetWarnings(list) };
  }

  function makeProcreateBrushset(brushList, opts) {
    opts = opts || {};
    // 同一包里重名笔刷：Procreate 里会显示多支同名，用户无法区分，统一去重
    // （#48 WorkBuddy 第106轮：改用全局 uniqueNames，与 ABR/GoPaint 的大小写折叠与长度上限口径一致）
    const names = uniqueNames(brushList);
    /* 【第208轮】前背景色动态（双色）：opts.fgBgDyn ∈ 0..1。不传/为 0 时行为不变。
       画世界的双色是 App 全局颜色模式（前景/背景色），BRU 里没有笔刷级标记，
       所以这里做成转换选项，而不是从源笔刷自动推断。 */
    const fgBgDynOpt = brushsetFgBgDyn(opts);
    const list = [];
    brushList.forEach(function (b, i) { list.push(brushsetItem(b, i, names, opts, fgBgDynOpt)); });
    return brushsetFinalize(list, opts);
  }

  /* 【第285轮 / 第304轮】可取消的 brushset 整包：逐支 await 且写容器阶段也走 writeBrushsetAsync
     + zip.writeAsync（每支 writeBrush 与 ZIP 条目压缩均可中断），输出与同步版逐字节一致。 */
  async function makeProcreateBrushsetAsync(brushList, opts, hooks) {
    opts = opts || {};
    hooks = hooks || {};
    const names = uniqueNames(brushList);
    const fgBgDynOpt = brushsetFgBgDyn(opts);
    const list = [];
    const total = brushList.length;
    for (let i = 0; i < total; i++) {
      if (hooks.shouldAbort && hooks.shouldAbort()) {
        const err = new Error('已取消');
        err.code = 'ABORTED';
        throw err;
      }
      await yieldTick();
      list.push(brushsetItem(brushList[i], i, names, opts, fgBgDynOpt));
      if (hooks.onBrush) hooks.onBrush(i, total, names[i]);
    }
    return await brushsetFinalizeAsync(list, opts, hooks);
  }

  function bytesToB64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /**
   * Expand a ZIP that is not itself a brush file into a list of brush files.
   * Also supports a bundled CSP decrypted dump: `_decrypted/<name>/<name>.params.json`
   * + `tips/*.png` is matched to a sibling .sut (or exported as its own brush when
   * no .sut is present). Returns { files: [{name, bytes, kind, decrypted?}], skipped, warnings }.
   */
  function expandArchive(zipName, bytes, depth) {
    depth = depth || 0;
    const warnings = [];
    const files = [];
    const skipped = [];
    if (depth > 3) return { files, skipped, warnings: ['压缩包嵌套过深，已停止: ' + zipName] };
    let entries;
    try {
      entries = zip.read(bytes);
    } catch (e) {
      throw new Error('无法解压：' + e.message);
    }
    if (entries.length > 4000) throw new Error('压缩包条目过多');

    // ---- pre-scan CSP decrypted dumps ----
    const groups = new Map(); // groupRoot -> { json, jsonBytes, tipsByName, meta }
    for (const entry of entries) {
      if (entry.dir) continue;
      const norm = entry.name.replace(/\\/g, '/');
      if (!/\.params\.json$/i.test(norm)) continue;
      const parts = norm.split('/');
      const idx = parts.lastIndexOf('_decrypted');
      if (idx < 0) continue;
      const groupRoot = parts.slice(0, idx + 2).join('/'); // .../_decrypted/<name>
      let data;
      try { data = entry.data(); } catch (e) { continue; }
      let meta = null;
      try { meta = JSON.parse(util.utf8Decode(data)); } catch (e) { continue; }
      groups.set(groupRoot, { json: meta, jsonBytes: data, tipsByName: new Map(), meta: meta });
    }
    for (const entry of entries) {
      if (entry.dir) continue;
      const norm = entry.name.replace(/\\/g, '/');
      for (const [groupRoot, grp] of groups) {
        if (!norm.startsWith(groupRoot + '/')) continue;
        const rel = norm.slice(groupRoot.length + 1);
        let data;
        try { data = entry.data(); } catch (e) { break; }
        grp.tipsByName.set(rel, data);
        break;
      }
    }
    const groupPayload = function (grp) {
      const mats = Array.isArray(grp.meta.materials) ? grp.meta.materials : [];
      const tips = mats.map(function (m) {
        const prev = m && m.previews && m.previews[0];
        if (!prev || !prev.file) return null;
        const f = String(prev.file).replace(/^\/+/, '');
        const hit = grp.tipsByName.get(f);
        return hit ? bytesToB64(hit) : null;
      });
      return {
        json: grp.jsonBytes,
        tips: tips,
        name: String(grp.meta.brush_name || '').trim() || groupRoot.split('/').pop()
      };
    };
    const usedGroups = new Set();

    for (const entry of entries) {
      if (entry.dir) continue;
      const lower = entry.name.toLowerCase();
      if (lower.includes('__macosx') || lower.endsWith('.ds_store')) continue;
      const base = lower.split('/').pop();
      if (!base || base.startsWith('.')) continue;
      // decrypted dump internal files belong to a group, not standalone brushes
      let inGroup = null;
      for (const groupRoot of groups.keys()) {
        if (entry.name.replace(/\\/g, '/').startsWith(groupRoot + '/')) { inGroup = groupRoot; break; }
      }
      if (inGroup) {
        // handled below via the sut match / virtual entry
        continue;
      }
      let data;
      try {
        data = entry.data();
      } catch (e) {
        skipped.push(entry.name);
        continue;
      }
      const kind = detect(entry.name, data);
      if (kind) {
        const item = { name: entry.name, bytes: data, kind };
        if (kind === 'sut') {
          const sutBase = base.replace(/\.sut$/i, '');
          for (const [groupRoot, grp] of groups) {
            if (usedGroups.has(groupRoot)) continue;
            const dirName = groupRoot.split('/').pop().toLowerCase();
            const metaSut = String((grp.meta && grp.meta.sut) || '').toLowerCase();
            if (dirName === sutBase || (metaSut && metaSut === base)) {
              item.decrypted = groupPayload(grp);
              usedGroups.add(groupRoot);
              break;
            }
          }
        }
        files.push(item);
        continue;
      }
      if (zip.isZip(data) && depth < 3) {
        const inner = expandArchive(entry.name, data, depth + 1);
        inner.files.forEach(function (f) { files.push({ name: entry.name + ' / ' + f.name, bytes: f.bytes, kind: f.kind, decrypted: f.decrypted }); });
        inner.skipped.forEach(function (s) { skipped.push(entry.name + ' / ' + s); });
        inner.warnings.forEach(function (w) { warnings.push(w); });
        continue;
      }
      skipped.push(entry.name);
    }

    // decrypted dumps without a matching .sut become brushes of their own
    for (const [groupRoot, grp] of groups) {
      if (usedGroups.has(groupRoot)) continue;
      const payload = groupPayload(grp);
      files.push({
        name: groupRoot + '/' + (payload.name || 'csp') + '.params.json',
        bytes: grp.jsonBytes,
        kind: 'csp-decrypted',
        decrypted: payload
      });
      usedGroups.add(groupRoot);
    }

    if (!files.length) {
      warnings.push('压缩包里没有找到可识别的笔刷文件（支持 .abr/.tpl/.bru/.brush/.brushset，或包含 .sut + _decrypted 的压缩包）');
    } else if (skipped.length) {
      warnings.push('压缩包内 ' + skipped.length + ' 个不相关文件已忽略（' + skipped.slice(0, 3).join(', ') + '…）');
    }
    return { files, skipped, warnings };
  }

  /* 把双笔刷的第二支笔尖按 alpha 合成进主笔尖（近似，非 PS 的双笔尖混合算法） */
  function bakedTipFor(brush, opts) {
    opts = opts || {};
    let tip = tipToRGBA(brush) || synthTip(brush, 256, opts);
    if (opts.dualBake !== false && brush.dualOn && brush.dualTip && (brush.dualTip.rgba || brush.dualTip.data) && opts.noDualBake !== true) {
      tip = bakeDualTip(tip, brush);
    }
    return tip;
  }

  /* 双笔混合模式归一：Procreate 解析出的是数字 0–11，其它格式可能是 'Mltp'/'scrn' 等 PS 码或英文名。
     旧的烘焙分支只对字符串做 substr 匹配，数字与 0(normal) 全落到 multiply。 */
  // Native Procreate modes independently calibrated on the two drawing apps.
  // The other numeric table predates these archives and uses different indices.
  const PROCREATE_BAKED_DUAL_MODES = { 1: 'mltp', 11: 'ovrl', 19: 'drkn' };
  function dualBlendCode(m, source) {
    if (m === undefined || m === null || m === '') return '';
    if (typeof m === 'number') {
      if (source === 'procreate' && PROCREATE_BAKED_DUAL_MODES[m]) return PROCREATE_BAKED_DUAL_MODES[m];
      return ['nrml', 'drkn', 'mltp', 'drkn', 'mltp', 'lghn', 'scrn', 'mltp', 'ovrl', 'mltp', 'mltp', 'mltp'][m] || '';
    }
    const s = String(m).toLowerCase().replace(/[^a-z]/g, '');
    if (s.indexOf('nrml') >= 0 || s.indexOf('normal') >= 0) return 'nrml';
    if (s.indexOf('scrn') >= 0 || s.indexOf('screen') >= 0 || s.indexOf('lghn') >= 0 || s.indexOf('lighten') >= 0) return 'scrn';
    if (s.indexOf('ovrl') >= 0 || s.indexOf('overlay') >= 0) return 'ovrl';
    if (s.indexOf('drkn') >= 0 || s.indexOf('darken') >= 0) return 'drkn';
    return '';
  }

  /* 统计双笔刷单层在 256×256 归一化网格上的覆盖率、实心占比与深层核心占比（用于识别
     Procreate 正常模式下的互补双色描边/气泡底板笔刷，避免把前景与底板同色合并成黑块）。 */
  function dualLayerStats256(w, h, getAlpha) {
    const N = 256;
    const opGrid = new Uint8Array(N * N);
    const solidGrid = new Uint8Array(N * N);
    let op = 0, solid = 0;
    for (let y = 0; y < N; y++) {
      const sy = Math.min(h - 1, Math.floor(y * h / N));
      for (let x = 0; x < N; x++) {
        const sx = Math.min(w - 1, Math.floor(x * w / N));
        const a = getAlpha(sx, sy);
        const k = y * N + x;
        if (a >= 32 / 255) { op++; opGrid[k] = 1; }
        if (a >= 220 / 255) { solid++; solidGrid[k] = 1; }
      }
    }
    const d = 8;
    let deep8 = 0;
    for (let y = d; y < N - d; y++) {
      for (let x = d; x < N - d; x++) {
        const k = y * N + x;
        if (solidGrid[k] && solidGrid[k - d] && solidGrid[k + d] &&
            solidGrid[(y - d) * N + x] && solidGrid[(y + d) * N + x] &&
            solidGrid[(y - d) * N + x - d] && solidGrid[(y + d) * N + x + d]) {
          deep8++;
        }
      }
    }
    return {
      op: op,
      opGrid: opGrid,
      solidRatio: solid / (op || 1),
      d8: deep8 / (solid || 1)
    };
  }

  /* 笔尖的 alpha 均值与标准差（0..1）。均值判断副笔烘焙有没有把墨量吃掉；
     标准差用来区分「有结构的笔尖」和「一整块均匀的实心/半透明笔尖」——
     均匀笔尖相乘只等于整体调不透明度，是有意的合成，不该被保护阀拦下。 */
  function tipAlphaStats(img) {
    if (!img || !img.rgba || !img.rgba.length) return { mean: 0, sd: 0 };
    const n = img.w * img.h;
    if (!n) return { mean: 0, sd: 0 };
    let sum = 0, sum2 = 0;
    for (let i = 3; i < n * 4; i += 4) { const a = img.rgba[i]; sum += a; sum2 += a * a; }
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    return { mean: mean / 255, sd: sd / 255 };
  }

  function bakeDualTip(tip, brush) {
    const d = brush.dualTip;
    if (!d || !tip || !tip.rgba) return tip;
    if (!d.rgba && !d.data) return tip;
    const info = brush.dualBrush || {};
    const bpp = d.bpp || 1;
    const raw = function (x, y) {
      const o = y * d.w + x;
      if (d.rgba) return d.rgba[o * 4 + 3] / 255;
      if (bpp >= 3) return (d.data[o * bpp] + d.data[o * bpp + 1] + d.data[o * bpp + 2]) / 3 / 255;
      return d.data[o] / 255;
    };
    const w = tip.w, h = tip.h;
    const out = new Uint8Array(w * h * 4);
    const blend = dualBlendCode(brush.dualBlendMode !== undefined ? brush.dualBlendMode : info.blend, brush.source);
    const subB = brush.dualSubBrush;
    const mMax = brush._params && Number(brush._params.maxSize) || 0;
    const sMax = subB && subB._params && Number(subB._params.maxSize) || 0;
    const uneditedProcreateSub = brush.source === 'procreate' && mMax > 0 && sMax > 0 &&
      (!subB._rawNormalized || subB.sizePx === subB._rawNormalized.sizePx) &&
      (!info.diameter || info.diameter === subB.sizePx);
    const ratio = uneditedProcreateSub
      ? (sMax / mMax)
      : (info.diameter > 0 && brush.sizePx > 0 ? info.diameter / brush.sizePx : 1);
    // Convert logical diameter into main-image pixels, then into secondary-image
    // coordinates. Changing the secondary image resolution must not resize it.
    const scale = Math.max(w, h) * ratio / Math.max(d.w, d.h);
    /* 【第185轮】Procreate 的 dual brush angle 是「副笔每个 dab 的旋转」，
       不是整张副笔图的重采样旋转。烘焙成单 dab 图案时若整图旋转，多笔尖布局
       会被翻到对角——用户「喘气 1」实测：5 个气泡的描边环全部错位到对面。
       副笔 dab 自身的旋转已由 BRU 的笔尖角度字段表达，这里不应用。 */
    const ang = 0;
    const round = Math.max(0.05, Math.min(1, (info.roundness === undefined ? 100 : info.roundness) / 100));
    const flipX = !!info.flipX, flipY = !!info.flipY, invert = !!info.flip;
    const cos = Math.cos(-ang), sin = Math.sin(-ang);
    const cx = w / 2, cy = h / 2;
    const dualAlpha = function (px, py) {
      const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      let u = rx / scale + d.w / 2 - 0.5;
      let v = ry / (scale * round) + d.h / 2 - 0.5;
      if (flipX) u = d.w - 1 - u;
      if (flipY) v = d.h - 1 - v;
      const sx = Math.round(u), sy = Math.round(v);
      if (sx < 0 || sy < 0 || sx >= d.w || sy >= d.h) return 0;
      const a = raw(sx, sy);
      return invert ? 1 - a : a;
    };
    let nrmlMode = 'over';
    if (blend === 'nrml' && w >= 64 && h >= 64) {
      const ms = dualLayerStats256(w, h, function (x, y) { return tip.rgba[(y * w + x) * 4 + 3] / 255; });
      const ss = dualLayerStats256(w, h, dualAlpha);
      let ov = 0;
      for (let k = 0; k < 256 * 256; k++) {
        if (ms.opGrid[k] && ss.opGrid[k]) ov++;
      }
      const minOp = Math.min(ms.op || 1, ss.op || 1);
      const maxOp = Math.max(ms.op || 1, ss.op || 1);
      const ovRatio = ov / minOp;
      const isComplementary = (ovRatio < 0.25) || (ov / maxOp < 0.25 && ss.op >= ms.op * 1.5 && ss.solidRatio >= 0.50);
      if (ms.op > 0 && ss.op > 0 && isComplementary) {
        /* 【第183轮】「互补双笔」有两种相反的语义，用「主笔有多少落在副笔之外」区分：
           a) 主笔是**完整图案**，有大量内容伸出副笔（星星/爱心/尖角/笔画主体）
              → **只用主笔**。并集会把底板合进来变黑块，差集(a2-a1)会把实心挖成空心。
                用户「黄土笔刷」的「唔～呜」实测 outsideRatio=0.879，原图实心，旧逻辑出空心。
           b) 主笔是**细线框**、完全嵌在副笔实心块里（文字印章 / 气泡对话框底板）
              → 差集(a2-a1)：只留副笔超出主笔的部分，主笔位置镂空。
                第237轮的两个回归用例就是这种，outsideRatio≈0。
           阈值 0.10 两边余量都很大（0.879 vs ≈0）。 */
        let onlyMain = 0;
        for (let k = 0; k < 256 * 256; k++) if (ms.opGrid[k] && !ss.opGrid[k]) onlyMain++;
        const outsideRatio = onlyMain / (ms.op || 1);
        /* 再分一层：副笔是不是「底板」。
           底板的指纹是**有深层实心核心**（ss.d8 高：成片实心，8px 窗口都实）；
           而「实心笔画」太细，d8 接近 0。实测：
             · 用户「唔～呜」副笔（菱形底板）d8=0.135、outsideRatio=0.879 → 只用主笔
             · 237b「颤抖」副笔（十字笔画）d8≈0                 → 走差集
             · 237c 气泡底板 d8 也高，但主笔（文字）全在底板内 outsideRatio≈0 → 走差集 */
        if (outsideRatio > 0.10 && ss.d8 >= 0.10) {
          nrmlMode = 'main';
        } else if (ss.solidRatio >= 0.50) {
          nrmlMode = 'sub_cutout';
        } else if (ms.solidRatio >= 0.50) {
          nrmlMode = 'over';
        }
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a1 = tip.rgba[(y * w + x) * 4 + 3] / 255;
        const a2 = dualAlpha(x, y);
        let a;
        if (blend === 'nrml') {
          a = nrmlMode === 'sub_cutout' ? Math.max(0, a2 - a1)
            : nrmlMode === 'main_cutout' ? Math.max(0, a1 - a2)
            : nrmlMode === 'sub' ? a2
            : nrmlMode === 'main' ? a1
            : (1 - (1 - a1) * (1 - a2));
        } else if (blend === 'scrn' || blend === 'lghn') a = 1 - (1 - a1) * (1 - a2);
        else if (blend === 'drkn') a = Math.min(a1, a2);
        else if (blend === 'ovrl') a = a1 < 0.5 ? 2 * a1 * a2 : 1 - 2 * (1 - a1) * (1 - a2);
        else a = a1 * a2;
        const o = (y * w + x) * 4;
        out[o] = tip.rgba[o]; out[o + 1] = tip.rgba[o + 1]; out[o + 2] = tip.rgba[o + 2];
        out[o + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
      }
    }
    return { w: w, h: h, rgba: out };
  }

  /** Convert one brush to a GIMP .gbr file (8-bit gray tip). */
  function makeGbr(brush, opts) {
    opts = opts || {};
    // 还原优先：源就是 .gbr 时直接原样输出
    if (brush._rawKind === 'gbr' && brush._rawFile && rawBrushUnchanged(brush, opts)) {
      return { bytes: new Uint8Array(brush._rawFile), count: 1, passthrough: true };
    }
    const b2 = withTipRGBA(withSizeAndSpacing(brush, opts), opts, { transform: true, fit: true });
    const w = b2.tip.w, h = b2.tip.h;
    const gray = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) gray[k] = b2.tip.rgba[k * 4 + 3];
    const name = String(brush.name || 'brush').trim().slice(0, 120);


    return { bytes: gimp.writeGbr({ name: name, tip: { w: w, h: h, data: gray }, spacingPct: b2.spacingPct }), count: 1 };
  }

  /** Convert one brush to a MyPaint .myb file. */
  function makeMyb(brush, opts) {
    opts = opts || {};
    // 还原优先：源就是 .myb 时原样输出
    if (brush._rawMyb && brush._rawMyb.length && rawBrushUnchanged(brush, opts)) {
      return { bytes: new Uint8Array(brush._rawMyb), count: 1, passthrough: true };
    }
    const b = withExportSettings(brush, opts);
    // MYB stores parameterized dabs; it cannot carry the baked image here.
    const bytes = mypaint.writeMyb(b, opts);
    return { bytes: bytes, count: 1 };
  }

  /** One brush -> Krita .kpp (best-effort preset). */
  function makeKpp(brush, opts) {
    const b2 = withTipRGBA(withExportSettings(brush, opts), opts);
    return { bytes: krita.writeKpp(b2), count: 1 };
  }

  /** Brush list -> one GIMP .gih pipe. */
  function makeGih(brushList, opts) {
    opts = opts || {};
    // 还原优先：整组来自同一个 .gih 时原样输出
    const rawGroup = brushList.length && brushList[0]._rawGroup;
    if (rawGroup && rawGroup.count === brushList.length &&
        (opts.name === undefined || String(opts.name).trim() === rawGroup.name) &&
        brushList.every(function (b, i) { return b._rawKind === 'gih' && b._rawGroup === rawGroup && b._rawGroupIndex === i && rawBrushUnchanged(b, opts); })) {
      return { bytes: new Uint8Array(rawGroup.bytes), count: brushList.length, passthrough: true };
    }
    const list = brushList.map(function (b) { return withTipRGBA(withSizeAndSpacing(b, opts), opts, {transform:true,fit:true}); });
    const name = (opts.name && String(opts.name).trim()) || (rawGroup && rawGroup.name) ||
      (list.length ? String(list[0].name || '').trim() : '') || 'brushconv';
    /* 第165轮：GIH 是纯位图笔刷管，格式规定同一管内所有 cell 等尺寸（writeGih 用 max 补齐），
       且文件里不存流量/硬度/散布/纹理参数。过去这些损失完全静默：多支不同尺寸的笔刷
       互转一次后 sizePx 全部变成最大值，用户拿回转换器也看不出发生过什么。
       与 SAI2 / 优动漫一致，把不可保真项明确报出来。 */
    const warnings = [];
    const sizes = new Set(list.map(function (b) { return b && b.tip ? Math.max(b.tip.w, b.tip.h) : 0; }));
    if (sizes.size > 1) {
      const maxSize = Math.max.apply(null, Array.from(sizes));
      warnings.push('GIH：同一笔刷管内所有笔尖尺寸必须一致，已统一为 ' + maxSize + 'px（最大笔尖）；' +
        sizes.size + ' 种原始尺寸不可恢复，导出的笔刷再导入时尺寸都会变成 ' + maxSize + 'px');
    }
    /* 【第189轮】单支笔刷 + 开启散布 → 用「同一个笔尖的 N 个偏移副本」当 pipe 的 cell，
       并把 sel0 写成 random。依据 GIMP 2.10 `app/core/gimpbrushpipe.c`：
       PIPE_SELECT_RANDOM 的实现是 `g_random_int_range(0, rank[i])`，即每次落笔随机挑一个
       cell；GIMP 没有 ABR 那种位置/数量 jitter 参数，这是它唯一的散布机制。
       注意 pipe 永远是**一支**笔刷（select_brush 在内部 N 个 cell 之间切换），所以这里只
       在单支导出时启用——多支笔刷各自成文件由 makeGihFiles 负责。 */
    if (list.length === 1 && list[0] && list[0].scatterOn && Number(list[0].scatterPct) > 0) {
      const cells = gimp.scatterCells(list[0], opts);
      if (cells && cells.length > 1) {
        warnings.push('GIH：散布用「' + cells.length + ' 个偏移副本 + 随机选取」表达（GIMP 无 jitter 参数）；' +
          '笔刷在 GIMP 里的显示尺寸会变成放大后的 cell 尺寸');
        return {
          bytes: gimp.writeGih(cells, name, { sel: 'random' }),
          /* count 是「笔刷数」不是 cell 数：散布 pipe 在 GIMP 里仍然是一支笔刷 */
          count: 1,
          cells: cells.length,
          scatterPipe: true,
          warnings: warnings
        };
      }
    }
    const lossy = list.some(function (b) {
      return b && (b.flowPct !== undefined || b.hardness !== undefined || b.hasTexture ||
        (b.scatterOn && (b.scatterPct || b.scatterCount)));
    });
    if (lossy) warnings.push('GIH：GIMP 位图笔刷不保存流量、硬度、散布与纹理参数，再导入时会重置为默认值');
    return { bytes: gimp.writeGih(list, name), count: list.length, warnings: warnings };
  }

  /* 【第189轮】多支笔刷 → 多个 .gih 文件（每支一个）。
     为什么必须拆：GIMP 的 `.gih` 是「一支笔刷的 n 维 cell 数组」，`gimp_brush_pipe_select_brush`
     永远只返回其中一个 cell 给画笔用。把 5 支笔刷塞进一个 pipe，用户在 GIMP 里只得到
     **一支**每次落笔换图案的笔刷，而不是 5 支笔刷。旧实现在这一点上是错的。
     单支导出仍走 makeGih（它会顺带处理散布 pipe）。 */
  function makeGihFiles(brushList, opts) {
    opts = opts || {};
    const files = [];
    const warnings = [];
    const used = Object.create(null);
    for (const b of (brushList || [])) {
      const made = makeGih([b], opts);
      let base = sanitizeName(String(b && b.name || 'brush'), 0, true) || 'brush';
      /* 同名笔刷不能互相覆盖（GIMP 按文件名建索引，重名会只留一个） */
      let uniq = base;
      let k = 2;
      while (used[uniq.toLowerCase()]) { uniq = base + '_' + k; k++; }
      used[uniq.toLowerCase()] = true;
      files.push({ name: uniq, bytes: made.bytes, scatterPipe: !!made.scatterPipe });
      if (made.warnings && made.warnings.length) for (const w of made.warnings) if (warnings.indexOf(w) < 0) warnings.push(w);
    }
    return { files: files, count: files.length, warnings: warnings };
  }

  /** Brush list -> Corel Painter .brushcategory XML (heuristic). */
  function makePainter(brushList, opts, name) {
    const painter = isNode ? require('./painterlib.js') : root.BC.painterlib;
    // 没有真实笔尖的笔刷先合成一个，保证每支都能生成 .nib
    const list = (brushList || []).map(function (b) {
      // Raw Painter XML must not swallow explicit edits or export overrides.
      const source = b._painterRaw && !rawBrushUnchanged(b, opts)
        ? Object.assign({}, b, { _painterRaw: undefined }) : b;
      try {
        const prepared = withTipRGBA(withExportSettings(source, opts), opts || {}, { nativeGeometry: true });
        return withFixedTipFlips(prepared);
      } catch (e) { return source; }
    });
    try {
      return { bytes: painter.writeLibrary(list, name || 'BrushConv'), count: list.length };
    } catch (e) {
      return { bytes: genericBrush.writePainter(list, name || 'BrushConv'), count: list.length };
    }
  }

  /* 第189轮：这里原本还有一份 `makeMdp(brushList, opts, name)`（走 genericBrush.writeMdp）。
     函数声明提升让下面那份覆盖了它，这一份永远不可达，属死代码——已删除。
     真正生效的实现见下方「One brush -> MediBang .mdp material」。 */

  /** One brush -> .ipcfg JSON (ibisPaint-style config exchange). */
  function makeIpcfg(brush) {
    return { bytes: genericBrush.writeIpcfg(brush), count: 1 };
  }

  /** Attach a prepared RGBA tip to a copy of the brush.
      - flags.nativeGeometry: synthesize a neutral tip when the target has
        native angle/roundness fields;
      - flags.bake: squash the tip width by brush.roundness so formats without a
        roundness field (GBR/BRU/MDP/PRBR) still look oval;
      - flags.fit: scale the tip to brush.sizePx so pixel-sized brush formats
        (GBR/GIH/MDP/PRBR) keep the intended brush size. */
  function withTipRGBA(brush, opts, flags) {
    opts = opts || {};
    flags = flags || {};
    let tip = tipToRGBA(brush) || synthTip(flags.transform || flags.nativeGeometry
      ? Object.assign({}, brush, { angle: 0, roundness: 100 }) : brush, 256, opts);
    // 目标格式没有"双笔刷"时：把第二支笔尖按 alpha 混合进主笔尖，保留大致外观
    if (flags.dual !== false && opts.dualBake !== false && brush.dualOn && brush.dualTip && (brush.dualTip.rgba || brush.dualTip.data)) {
      tip = bakeDualTip(tip, brush);
    }
    // Bitmap-only GIMP cells have no static angle/roundness/flip fields.
    if (flags.transform) tip = bakeTipTransform(tip, brush);
    let w = tip.w, h = tip.h, rgba = tip.rgba;
    if (flags.bake) {
      const round = Math.max(5, Math.min(100, brush.roundness === undefined ? 100 : brush.roundness)) / 100;
      if (round < 0.98 && w > 1) {
        const nw = Math.max(1, Math.round(w * round));
        rgba = png.resize(rgba, w, h, nw, h);
        w = nw;
      }
    }
    const limit = Math.max(1, Math.min(2048, opts.maxTipSize || 2048));
    const maxSide = Math.max(w, h);
    let target = null;
    if (flags.fit && brush.sizePx) target = Math.max(1, Math.min(limit, Math.round(brush.sizePx)));
    if (target && maxSide !== target) {
      const sc = target / maxSide;
      const nw = Math.max(1, Math.round(w * sc)), nh = Math.max(1, Math.round(h * sc));
      rgba = png.resize(rgba, w, h, nw, nh);
      w = nw; h = nh;
    } else if (maxSide > limit) {
      const sc = limit / maxSide;
      const nw = Math.max(1, Math.round(w * sc)), nh = Math.max(1, Math.round(h * sc));
      rgba = png.resize(rgba, w, h, nw, nh);
      w = nw; h = nh;
    }
    return Object.assign({}, brush, { tip: { w: w, h: h, rgba: rgba } });
  }

  // Keep angle/roundness for the target's native fields, bake only mirrors.
  // NOTE: the flags are cleared after baking — the mirror is now in the pixels, so any
  // later bakeTipTransform/withTipRGBA on this copy must not mirror a second time
  // (double mirror == no mirror). Krita path already cleared them explicitly.
  function withFixedTipFlips(brush) {
    if ((!brush.flipX && !brush.flipY) || !brush.tip) return brush;
    const tip = bakeTipTransform(tipToRGBA(brush), { flipX: brush.flipX, flipY: brush.flipY });
    return Object.assign({}, brush, { tip, flipX: false, flipY: false });
  }

  /** One brush -> Infinite Painter .prbr */
  function makePrbr(brush, opts) {
    const b2 = withTipRGBA(withExportSettings(brush, opts), opts, { bake: true, fit: true });
    return { bytes: infpainter.writePrbr(b2), count: 1 };
  }

  /** One brush -> MediBang .mdp material (stamp document). */
  function makeMdp(brushList, opts) {
    const list = Array.isArray(brushList) ? brushList : [brushList];
    /* 【第265轮】原样透传：单支 + 源就是 .mdp + 没有任何字段被改过 + 没强制重建，
       直接把原始字节吐回去。以前每支都会重建 zip（layerBin/thumbBin 重新编码），
       217 支内置样本原样往返时字节全变（内容等价但文件不同）。 */
    if (list.length === 1) {
      const one = list[0];
      if (one && one._rawMdp && one._rawMdp.length && !opts.forceRebuild) {
        /* 用本题材自己的基线做判据：parse 后立刻记一次指纹，之后逐字段比对。
           不挂 rawBrushUnchanged 是因为它要求的 _rawBrushState 在 parseFile 的多段后处理之后
           会变（tip 补位等），用它会导致永远判成"改过"。 */
        const fp0 = util.brushFingerprint(one);
        if (one._rawMdpBase === undefined) one._rawMdpBase = fp0;
        if (one._rawMdpBase === fp0) {
          return { bytes: new Uint8Array(one._rawMdp), count: 1, passthrough: true, warnings: [] };
        }
      }
    }
    const chunks = [];
    /* 第189轮：同名笔刷过去会产出两个同名 .mdp，批量保存时后者覆盖前者（只剩一支）。
       与 makeTipPngPack / makeGihFiles 同一口径：NFC 归一 + 大小写折叠去重，
       重名追加 _2/_3；追加后仍守住 60 字符上限（按码点截断，不切代理对）。 */
    const used = new Map();
    for (const b of list) {
      const b2 = withTipRGBA(withExportSettings(b, opts), opts, { bake: true, fit: true });
      const base = sanitizeName(b2.name || 'material', 0);
      let name = base;
      let k = 2;
      while (used.has(name.normalize('NFC').toLowerCase())) {
        const suffix = '_' + k;
        k++;
        const room = 60 - suffix.length;
        name = (base.length > room ? util.cutUtf16(base, room).replace(/[. ]+$/, '') : base) + suffix;
      }
      used.set(name.normalize('NFC').toLowerCase(), true);
      chunks.push({ name: name + '.mdp', data: medibang.writeMdp(b2) });
    }
    /* 第165轮：.mdp 是「材质/图章文档」，XML 只带图像宽高，不存任意笔刷参数；
       parseMdp 回读时 sizePx 由裁切后的位图反推、spacingPct 固定 25。
       互转时这些值每跳都会重置，必须明确告知。 */
    const warnings = ['MDP：MediBang 材质文件只保存笔尖图像，不保存尺寸、间距、流量等笔刷参数；再导入时会按位图重新推算并重置为默认值'];
    if (chunks.length === 1) return { bytes: chunks[0].data, count: 1, warnings: warnings };
    return { files: chunks, count: chunks.length, warnings: warnings };
  }

  /* 【第191轮·缺口⑨】MediBang 纹理写出——只做能标定的部分，不编造字段值。
     标定结论（证据见 test/medibang_texture_write_test.js 开头与结论汇报）：
       · bs_texture / bs_textureid **不是 Brush2.ini 的键**。唯一「读取」在
         medibangIni.js:134 的 parseBsScript()，是对 .bs **Lua 笔刷脚本源码**做的
         存在性正则 /bs_texture|bs_textureid/，只产出布尔 hasTexture，不解析值/类型/路径；
         parseIni 也不读这两个键。
       · 本机 6 个真实 .bs 样本（MediBang APK 的 assets/brush_files/*.bs）、APK dex、
         5 支真实 .mdp 标定文档（参考/格式标定/07）里都没有这两个标识符的取值样本，
         公开资料也无可用的格式规范。第187轮方案文档把它们写成「.ini 的键」与代码不符。
       → 类型（文件名 / id / 路径 / 数字）、取值格式、纹理引用路径**均未标定**。
         按任务「标定不到的就不要写，别猜」：这里**不写** bs_texture / bs_textureid，
         也**不**在 .ini 里引用纹理 PNG。写错的键会让 MediBang 打不开文件，比不写更糟。
     能确定、且不依赖上述未标定项的部分：
       · 走 textureGray 收口拿灰度像素（BRU 声明的 ptN 内置纹理会自动补位），编成 PNG；
       · 纹理 PNG 作为**附加素材**放进唯一已知的图像目录 brush_bitmap/（读端
         decodeBitmap 也在此查找），追加在笔尖 PNG 之后，不被 MediBang 自动引用；
       · 在 warnings 里如实说明「MediBang 不支持写出纹理」。 */
  function medibangTexturePng(brush) {
    const t = textureGray(brush);
    if (!t || !(t.w > 0) || !(t.h > 0) || !t.gray || t.gray.length !== t.w * t.h) return null;
    const rgba = new Uint8Array(t.w * t.h * 4);
    for (let i = 0; i < t.gray.length; i++) {
      const v = t.gray[i];
      rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
    }
    return { bytes: png.encode(t.w, t.h, rgba), w: t.w, h: t.h };
  }
  /* 未标定 → 不写。这条警告同时是给用户和给后续维护者的说明。 */
  const MEDIBANG_TEX_WARNING = 'MediBang 不支持写出纹理：bs_texture/bs_textureid 字段语义未标定（仅见于 .bs 脚本标识符，无值样本、无格式规范），已把纹理灰度 PNG 作为附加素材放进 brush_bitmap/，MediBang 不会自动引用';

  /** Build a MediBang Paint brush package: black-shape tip PNG + Brush2.ini entry.
      Install: copy the PNG into %LOCALAPPDATA%\\Medibang\\CloudAlpaca\\brush_bitmap\\
      and append the ini snippet to Brush2.ini, then restart MediBang. */
  function makeMediBangIniPack(brushList, opts) {
    opts = opts || {};
    // 保证每支都有笔尖（程序笔刷也转成位图笔刷，否则缺少 .bs 脚本无法被 MediBang 识别）
    const list = (brushList || []).map(function (b) {
      try { return withTipRGBA(withExportSettings(b, opts), opts || {}, { transform: true }); } catch (e) { return b; }
    });
    /* 逐支按 textureGray 收口导出纹理 PNG；命名带 _texture 后缀，排在笔尖 PNG 之后。 */
    const extraImages = [];
    let anyTexture = false;
    (brushList || []).forEach(function (b, i) {
      const tex = medibangTexturePng(b);
      if (!tex) return;
      anyTexture = true;
      extraImages.push({ name: 'brush_bitmap/brushconv_' + (i + 1) + '_texture.png', data: tex.bytes });
    });
    const made = medibangIni.writeIniPack(list, Object.assign({}, opts, { extraImages: extraImages }));
    /* 未标定的 bs_texture / bs_textureid 在此保持「不写」，见上面的注释。 */
    return Object.assign({}, made, { warnings: anyTexture ? [MEDIBANG_TEX_WARNING] : [] });
  }

  function makeMediBangBrush(brush, opts) {
    opts = opts || {};
    /* 用原始 brush 走 textureGray 收口（含 BRU 的 ptN 内置纹理补位）。*/
    const tex = medibangTexturePng(brush);
    brush = withExportSettings(brush, opts);
    const b2 = withTipRGBA(brush, opts, { transform: true, fit: true });
    const w = b2.tip.w, h = b2.tip.h;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 0; rgba[i * 4 + 1] = 0; rgba[i * 4 + 2] = 0;
      rgba[i * 4 + 3] = b2.tip.rgba[i * 4 + 3];
    }
    const pngBytes = png.encode(w, h, rgba);
    const base = 'bc_' + String(brush.name || 'brush').replace(/[^A-Za-z0-9\u4e00-\u9fff_-]+/g, '_').slice(0, 40) + '_' + Date.now().toString(36);
    const pngName = base + '.png';
    const EOL = '\n';
    const EOL_CRLF = String.fromCharCode(13) + String.fromCharCode(10);
    const opacity = Math.max(0, Math.min(1, brush.opacity === undefined ? 1 : brush.opacity)).toFixed(3);
    const width = Math.max(1, Math.min(1000, Math.round(brush.sizePx || 40)));
    const section = '[' + (opts.index === undefined ? 100 : opts.index) + ']' + EOL +
      'name=' + (brush.name || 'brush') + EOL +
      'type=bitmap' + EOL +
      'group=-1' + EOL +
      'width=' + width + EOL +
      'min=' + Math.max(0, Math.min(width, Math.round(width * (brush.minSizeRatio === undefined ? 0 : brush.minSizeRatio)))) + EOL +
      'opacity=' + opacity + EOL +
      'pSize=' + (pressureSizeOn(brush) ? 'true' : 'false') + EOL +
      'pAlpha=' + (brush.pressureOpacity ? 'true' : 'false') + EOL +
      'cloudId=-1' + EOL +
      'cloudUuid=' + EOL +
      'bitmapFile=' + pngName + EOL +
      'option=0' + EOL + 'option2=0' + EOL + 'option3=50' + EOL;
    const readme = [
      'MediBang Paint 笔刷安装说明',
      '1. 把 ' + pngName + ' 复制到 brush_bitmap 目录（%LOCALAPPDATA%\\Medibang\\CloudAlpaca\\brush_bitmap\\）',
      '2. 打开同目录下的 Brush2.ini，在文件末尾追加 Brush2.ini.snippet.txt 里的内容',
      '3. 完全退出并重新打开 MediBang Paint Pro，笔刷列表最后会出现「' + (brush.name || 'brush') + '」'
    ].join('\r\n');
    const installBat = [
      '@echo off',
      'chcp 65001 >nul',
      'echo MediBang Paint brush install',
      'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"',
      'echo.',
      'pause',
      ''
    ].join(String.fromCharCode(13, 10));
    const installPs1 = String.raw`
$ErrorActionPreference = 'Stop'
$dst = Join-Path $env:LOCALAPPDATA 'Medibang\CloudAlpaca'
if (-not (Test-Path $dst)) { Write-Host ('not found: ' + $dst); exit 1 }
$png = Get-ChildItem (Join-Path $PSScriptRoot 'brush_bitmap') -Filter *.png | Select-Object -First 1
if (-not $png) { Write-Host 'missing brush_bitmap/*.png'; exit 1 }
Copy-Item $png.FullName (Join-Path $dst 'brush_bitmap') -Force
$ini = Join-Path $dst 'Brush2.ini'
if (-not (Test-Path $ini)) { New-Item -ItemType File -Path $ini | Out-Null }
$text = Get-Content $ini -Raw -Encoding UTF8
if ($null -eq $text) { $text = '' }
$max = 0
foreach ($m in [regex]::Matches($text, '(?m)^\[(\d+)\]')) { $n = [int]$m.Groups[1].Value; if ($n -gt $max) { $max = $n } }
$next = $max + 1
$snip = Get-Content (Join-Path $PSScriptRoot 'Brush2.ini.snippet.txt') -Raw -Encoding UTF8
$snip = [regex]::Replace($snip, '^\[\d+\]', '[' + $next + ']')
$snip = [regex]::Replace($snip, '(?m)^bitmapFile=.*$', 'bitmapFile=' + $png.Name)
Add-Content -Path $ini -Value $snip -Encoding UTF8
Write-Host ('installed section [' + $next + '] bitmap: ' + $png.Name)
Write-Host 'restart MediBang Paint Pro'
`;
    const zipMod = isNode ? require('./zip.js') : root.BC.zip;
    const zipFiles = [
      { name: 'brush_bitmap/' + pngName, data: pngBytes },
      { name: 'Brush2.ini.snippet.txt', data: util.utf8Encode(section) },
      { name: '安装.bat', data: util.utf8Encode(installBat) },
      { name: 'install.ps1', data: util.utf8Encode(String.fromCharCode(0xfeff) + installPs1) },
      { name: '安装说明.txt', data: util.utf8Encode(readme) }
    ];
    /* 纹理 PNG 作为附加素材排在笔尖之后；.ini 段里不写未标定的 bs_texture / bs_textureid。 */
    if (tex) zipFiles.push({ name: 'brush_bitmap/' + base + '_texture.png', data: tex.bytes });
    const bytes = zipMod.write(zipFiles);
    return { bytes: bytes, name: pngName, section: section, count: 1,
      warnings: tex ? [MEDIBANG_TEX_WARNING] : [] };
  }

  /** 天生会画(GoPaint) 目前只支持导入 .abr 与原生 .gobrush；这里按 ABR 导出。 */
  /** Export the brush tip as a standalone PNG (material for apps without a brush-file import:
      MediBang Paint / Infinite Painter: create a custom brush from an image). */
  function makeTipPng(brush, opts) {
    opts = opts || {};
    const maxTip = Math.max(64, Math.min(2048, opts.maxTipSize || 2048));
    const adjusted = withExportSettings(brush, opts);
    const img = withTipRGBA(adjusted, Object.assign({}, opts, { maxTipSize: maxTip }), { transform: true }).tip;
    return {
      bytes: png.encode(img.w, img.h, png.toMaskRgba(img.rgba)),
      w: img.w, h: img.h,
      meta: { name: adjusted.name || 'brush', sizePx: adjusted.sizePx, spacingPct: adjusted.spacingPct, opacity: adjusted.opacity }
    };
  }

  /** 提取可读的笔刷参数（用于 PNG 导出时附带的参数说明） */
  function brushParamInfo(b) {
    const r = (v, d) => (v === undefined || v === null || (typeof v === 'number' && !isFinite(v))) ? d : v;
    const num = (v, d, digits) => {
      const x = r(v, d);
      return typeof x === 'number' ? Math.round(x * Math.pow(10, digits === undefined ? 2 : digits)) / Math.pow(10, digits === undefined ? 2 : digits) : x;
    };
    return {
      名称: b.name || '',
      笔尖尺寸: b.tip ? (b.tip.w + '×' + b.tip.h) : '',
      画笔尺寸: num(b.sizePx, ''),
      间距百分比: num(b.spacingPct, ''),
      角度: num(b.angle, 0, 0),
      圆度: num(b.roundness, 100, 0),
      硬度: b.hardness === undefined ? '' : num(b.hardness * 100, '', 0),
      不透明度百分比: num((b.opacity === undefined ? 1 : b.opacity) * 100, '', 0),
      流量百分比: b.flowPct === undefined ? '' : num(b.flowPct * 100, '', 0),
      最小直径百分比: b.minSizeRatio === undefined ? '' : num(b.minSizeRatio * 100, '', 0),
      最小不透明度百分比: b.minOpacityRatio === undefined ? '' : num(b.minOpacityRatio * 100, '', 0),
      大小随机百分比: num(b.sizeJitterPct, 0, 0),
      间距随机百分比: num(b.spacingJitterPct, 0, 0),
      流量随机百分比: num(b.flowJitterPct, 0, 0),
      角度随机: num(b.angleJitterDeg, 0, 0),
      散布: b.scatterOn ? '开' : '关',
      散布强度百分比: b.scatterOn ? num(b.scatterPct, 0, 0) : '',
      散布数量: b.scatterOn ? num(b.scatterCount, 1, 0) : '',
      /* 【第190轮】textureGray 命中内置库时会带 builtinTexture=ptN（BRU 的 f6 只有
         资源 id、没有像素）。信息面板必须把它和「源文件自带像素」区分开，否则用户
         以为导出的纹理是原笔刷自带的。用户素材优先，取不到 builtinTexture 就按原样
         只报「有」，绝不误标成内置库。 */
      纹理: (function () {
        const t = textureGray(b);
        if (t && t.builtinTexture) return '内置库 ' + t.builtinTexture + '（画世界自带，非源文件自带像素）';
        return b.hasTexture ? '有' : '无';
      })(),
      压感大小: (b.pressureSize === undefined ? b.pressure : b.pressureSize) ? '是' : '否',
      压感不透明度: b.pressureOpacity ? '是' : '否',
      来源格式: b.source || ''
    };
  }

  function brushParamText(brushList) {
    const TAB = String.fromCharCode(9); const NL = String.fromCharCode(10);
    const rows = brushList.map(function (b) { return brushParamInfo(b); });
    const keys = ['名称', '笔尖尺寸', '画笔尺寸', '间距百分比', '角度', '圆度', '硬度', '不透明度百分比', '流量百分比',
      '最小直径百分比', '最小不透明度百分比', '大小随机百分比', '间距随机百分比', '流量随机百分比', '角度随机',
      '散布', '散布强度百分比', '散布数量', '纹理', '压感大小', '压感不透明度', '来源格式'];
    const out = [];
    out.push('笔刷参数表（与同目录 PNG 笔尖一一对应）');
    out.push('========================================');
    out.push('说明：间距为画笔直径的百分比；角度/角度随机单位为度；随机/散布为百分比；空值表示该来源没有此参数。');
    out.push('');
    out.push(['序号'].concat(keys).join(TAB));
    rows.forEach(function (row, i) {
      out.push([i + 1].concat(keys.map(function (k) { return row[k] === '' || row[k] === undefined ? '-' : row[k]; })).join(TAB));
    });
    return out.join(NL);
  }

  /* 程序化颗粒（确定性噪声）：用于把"纹理/颗粒"烘焙进笔尖，或在 Procreate 里生成 Grain.png */
  function grainValue(x, y, seed) {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) ^ 0x5bf03635;
    h = (h ^ (h >> 13)) * 1274126177;
    h = h ^ (h >> 16);
    return ((h >>> 0) % 1000) / 999;
  }

  function grainNoise(w, h, seed, scale) {
    scale = Math.max(1, Math.round(scale || 3));
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 低频 + 高频混合，接近纸纹/颗粒
        const lf = grainValue(Math.floor(x / scale), Math.floor(y / scale), seed);
        const hf = grainValue(x, y, seed + 7);
        out[y * w + x] = Math.max(0, Math.min(1, lf * 0.65 + hf * 0.35));
      }
    }
    return out;
  }

  /* 用源笔刷的真实纹理（ABR 图案 / Procreate Grain）烘焙；没有真实像素时保持原样，
     不生成程序化噪声（伪造纹理会让笔刷图案偏离原笔刷）。 */
  function bakeTextureIntoRGBA(rgba, w, h, brush, strength, tone, alphaFloor) {
    const rawStrength = strength === undefined ? 0.35 : Number(strength);
    // NaN/Infinity 经 Math.min/max 仍是 NaN，写入 Uint8Array 后会变成 0，
    // 导致整支笔尖透明；非有限输入按既有默认强度处理。
    const k = Number.isFinite(rawStrength) ? Math.max(0, Math.min(1, rawStrength)) : 0.35;
    const tex = textureGray(brush);
    if (!tex) return rgba;
    // Use the same midpoint adjustment as the stroke lab's grain preview.
    const toneCurve = tone && (tone.brightness || tone.contrast)
      ? Float64Array.from({ length: 256 }, function (_, i) {
          return Math.max(0, Math.min(1, 0.5 + tone.brightness / 100 + (1 + tone.contrast / 100) * (i / 255 - 0.5)));
        })
      : null;
    /* Procreate 的「纹理缩放」与「深度最小值」以前没参与烘焙：
       - textureScale > 1 → 纹理更大，< 1 → 更细（坐标缩放 + 平铺）；
       - grainDepthMinimum → 纹理暗部不应完全透明（否则整条笔迹发黑）；
       未指定时保持旧行为（0.15 底部 + 不缩放），避免改变已有笔刷的观感。 */
    const scale = Math.max(0.02, Math.min(20, brush && brush.textureScale ? brush.textureScale : 1));
    const useScale = Math.abs(scale - 1) > 0.001;
    /* 原生 Procreate 存弧度，采样向量要作反向旋转；其它来源沿用旧输入单位。 */
    const rotRaw = brush && brush.textureRotation ? Number(brush.textureRotation) : 0;
    const rotRad = brush && brush.textureRotationIsRadians ? -rotRaw
      : (Math.abs(rotRaw) <= 1 ? rotRaw * Math.PI * 2 : rotRaw * Math.PI / 180);
    const useRot = Math.abs(rotRad) > 1e-4;
    const minDepth = brush && brush.grainDepthMinimum !== undefined && brush.grainDepthMinimum > 0
      ? Math.max(0, Math.min(1, brush.grainDepthMinimum)) : 0.15;
    const invScale = useScale ? 1 / scale : 1;
    /* 【第400轮（作者：Lead）】alphaFloor：烘焙至少要保留多少笔尖 alpha。
       先空扫一遍拿实际保留率 ratio，再按 s=(1-floor)/(1-ratio) 等比减弱衰减后写盘，
       使最终保留率精确落在 floor。floor=1（ABR / BRU / 非 Procreate 源）时跳过空扫、
       写盘分支与旧版逐字节相同（不引入 1-x 的浮点误差）。 */
    const __floor = Number.isFinite(alphaFloor) ? Math.max(0.05, Math.min(1, alphaFloor)) : 1;
    const cosR = useRot ? Math.cos(rotRad) : 1, sinR = useRot ? Math.sin(rotRad) : 0;
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    let __sumBefore = 0, __sumRawAfter = 0;
    if (__floor < 1) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const a = rgba[i * 4 + 3];
          if (!a) continue;
          let sx = x, sy = y;
          if (useRot) {
            const dx = x - cx, dy = y - cy;
            sx = dx * cosR - dy * sinR + cx;
            sy = dx * sinR + dy * cosR + cy;
          }
          let tx = Math.floor(sx * tex.w / Math.max(1, w) * invScale);
          let ty = Math.floor(sy * tex.h / Math.max(1, h) * invScale);
          if (useScale || useRot) {
            tx = ((tx % tex.w) + tex.w) % tex.w;
            ty = ((ty % tex.h) + tex.h) % tex.h;
          } else {
            tx = Math.min(tex.w - 1, tx);
            ty = Math.min(tex.h - 1, ty);
          }
          const gray = tex.gray[ty * tex.w + tx];
          const v = toneCurve ? toneCurve[gray] : gray / 255;
          const factor = 1 - k + k * (minDepth + (1 - minDepth) * v);
          __sumBefore += a;
          __sumRawAfter += Math.max(0, Math.min(255, Math.round(a * factor)));
        }
      }
    }
    const __rawRatio = __sumBefore > 0 ? __sumRawAfter / __sumBefore : 1;
    const __damp = (__floor < 1 && __rawRatio < __floor) ? (1 - __floor) / (1 - __rawRatio) : 1;
    __sumBefore = 0;
    let __sumAfter = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const a = rgba[i * 4 + 3];
        if (!a) continue;
        let sx = x, sy = y;
        if (useRot) {
          const dx = x - cx, dy = y - cy;
          sx = dx * cosR - dy * sinR + cx;
          sy = dx * sinR + dy * cosR + cy;
        }
        let tx = Math.floor(sx * tex.w / Math.max(1, w) * invScale);
        let ty = Math.floor(sy * tex.h / Math.max(1, h) * invScale);
        if (useScale || useRot) {
          tx = ((tx % tex.w) + tex.w) % tex.w;
          ty = ((ty % tex.h) + tex.h) % tex.h;
        } else {
          tx = Math.min(tex.w - 1, tx);
          ty = Math.min(tex.h - 1, ty);
        }
        const gray = tex.gray[ty * tex.w + tx];
        const v = toneCurve ? toneCurve[gray] : gray / 255;
        const factor = 1 - k + k * (minDepth + (1 - minDepth) * v);
        /* 【第399轮（作者：Lead）】累加烘焙前后 alpha 总量，供 compensateFlowPct 判断压淡幅度 */
        /* 【第400轮】__damp===1 时直接用 factor，保证不改变既有路径的逐字节结果 */
        const __f = __damp === 1 ? factor : 1 - __damp * (1 - factor);
        const __newA = Math.max(0, Math.min(255, Math.round(a * __f)));
        rgba[i * 4 + 3] = __newA;
        __sumBefore += a;
        __sumAfter += __newA;
      }
    }
    rgba.__bakeAlphaRatio = __sumBefore > 0 ? __sumAfter / __sumBefore : 1;
    rgba.__bakeRawRatio = __rawRatio;   /* 阻尼前的原始保留率（诊断用） */
    rgba.__bakeDampScale = __damp;      /* 衰减被等比减弱的比例，1 = 未阻尼 */
    return rgba;
  }

  function bakeGrainIntoRGBA(rgba, w, h, strength, seed) {
    const noise = grainNoise(w, h, seed || 1, 3);
    const rawStrength = strength === undefined ? 0.35 : Number(strength);
    const k = Number.isFinite(rawStrength) ? Math.max(0, Math.min(1, rawStrength)) : 0.35;
    for (let i = 0; i < w * h; i++) {
      const a = rgba[i * 4 + 3];
      if (!a) continue;
      const n = 1 - k + k * noise[i];
      rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(a * n)));
    }
    return rgba;
  }

  /* ---------- 一键安装脚本（放进输出 ZIP，用户双击即可装进目标软件） ---------- */
  function makeInstallScripts(target) {
    const NL = String.fromCharCode(13, 10);
    const files = [];
    const mk = (name, text) => files.push({ name: name, data: util.utf8Encode(text) });
    if (target === 'abr') {
      mk('安装到Photoshop.ps1', [
        '$ErrorActionPreference = "SilentlyContinue"',
        '# 自动把 .abr 放进 Brushes、把 .pat 放进 Patterns（PS 启动时自动加载，无需手动导入）',
        '$roots = @()',
        '$roots += Join-Path $env:APPDATA "Adobe"',
        '$roots += "C:\Program Files\Adobe"',
        '$roots += "D:\Program Files\Adobe"',
        '$roots += "H:\ps"',
        'foreach ($root in $roots) {',
        '  if (-not (Test-Path $root)) { continue }',
        '  $psDirs = Get-ChildItem $root -Directory -Recurse -Depth 2 -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "Adobe Photoshop*" }',
        '  foreach ($ps in $psDirs) {',
        '    $br = Join-Path $ps.FullName "Presets\Brushes"',
        '    $pt = Join-Path $ps.FullName "Presets\Patterns"',
        '    if (Test-Path $br) { Get-ChildItem $PSScriptRoot -Filter *.abr -File | Copy-Item -Destination $br -Force; Write-Host ("画笔 -> " + $br) }',
        '    if (Test-Path $pt) { Get-ChildItem $PSScriptRoot -Filter *.pat -File | Copy-Item -Destination $pt -Force; Write-Host ("图案 -> " + $pt) }',
        '  }',
        '}',
        'Write-Host "完成。请重启 Photoshop，画笔在「画笔」面板，纹理图案在「图案」面板。"',
        'Write-Host "（若提示找不到目录，请手动把 .abr 拖进 Brushes、.pat 拖进 Patterns）"'
      ].join(NL));
      mk('安装到Photoshop.bat', ['@echo off', 'chcp 65001 >nul', 'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装到Photoshop.ps1"', 'pause', ''].join(NL));
      mk('安装说明.txt', [
        'Photoshop 安装说明（一键）',
        '1）运行「安装到Photoshop.bat」：自动把 .abr 放入 Brushes、.pat 放入 Patterns',
        '2）重启 Photoshop：画笔面板能看到笔刷，图案面板能看到纹理图案',
        '3）画笔设置 → 纹理里选中该图案，深度/缩放可调',
        '',
        '手动方式：',
        '· 画笔：画笔面板 ☰ → 载入画笔 → 选 .abr',
        '· 图案：图案面板 ☰ → 导入图案 → 先导入 .pat（必须在画笔之前）',
        '提示：.pat 是纹理图案，.abr 里的纹理引用需要它先存在。'
      ].join(NL));
    } else if (target === 'gbr' || target === 'gih') {
      mk('安装到GIMP.ps1', [
        '$ErrorActionPreference = "Stop"',
        '$dst = Join-Path $env:APPDATA "GIMP"',
        '$dir = Get-ChildItem $dst -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1',
        'if (-not $dir) { Write-Host "未找到 GIMP 用户目录（先运行一次 GIMP）"; exit 1 }',
        '$brushes = Join-Path $dir.FullName "brushes"',
        'if (-not (Test-Path $brushes)) { New-Item -ItemType Directory -Path $brushes | Out-Null }',
        'Get-ChildItem -Path (Join-Path $PSScriptRoot \'*\') -Include *.gbr,*.gih -File | Copy-Item -Destination $brushes -Force',
        'Write-Host ("已复制到 " + $brushes)',
        'Write-Host "重启 GIMP 后生效"'
      ].join(NL));
      mk('安装到GIMP.bat', ['@echo off', 'chcp 65001 >nul', 'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装到GIMP.ps1"', 'pause', ''].join(NL));
      mk('安装说明.txt', 'GIMP 笔刷安装说明' + NL + '运行「安装到GIMP.bat」，然后重启 GIMP；画笔面板里即可看到。' + NL + '（.gbr 是单支笔刷，.gih 是整包管道）');
    } else if (target === 'myb') {
      mk('安装到MyPaint.ps1', [
        '$ErrorActionPreference = "SilentlyContinue"',
        '$dst = Join-Path $env:APPDATA "mypaint/brushes"',
        'if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }',
        'Get-ChildItem $PSScriptRoot -Filter *.myb -File | Copy-Item -Destination $dst -Force',
        'Write-Host ("已复制到 " + $dst)',
        'Write-Host "重启 MyPaint 后：笔刷 -> 笔刷组 -> 失物招领(Lost & Found) 里查看"',
        'Write-Host "想固定显示在独立分组，请再运行「登记到MyPaint分组.bat」"'
      ].join(NL));
      mk('安装到MyPaint.bat', ['@echo off', 'chcp 65001 >nul', 'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装到MyPaint.ps1"', 'pause', ''].join(NL));
      /* 第167轮真机：MyPaint 2 用 brushes/order.conf 显式登记分组，未登记的 .myb
         会被 brushmanager 放进 lost&found（失物招领），不会出现在默认网格。
         旧说明写「重启后笔刷列表里即可看到」属误导，这里给出准确的分组入口，
         并附一个可选的一键登记脚本（先备份 order.conf，再用无 BOM UTF-8 追加）。 */
      mk('登记到MyPaint分组.ps1', [
        '$ErrorActionPreference = "Stop"',
        '$dst = Join-Path $env:APPDATA "mypaint/brushes"',
        'if (-not (Test-Path $dst)) { Write-Host "brushes directory not found"; exit 1 }',
        '$conf = Join-Path $dst "order.conf"',
        'if (Test-Path $conf) { Copy-Item $conf ($conf + ".bak") -Force }',
        '$names = @(Get-ChildItem $PSScriptRoot -Filter *.myb -File | ForEach-Object { $_.BaseName })',
        '$block = @("Group: brushconv") + $names',
        'if (Test-Path $conf) { $block = @(Get-Content $conf -Encoding UTF8) + $block }',
        '$utf8 = New-Object System.Text.UTF8Encoding $false',
        '[System.IO.File]::WriteAllLines($conf, [string[]]$block, $utf8)',
        'Write-Host "order.conf updated; restart MyPaint -> Brush -> Brush Groups -> brushconv"'
      ].join(NL));
      mk('登记到MyPaint分组.bat', ['@echo off', 'chcp 65001 >nul', 'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0登记到MyPaint分组.ps1"', 'pause', ''].join(NL));
      mk('安装说明.txt', [
        'MyPaint 安装说明（MyPaint 2.x 实测）',
        '1）运行「安装到MyPaint.bat」：把 .myb 复制到 %APPDATA%/mypaint/brushes',
        '2）重启 MyPaint。注意：MyPaint 2 只把 order.conf 登记过的笔刷放进分组，',
        '   直接复制的文件会进「笔刷 -> 笔刷组 -> 失物招领(Lost & Found)」，',
        '   不会自动出现在默认笔刷网格里。这是 MyPaint 的机制，不是笔刷损坏。',
        '3）想固定显示在独立分组：运行「登记到MyPaint分组.bat」（会先备份 order.conf），',
        '   重启后在「笔刷 -> 笔刷组 -> brushconv」里查看。',
        '',
        '手动登记格式（brushes/order.conf，UTF-8 无 BOM）：',
        '  Group: brushconv',
        '  <笔刷文件名，不含 .myb>',
        '说明：.myb 里的 parent_brush_name 带 brushconv/ 前缀是本工具用来保存显示名的，',
        '不是 MyPaint 的父笔刷引用，不影响加载。'
      ].join(NL));
    } else if (target === 'kbundle') {
      mk('安装到Krita.ps1', [
        '$ErrorActionPreference = "SilentlyContinue"',
        '$dst = Join-Path $env:APPDATA "krita"',
        'if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }',
        'Get-ChildItem $PSScriptRoot -Filter *.bundle -File | Copy-Item -Destination $dst -Force',
        'Write-Host ("已复制到 " + $dst)',
        'Write-Host "注意：Krita 5 不会因复制文件自动注册预设，必须走 GUI 导入"',
        'Write-Host "Krita -> 设置 -> 管理资源库 -> + 导入 -> 选 .bundle -> 打开"'
      ].join(NL));
      mk('安装到Krita.bat', ['@echo off', 'chcp 65001 >nul', 'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装到Krita.ps1"', 'pause', ''].join(NL));
      mk('安装说明.txt', [
        'Krita 笔刷包安装说明（Krita 5.x 实测）',
        '重要：Krita 5 改用 SQLite 资源库，直接把 .bundle 复制到用户目录只会在',
        '「设置 -> 管理资源库」列表里显示，不会注册到画笔预设，必须走 GUI 导入：',
        '1）Krita -> 设置 -> 管理资源库 -> 「+ 导入」',
        '2）在文件对话框里选中本目录的 .bundle -> 打开',
        '3）导入后在列表里选中该包确认状态；新建画布，在「画笔预设」里按名称搜索',
        '',
        '「安装到Krita.bat」只是把 .bundle 放到 %APPDATA%/krita/ 方便第 1 步选取，',
        '不能代替 GUI 导入。把 .kpp 展开到 paintoppresets/ 同样不会自动注册。'
      ].join(NL));
    } else if (target === 'medibang') {
      mk('安装说明.txt', [
        'MediBang 笔刷安装说明',
        '每个 zip 解压后运行里面的「安装.bat」，会写入 MediBang 笔刷目录',
        '全部装完后重启 MediBang Paint Pro，笔刷列表末尾即可看到。'
      ].join(NL));
    } else if (target === 'brushset' || target === 'brush') {
      mk('安装到Procreate.txt', [
        'Procreate 笔刷安装说明',
        '1. 把 .brush/.brushset 传到 iPad（AirDrop / iCloud / 文件 App）',
        '2. 在「文件」里点该文件 → 用 Procreate 打开；或直接拖进 Procreate 画笔库',
        '.brushset 是整包，会新增一个画笔组。'
      ].join(NL));
    } else if (target === 'gobrush' || target === 'gopaint_set') {
      mk('安装到天生会画.txt', '天生会画：打开 App → 画笔 → 导入笔刷 → 选择 .gobrush（组文件选 .gobrushes）。');
    } else if (target === 'painter') {
      mk('安装到CorelPainter.txt', 'Corel Painter：笔刷选择器 → 导入 → 笔刷类别（.brushcategory）。');
    }
    return files;
  }

  /* ---------- 转换差异报告：每支笔刷在目标格式里保留了哪些、丢了哪些 ---------- */
  function reportTarget(target) {
    return {tpl:'abr',udongman:'abr',udongman_sut:'sut',udongman_mtd:'mtd',gopaint:'gobrush',gopaint_set:'gobrush',gopaint_abr:'abr'}[target] || target;
  }

  function formatSpacingPercent(value) {
    const spacing = Number(value);
    const rounded = spacing > 0 && spacing < 0.1 ? Number(spacing.toPrecision(3)) : Math.round(spacing * 10) / 10;
    return rounded + '%';
  }

  function conversionStatus(brush, target, key, supported, opts, rawCache) {
    opts = opts || {};
    if(opts.pressure===undefined && (opts.pressureMode==='off' || opts.pressureMode==='on')) {
      opts=Object.assign({},opts,{pressure:opts.pressureMode==='on'});
    }
    target = reportTarget(target);
    const raw = rawCache && rawCache.has(brush) ? rawCache.get(brush) : !opts.forceRebuild && opts.fidelity !== false &&
      (((target === 'brush' || target === 'brushset') && procreate.unchanged(withExportSettings(brush,opts),opts)) ||
       (target === 'abr' && opts.preserveRaw !== false && brush._rawPreset && rawBrushUnchanged(brush,opts)) ||
       (target === 'gobrush' && opts.noTextureBake !== true && brush._rawGobrush && rawBrushUnchanged(brush, opts)) ||
       (target === 'painter' && brush._painterRaw && brush._painterRaw.xml && brush._painterRaw.nib && rawBrushUnchanged(brush, opts)) ||
       (target === 'gbr' && brush._rawKind === 'gbr' && brush._rawFile && rawBrushUnchanged(brush, opts)) ||
       (target === 'myb' && brush._rawMyb && rawBrushUnchanged(brush, opts)));
    if (rawCache) rawCache.set(brush, raw);
    const sub=brush.dualSubBrush;
    if ((target==='brush'||target==='brushset') && key==='dualOn' && sub && sub._rawArchive && !sub.tip &&
        brush._rawDualTipState===util.brushFingerprint({tip:brush.dualTip})) {
      if(opts.fidelity===false||opts.forceRebuild)return '近似（副笔缺少原图，重建使用计算圆头）';
      if(sub.flipX||sub.flipY)return '未完整写入（副笔缺少内置原图，引用已保留，固定翻转未写出）';
      return '原生副笔引用保留（缺少副笔原图，笔触待验证）';
    }
    if (raw) return '原样保留';
    if ((target === 'sut' || target === 'mtd') && (key === 'flipX' || key === 'flipY')) {
      // CSP 没有「固定翻转」字段；带翻转的源会被强制重建，把镜像烘进主笔尖素材像素。
      if (!brush.tip) return '未写出（缺少笔尖图，内置圆形笔尖没有翻转）';
      return '近似（固定翻转已烘焙进主笔尖素材，笔触待验证）';
    }
    if (['brush','brushset','sai2','painter'].indexOf(target) >= 0 && (key === 'flipX' || key === 'flipY')) {
      if ((target === 'brush' || target === 'brushset') && brush._rawArchive && !brush.tip && opts.fidelity !== false && !opts.forceRebuild)
        return '未写出（缺少内置笔尖原图，无法烘焙固定翻转）';
      return '近似（固定翻转已烘焙进笔尖资源，角度/圆度继续使用原生参数；笔触待验证）';
    }
    if (target === 'png' && ['sizePx','spacingPct','opacity','pressureSize','pressureOpacity'].indexOf(key) >= 0)
      return '未写入PNG（此项仅能随附在参数说明中，导入图片后需手动设置）';
    if (['png','gobrush','medibang','mbini','gbr','gih'].indexOf(target) >= 0 && ['angle','roundness','flipX','flipY'].indexOf(key) >= 0)
      return '近似（静态几何已烘焙进笔尖图，旋转/圆度动态未等价写入）';
    if (target === 'kbundle' && ['roundness','flipX','flipY'].indexOf(key) >= 0 &&
        !(brush._rawXml && opts.fidelity !== false && !opts.forceRebuild) && brush.tip)
      return '近似（采样笔尖圆度/翻转已烘焙，角度由原生字段表达）';
    if (target === 'abr' && (key === 'flipX' || key === 'flipY')) return '参数映射（PS笔尖翻转字段，笔触待验证）';
    if (['medibang','mbini'].indexOf(target) >= 0 && key === 'spacingPct') return '未写入（当前位图INI没有等价间距映射，需在目标软件手动设置）';
    if (target === 'gobrush' && key === 'textureDepth' && brush.hasTexture) {
      if (opts.noTextureBake === true) return '未写出（已关闭纹理输出）';
      if (opts.grainMode === 'tip') return '近似（按选项用笔尖生成纹理，未保留独立原纹理）';
      return textureGray(brush) ? '近似（真实grain图已写入，比例/混合/压力动态待标定）' : '未写出（缺少原纹理图，已关闭纹理层）';
    }
    if (target === 'painter' && key === 'textureDepth' && brush.hasTexture) return '未完整写入（只有XML深度，未打包独立Painter材质）';
    if (target === 'sut' || target === 'mtd') {
      if (key === 'textureDepth' && brush.hasTexture) return textureGray(brush)
        ? '近似（纹理已写入独立素材，强度/比例及混合需目标软件核对）' : '未写出（缺少可读纹理图）';
      if (key === 'dualOn') return '未完整写入（副笔参数已写入，副笔尖使用内置圆形）';
    }
    if (key === 'sizePx' && target === 'gobrush') return '近似（按300dpi真机标定换算，尺寸百分比取整；其他DPI和真实压感笔迹待复测）';
    if (key === 'colorDynamicsOn' && target === 'bru' && brush.source === 'procreate' &&
        brush._params && brush._params.dynamicsPressureSecondaryColor > 0.001) {
      return opts.pressure === false ? '参数映射（按导出设置关闭压力副色）'
        : '近似（副色强度写入颜色压力，源压力曲线未映射）';
    }
    if (key === 'spacingPct' && target === 'bru') {
      const override = opts.spacingOverride > 0 ? opts.spacingOverride : undefined;
      const changes = [];
      const reportSpacing = (label, spacing) => {
        const value = override === undefined ? spacing : override;
        if (value === 0) changes.push(label + '自动间距按' + BRU_AUTO_SPACING_PCT + '%写出');
        else if (value > 0 && value < BRU_MIN_SPACING_PCT) {
          changes.push(label + '间距按当前BRU写出下限设为' + BRU_MIN_SPACING_PCT + '%');
        }
      };
      reportSpacing('主笔', brush.spacingPct);
      const nativeDual = opts.embedSubTip === true || opts.bruEmbed === true || opts.dualPair !== false;
      if (nativeDual && brush.dualOn && brush.dualTip) {
        const info = brush.dualBrush || {};
        reportSpacing('副笔', info.spacing === undefined ? brush.spacingPct : info.spacing);
      }
      if (changes.length) return '近似（' + changes.join('，') + '）';
    }
    if (brush.source === 'procreate' && target !== 'brush' && target !== 'brushset') {
      if (key === 'angle') {
        const native=brush._params||{}, rotation=Number(native.shapeRotation)||0;
        const adjusted=withExportSettings(brush,opts),before=brush._rawNormalized;
        if (before && (brush.bruRotationMode!==before.bruRotationMode || brush.dynamicsControlAngle!==before.dynamicsControlAngle)) {
          if (adjusted.bruRotationMode===1) return '参数映射（按修改开启完整方向跟随）';
          if (!adjusted.bruRotationMode && !adjusted.dynamicsControlAngle) return '参数映射（按修改关闭方向跟随）';
        }
        if (native.shapeAzimuth) return '未完整写入（原生手写笔方位角未映射，未替换为笔迹方向）';
        if (Math.abs(rotation)>0.000001 && Math.abs(rotation-1)>0.000001) return '未完整写入（部分或反向方向跟随未映射，保留固定朝向）';
        if (Math.abs(rotation-1)<0.000001) return '参数映射（完整跟随笔迹方向；原生轨迹效果仍需复测）';
      }
      if (key === 'opacity') return '近似（原生上下限插值；压力流量与叠色渲染未完全映射' + (target === 'bru' && opts.bruDensity === 'auto' ? '；已开启浓度归一' : '') + '）';
      if (key === 'spacingPct') return '近似（保留间距滑块；原生采样步长含最小偏移，实际点距待标定）';
      if (key === 'scatterPct' && brush.scatterPct > 0) return '近似（原生径向采样；位置散布幅度仍待目标引擎标定）';
      if (key === 'angleJitterDeg') return '近似（原生弧度范围已换算；目标角度上限与随机分布不同）';
      if (key === 'countJitterPct' && brush.countJitterPct > 0) return '近似（原生随机额外数量后加基础笔尖；目标数量分布不同）';
    }
    if (key === 'angle' && (target === 'brush' || target === 'brushset') && brush.source !== 'procreate' &&
        ((brush.dynamicsControlAngle && brush.dynamicsControlAngle!==6) || (brush.bruRotationMode && brush.bruRotationMode!==1))) return '未完整写入（当前Procreate重建只映射完整方向跟随，其余角度控制仍需适配）';
    if (key === 'opacity' && (target === 'brush' || target === 'brushset') && brush.opacity < 0.01) return '近似（Procreate原生不透明度计算最低1%，不能视为完全透明）';
    if (key === 'roundness' && (target === 'brush' || target === 'brushset') && pressureSizeOn(brush) && brush.roundness < (brush.minSizeRatio || 0) * 100) return '近似（Procreate尺寸下限限制最小圆度，无法完全压扁）';
    if (key === 'sizePx' && ['gbr','gih','bru','sai2','myb'].indexOf(target) >= 0) {
      const requested = withExportSettings(brush, opts).sizePx;
      if (target === 'bru' && (requested < 1 || requested > 3000)) return '近似（当前BRU转换写端限制1–3000px，实际为' + Math.max(1, Math.min(3000, requested)) + 'px；未据写端常量推定原生上限）';
      if (target === 'gbr' || target === 'gih') {
        const limit = Math.max(1, Math.min(2048, opts.maxTipSize || 2048));
        const actual = Math.max(1, Math.min(limit, Math.round(requested)));
        if (actual !== requested) return '近似（图像像素即尺寸，受笔尖最大边长' + limit + 'px及整数像素限制，当前单笔资源为' + actual + 'px；图像管还使用公共单元）';
      }
      if ((target === 'sai2' || target === 'myb') && requested < 1) return '近似（当前写端最小尺寸1px）';
    }
    if (key === 'sizePx' && (target === 'brush' || target === 'brushset')) {
      const adjusted = withExportSettings(brush, opts);
      const spacing = Math.max(0, Number(adjusted.spacingPct === undefined ? 10 : adjusted.spacingPct) || 0) / 100;
      const limit = 256 * (1 + 15 * Math.min(1, spacing / 0.02));
      if (adjusted.sizePx > limit) return '近似（超过Procreate当前间距下的尺寸上限，已缩小至上限）';
    }
    if (key === 'eraser' && target === 'kbundle' && brush.eraserAmount > 0 && brush.eraserAmount < 1) return '近似（连续橡皮强度映射为橡皮开关）';
    if (target === 'sai2' && ['opacity','minSizeRatio','minOpacityRatio','hardness','pressureSize','pressureOpacity','smudgeOn','wetEdgesOn','smoothingStrength'].indexOf(key) >= 0) return opts.pressure === false && (key === 'pressureSize' || key === 'pressureOpacity')
      ? '兼容参数（按导出设置关闭压感；写进包内 SAI2参数记录.txt，不是新版原生工具预设）'
      : '兼容参数（写进包内 SAI2参数记录.txt，需在SAI2工具里设置；不是新版原生工具预设）';
    if (target === 'sai2' && key === 'flowPct') return '参数映射（写入散布INI的Density与参数记录的bfval，笔触待验证）';
    if (target === 'sai2' && brush.scatterOn === false && ['scatterCount','countJitterPct'].indexOf(key) >= 0) return '未启用';
    if (key === 'scatterCount' && (target === 'brush' || target === 'brushset') && brush.scatterCount > 16) return '近似（目标写端最多16个笔尖，数量已限制为16）';
    if (target === 'sai2' && key === 'angleJitterDeg') return '近似（转换为SAI2角度随机百分比，实际角度范围待原生标定）';
    if (target !== 'sai2' && key === 'roundness' && brush._sai2AspectOriginalTip) return '近似（原始横扁宽高比已烘焙进笔尖，像素取样存在舍入）';
    if (key === 'spacingPct' && ['kbundle','sai2','gbr','gih','myb'].indexOf(target) >= 0 && !(target === 'kbundle' && brush._rawXml && opts.fidelity !== false && !opts.forceRebuild)) {
      const spacing = opts.spacingOverride > 0 ? opts.spacingOverride : brush.spacingPct;
      const min = target === 'kbundle' ? (brush.tip ? 0.5 : 1) : 1;
      const max = target === 'kbundle' ? 500 : target === 'myb' ? 200 : 1000;
      if (spacing < min || spacing > max) return '近似（间距超出当前写端范围，已限制为' + min + '–' + max + '%）';
    }
    if (key === 'smudgeOn' && target === 'kbundle') return '未完整写入（当前重建使用像素画笔，未建立专用混色引擎）';
    if (key === 'sizePx' && target === 'bru' && brush.source === 'procreate') return '近似（按Procreate 5.3.8原生尺寸公式换算；画世界至少1px，倾斜/缩放及实际笔迹待真机复核）';
    if (key === 'opacity' && target === 'bru' && brush.source !== 'bru' && opts.bruDensity === 'auto') return '近似（已开启浓度归一，可能调整整体不透明度）';
    if (key === 'scatterPct' && target === 'bru' && brush.source === 'procreate' && brush.scatterPct === 0 && brush.scatterCount > 1) return '参数映射（源位置散布为0，开关用于笔尖数量；旋转散布另写旋转随机）';
    if (key === 'scatterPct' && brush.scatterOn === false) return '未启用';
    if (key === 'angleJitterDeg' && target === 'bru' && brush.source === 'abr') {
      const unsupported = [1,3,4,7,8].indexOf(brush.dynamicsControlAngle) >= 0;
      if (!brush.angleJitterDeg && !unsupported) return '参数映射（无角度随机，旋转方式按已知控制源写入）';
      return '近似（PS角度随机百分比换算为BRU角度范围' + (unsupported ? '；源角度控制未映射，未强制跟随笔迹' : '；旋转方式按已知控制源映射') + '，实际笔迹待验证）';
    }
    if(opts.pressure===false && ['abr','brush','brushset','myb','kbundle','sai2','bru'].indexOf(target)>=0 &&
        (key==='pressureSize' || key==='pressureOpacity')) return '参数映射（按导出设置关闭压感）';
    if(supported && opts.fidelity!==false && !opts.forceRebuild &&
      (((target==='brush'||target==='brushset')&&brush._rawArchive) || (target==='abr'&&opts.preserveRaw!==false&&brush._rawPreset)))return '原生参数局部更新（保留未知字段）';
    if (target === 'myb' && (key === 'dualOn' || key === 'textureDepth')) return '丢失（MyPaint当前仅输出参数化笔尖）';
    if (target === 'abr' && key === 'smudgeOn') return '丢失（当前转换路径未映射）';
    if (target === 'abr' && key === 'taperOn') {
      if (!brush.taperOn) return '未启用';
      return abrTaperFade(brush).applied ? '近似（锥度按 PS 渐隐模拟收笔，笔触待验证）' : '丢失（笔压/倾斜已占用控制源，渐隐无法叠加）';
    }
    if (target === 'abr' && key === 'smoothingStrength') {
      if (!brush.smoothingStrength) return '未启用';
      return '参数映射（PS 原生平滑，CSP 是否读取待验证）';
    }
    if ((target === 'brush' || target === 'brushset') && key === 'flowPct') return '丢失（流量尚无独立映射）';
    if ((target === 'brush' || target === 'brushset') && key === 'hardness') return '近似（由笔尖图像表现硬度）';
    if (key === 'dualOn') {
      if (target === 'abr' && brush.source === 'bru' && brush.dualBlendMode === 'linearHeight' &&
          (brush.dualTip || (sub && sub.bruProceduralTip))) {
        return '近似（线性高度改为实色混合，描边笔触需在目标软件核对）';
      }
      if (!brush.dualTip) return '未完整写入（缺少副笔图像）';
      if (target === 'abr' || target === 'brush' || target === 'brushset') return '原生双笔刷（待目标软件验证）';
      if (target === 'bru' && (opts.embedSubTip === true || opts.bruEmbed === true)) return '原生内嵌副笔尖（待目标软件验证）';
      if (target === 'bru' && opts.dualPair !== false) return '原生双笔刷对（待目标软件验证）';
      return opts.dualBake === false ? '丢失（未启用近似合成）' : '近似（烘焙副笔）';
    }
    if (key === 'textureDepth') {
      if (!brush.hasTexture) return '未启用';
      const pixels = brush._rawGrain || brush._grainRgba || brush._patternPixels || brush.grain;
      if (target === 'sai2') return opts.noTextureBake === true ? '未写出（已关闭纹理输出）'
        : (textureGray(brush) ? '配套纹理BMP（需在SAI2手动选择纹理，未自动绑定新版工具预设）' : '未写出（缺少原纹理图）');
      if (target === 'kbundle') {
        if (opts.noTextureBake === true) return '未写出（已关闭纹理输出）';
        if (!brush._rawXml || opts.forceRebuild || opts.fidelity === false) {
          if (!brush.tip) return '未写出（当前过程笔尖分支未附加纹理图）';
          return textureGray(brush) ? '近似（原纹理灰度图已打包；亮度/对比度和目标纹理引擎待标定）' : '未写出（缺少原纹理图，禁用纹理）';
        }
      }
      if (target === 'abr') {
        if (opts.textureMode === 'pattern') {
          return textureGray(brush) ? '参数映射（图案引用，需配套图案验证）' : '未写出（缺少原纹理图，无法生成图案）';
        }
        if (!textureGray(brush)) return '未写出（缺少原纹理图，未伪造纹理）';
        return opts.noTextureBake ? '未完整写入（未烘焙纹理，需配套图案）' : '近似（纹理烘焙进笔尖，不能恢复独立纹理层）';
      }
      if (target === 'brush' || target === 'brushset') {
        if (!pixels) return '未写出（缺少原纹理图，重建时关闭纹理，不生成替代噪声）';
        const raw = opts.fidelity !== false && brush._rawArchive && !opts.forceRebuild;
        if (!raw && usesBruDabTexture(brush, opts)) return '近似（逐笔尖纹理合成到形状，混合和深度动态需实绘核对）';
        return !raw && (opts.noTextureBake === true || opts.grainBake === false)
          ? '未写出（已关闭纹理输出，重建时禁用纹理）' : '参数映射（原纹理图，笔触待验证）';
      }
      if (target === 'bru') {
        if (brush.source !== 'bru') {
          if (!(pixels && opts.noTextureBake !== true)) return '未写出（缺少原图或已关闭烘焙，禁用空纹理避免无墨）';
          const match = bruIndependentTexture(brush, opts);
          if (match && match.fromSubGrain) return '近似（主笔颗粒烘入笔尖，副笔颗粒写入固定在画布上的独立纹理层）';
          if (match && match.grainLayer) return '近似（颗粒原图写入画世界独立纹理层、固定在画布；深度按真机标定 ×0.69）';
          if (match && match.custom) return '近似（规则网点的原纹理图写入独立纹理；移动方式和缩放仍需实绘核对）';
          if (match) return '参数映射（与画世界内置 ' + match.id + ' 逐像素相同；普通硬边圆可写独立纹理，非圆默认烘焙）';
          return opts.bruTexAsset && opts.bruTexAsset !== 'off'
            ? '近似（烘焙进笔尖 + 画世界内置材质纹理层，材质 id 依赖 App 版本）'
            : '近似（真实纹理烘焙进笔尖，未开启单独纹理层）';
        }
        if (brush._rawBruTexture) return '原生写入（保留内嵌纹理原图）';
        return '未完整写入（当前仅纹理参数）';
      }
    }
    if (!supported) return '丢失（当前转换路径未映射）';
    if (key === 'scatterPct' && target === 'bru' && brush.source !== 'bru') {
      if (brush.scatterPct === 0) return '参数映射（位置散布强度为0，缩放不改变数值）';
      return '近似（位置散布×' + (opts.scatterScale === undefined ? (brush.source === 'abr' ? 0.15 : 1) : opts.scatterScale) + '，目标刻度待验证）';
    }
    return '参数映射（笔触待验证）';
  }

  /* 生成「参数对比页」HTML（原参数 vs 目标格式支持情况 + 笔尖缩略图），无需外部样本 */
  function sai2ReportFields(fields, target) {
    if (target !== 'sai2') return fields;
    const pct = function (v) { return Math.round(v) + '%'; };
    const ratio = function (v) { return Math.round(v * 100) + '%'; };
    return fields.concat([['数量随机','countJitterPct',pct],['圆度随机','roundnessJitterPct',pct],
      ['前背景色随机','colorJitterFgBg',ratio],['色相随机','colorJitterHue',ratio],['饱和度随机','colorJitterSat',ratio],['亮度随机','colorJitterVal',ratio]]);
  }

  function buildCompareHtml(brushList, target, meta) {
    const targetLabel = target === 'udongman' ? '优动漫 / CSP（ABR兼容）' : target === 'udongman_sut' ? '优动漫 / CSP 原生 .sut（实验）' : target === 'udongman_mtd' ? '优动漫 / .mtd 绘画助手包（实验）' : target;
    const rawCache = new WeakMap();
    target = reportTarget(target);
    if (target === 'sut') brushList.forEach(function (b) { rawCache.set(b, !!rawSutGroup(b, brushList, meta && meta.options)); });
    const NL = String.fromCharCode(10);
    const fields = [
      ['尺寸', 'sizePx', function (v) { return Math.round(v) + 'px'; }],
      ['间距', 'spacingPct', formatSpacingPercent],
      ['角度', 'angle', function (v) { return Math.round(v) + '°'; }],
      ['圆度', 'roundness', function (v) { return Math.round(v) + '%'; }],
      ['水平翻转', 'flipX', function () { return '开'; }],
      ['垂直翻转', 'flipY', function () { return '开'; }],
      ['不透明度', 'opacity', function (v) { return Math.round(v * 100) + '%'; }],
      ['流量', 'flowPct', function (v) { return Math.round(v * 100) + '%'; }],
      ['硬度', 'hardness', function (v) { return Math.round(v * 100) + '%'; }],
      ['最小直径', 'minSizeRatio', function (v) { return Math.round(v * 100) + '%'; }],
      ['最小不透明度', 'minOpacityRatio', function (v) { return Math.round(v * 100) + '%'; }],
      ['大小随机', 'sizeJitterPct', function (v) { return Math.round(v) + '%'; }],
      ['角度随机', 'angleJitterDeg', function (v) { return Math.round(v) + '°'; }],
      ['散布', 'scatterPct', function (v) { return Math.round(v) + '%'; }],
      ['散布数量', 'scatterCount', function (v) { return String(Math.round(v)); }],
      ['纹理深度', 'textureDepth', function (v) { return Math.round(v * 100) + '%'; }],
      ['锥度', 'taperOn', function () { return '开'; }],
      ['湿边', 'wetEdgesOn', function () { return '开'; }],
      ['混色/涂抹', 'smudgeOn', function () { return '开'; }],
      ['橡皮模式', 'eraser', function () { return '开'; }],
      ['颜色动态', 'colorDynamicsOn', function () { return '开'; }],
      ['平滑', 'smoothingStrength', function (v) { return Math.round(v * 100) + '%'; }],
      ['毛刷笔尖', 'bristle', function (v) { return v.shapeName === 'flatPoint' ? '平点形（扁凿近似）' : (v.shapeName === 'roundDull' ? '圆钝形' : ('形状' + v.shape)); }],
      ['侵蚀/喷枪笔尖', 'dTips', function (v) { return (v.kind === 'erodible' ? '侵蚀·' : '喷枪·') + (v.shapeName || v.shape); }],
      ['双笔刷', 'dualOn', function () { return '开'; }],
      /* 【第279轮】锥度起笔/收笔长度：BRU 原生有（f75/f76，0~8 刻度），Procreate/ABR 的单位与语义
         不同（0~1，且默认值 0.2/0.3），本轮不做换算映射；但**不能静默丢**，进报告里明说。 */
      ['锥度起笔长度', 'taperStartLength', function (v) { return String(Math.round(v * 100) / 100); }],
      ['锥度收笔长度', 'taperEndLength', function (v) { return String(Math.round(v * 100) / 100); }]
    ];
    const support = {
      sut: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','纹理深度','双笔刷'],
      mtd: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','纹理深度','双笔刷'],
      abr: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','角度随机','散布','散布数量','纹理深度','锥度','湿边','混色/涂抹','颜色动态','平滑','双笔刷'],
      bru: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','角度随机','散布','散布数量','纹理深度','锥度','湿边','混色/涂抹','颜色动态','平滑','双笔刷'],
      brushset: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','角度随机','散布','散布数量','纹理深度','锥度','湿边','混色/涂抹','颜色动态','平滑'],
      brush: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','角度随机','散布','散布数量','纹理深度','锥度','湿边','混色/涂抹','颜色动态','平滑'],
      kbundle: ['橡皮模式','尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','散布','纹理深度','混色/涂抹','颜色动态'],
      gbr: ['尺寸','间距','硬度'], gih: ['尺寸','间距','硬度'],
      myb: ['橡皮模式','尺寸','间距','角度','圆度','不透明度','硬度','最小直径','最小不透明度','大小随机','散布','混色/涂抹','颜色动态'],
      painter: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','大小随机','散布'], sai2: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','角度随机','散布','散布数量','数量随机','圆度随机','湿边','混色/涂抹','颜色动态','前背景色随机','色相随机','饱和度随机','亮度随机','平滑','纹理深度'], png: ['尺寸','间距','角度','圆度','不透明度'],
      medibang: ['尺寸','不透明度','最小直径','压感尺寸','压感不透明度'], mbini: ['尺寸','不透明度','最小直径','压感尺寸','压感不透明度'],
      gobrush: ['尺寸','间距','不透明度','最小直径','最小不透明度','流量','散布','纹理深度'],
      gopaint_set: ['尺寸','间距','不透明度','散布','纹理深度'], gopaint_abr: ['尺寸','间距','不透明度','纹理深度']
    };
    const keep = support[target] || [];
    const esc = function (x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    const b64 = function (bytes) {
      if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
      let s2 = '';
      for (let i = 0; i < bytes.length; i += 8192) s2 += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      return btoa(s2);
    };
    const thumb = function (brush) {
      if (!brush) return '';
      let tp = brush.tip;
      if (!tp || !tp.rgba) { try { tp = synthTip(brush); } catch (e) { tp = null; } }
      if (!tp || !tp.rgba) return '';
      try {
        let w = tp.w, h = tp.h, rgba = tp.rgba;
        const max = 96;
        if (Math.max(w, h) > max) {
          const sc = max / Math.max(w, h);
          const nw = Math.max(1, Math.round(w * sc)), nh = Math.max(1, Math.round(h * sc));
          rgba = png.resize(rgba, w, h, nw, nh); w = nw; h = nh;
        }
        const p = png.encode(w, h, rgba);
        return '<img alt="tip" src="data:image/png;base64,' + b64(p) + '">';
      } catch (e) { return ''; }
    };
    const out = [];
    out.push('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">');
    out.push('<title>参数对比 · ' + esc(targetLabel) + '</title>');
    out.push('<style>');
    out.push('body{font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:24px;color:#222;background:#fafafa}');
    out.push('h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}');
    out.push('.meta{color:#666;margin-bottom:16px}');
    out.push('.card{background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:16px;margin-bottom:16px;display:flex;gap:16px;flex-wrap:wrap}');
    out.push('.tip{width:120px;text-align:center;color:#888}.tip img{max-width:96px;max-height:96px;background:#f0f0f0;border-radius:6px}');
    out.push('table{border-collapse:collapse;flex:1;min-width:320px}');
    out.push('th,td{border:1px solid #eee;padding:5px 8px;text-align:left;font-size:13px}');
    out.push('th{background:#f7f7f7;font-weight:600}');
    out.push('.ok{color:#2a7a2a;font-weight:600}.no{color:#b03030;font-weight:600}.off{color:#777}');
    out.push('</style></head><body>');
    out.push('<h1>参数对比</h1>');
    out.push('<div class="meta">目标格式：<b>' + esc(targetLabel) + '</b> · 笔刷数：' + brushList.length + (meta && meta.fileName ? ' · 来源：' + esc(meta.fileName) : '') + '</div>');
    out.push('<div class="meta">状态按当前写出路径判断；参数映射不等于笔触一致，目标软件效果仍需验证。</div>');
    out.push('<div class="meta">双笔刷：ABR / Procreate 写出原生结构，画世界默认输出「单支内嵌副笔尖」或可选「主笔+辅助条目」原生布局；其它目标按选项近似合成。</div>');
    if (MANUAL_ADVICE[target]) out.push('<div class="meta">手动补全建议：' + esc(MANUAL_ADVICE[target]) + '</div>');
    brushList.forEach(function (b, idx) {
      out.push('<div class="card">');
      out.push('<div class="tip">' + thumb(b) + '<div>' + esc(b.name || ('笔刷 ' + (idx + 1))) + '</div></div>');
      out.push('<table><tr><th>参数</th><th>原值</th><th>状态</th></tr>');
      for (const f of sai2ReportFields(fields, target)) {
        const v = b[f[1]];
        if (v === undefined || v === null || v === '' || v === false) continue;
        let text = f[2] ? f[2](v) : String(v);
        if (f[0] === '双笔刷') text = dualDesc(b);
        if (f[1] === 'angleJitterDeg' && b.source === 'abr') text = Math.round(v) + '%（PS）';
        const status = conversionStatus(b, target, f[1], keep.indexOf(f[0]) >= 0, meta && meta.options, rawCache);
        const ok = /^(原样|原生|参数映射)/.test(status);
        out.push('<tr><td>' + esc(f[0]) + '</td><td>' + esc(text) + '</td><td class="' + (status === '未启用' ? 'off' : ok ? 'ok' : 'no') + '">' + esc(status) + '</td></tr>');
      }
      out.push('</table></div>');
    });
    out.push('</body></html>');
    return out.join(NL);
  }

  function dualDesc(brush) {
    const d = brush.dualBrush || {};
    const parts = [];
    if (d.name) parts.push(d.name);
    if (d.blend) parts.push(d.blend);
    if (d.diameter) parts.push(Math.round(d.diameter) + 'px');
    if (d.useScatter) parts.push('散布' + Math.round(d.scatterPct || 0) + '%×' + (d.count || 1));
    return parts.length ? parts.join(' · ') : '开';
  }

  const MANUAL_ADVICE = {
    abr: '纹理：先在 PS 图案面板导入配套 .pat；双笔刷：导入后核对混合模式和笔触',
    bru: '散布：画世界刻度更小，可用「散布换算系数」微调；双笔刷：默认输出画世界 3.0 原生「单支内嵌副笔尖」，高级设置可切回「主笔+辅助条目」',
    brushset: '双笔刷写入 Sub01，倾斜/速度动态分别映射；请在 Procreate 验证笔触',
    brush: '双笔刷写入 Sub01，倾斜/速度动态分别映射；请在 Procreate 验证笔触',
    kbundle: '不透明度/流量曲线：在 Krita「画笔设置」里手动调；双笔刷：已合成近似',
    gbr: '不透明度/圆度：在 GIMP 画笔选项里手动设；散布/动态：GIMP 不支持',
    gih: '不透明度/圆度：在 GIMP 管道画笔选项里手动设',
    myb: '当前仅输出参数化圆形/椭圆笔尖，不写入自定义采样笔尖、双笔或纹理图；速度/倾斜需手动配置',
    painter: '笔尖/半径：Painter 里按 PNG/nib 手动微调；双笔刷：已合成近似',
    sai2: '输出可直接拖进 文档\\SYSTEMAX Software Development 的 SAIv2/settings 目录；包内 SAI2参数记录.txt 是兼容参数文本，不是新版.saitdat原生预设。工具尺寸/浓度/压感与配套纹理需在SAI2中设置',
    png: '仅笔尖图 + 参数文本，需在目标软件里手动建笔刷',
    medibang: '位图笔刷导入后可在 MediBang 里调间距/压感',
    mbini: '复制到 CloudAlpaca 后重启；程序笔刷已转成位图笔刷',
    gobrush: '压力曲线按模板写入，可在天生会画里手动调曲线',
    gopaint_set: '压力曲线按模板写入，可在天生会画里手动调曲线',
    gopaint_abr: '文本参数有限，需在目标软件里补全'
  };

  /* 转出前审计：哪些笔刷**源文件没有 shape（笔尖/形状）图片**。
     这类笔刷转出时只能按参数生成圆形/椭圆笔尖（computed），或只有纹理图（grain）。
     用户要求「转出时明确提示」，所以判断集中在这里，UI 只负责显示。 */
  function tipSourceAudit(brushList) {
    /* 【第271轮】noTip 再拆一层，因为「缺笔尖」有兩種完全不同的成因，提示也该不同：
       · noTipRef   源里**引用了**内置笔尖图（oldTexId/ptN），但这次没取到像素 → 导入素材库能解决
       · paramOnly  源里**根本没有引用任何图**（纯参数化画出来的笔尖）→ 任何图库都补不了，
                    转出后按参数生成圆/椭圆笔尖。这种情况不该报「缺图库」，用户会以为导库没生效。 */
    const out = { noTip: [], noTipRef: [], paramOnly: [], noTipOther: [], procedural: [], grainOnly: [], bruTexOnly: [], bruTexMissing: [], procreateBundledMissing: [], procreateNoTip: 0 };
    for (const b of (brushList || [])) {
      if (!b || b.enabled === false) continue;
      /* 【第272轮】Procreate 的 shape/grain 常常是「引用 App 内置素材库」（bundledShapePath /
         bundledGrainPath），笔刷包里不带图。没导素材库时这些引用解析不出像素，纹理就全丢——
         这是**可修**的，必须提示去导库（以前完全静默，用户只能看到「转出来是实色」）。 */
      let procreatePending = false;
      if (b.source === 'procreate') {
        const wantShape = b.bundledShapePath && b.bundledShapePath !== '$null';
        const wantGrain = b.bundledGrainPath && b.bundledGrainPath !== '$null';
        if ((wantShape && !b.tip) || (wantGrain && !(b._grainRgba && b._grainRgba.w))) {
          out.procreateBundledMissing.push(b.name);
          procreatePending = true;
        }
      }
      const hasTip = !!b.tip; // A secondary image cannot replace the missing primary.
      /* 已归到「等素材库」的 Procreate 笔刷不再重复报「没有笔尖图」：
         它们不是没有图，是图在 App 内置库里、这次没取到。两条一起提示只会互相打脸。 */
      if (procreatePending && !hasTip) continue;
      if (!hasTip) {
        /* 【第198轮】画世界官方「小方块/网点」类：文件里没有笔尖图，图案全靠内置纹理 ptN。
           这不是「缺笔尖」——单独归类，下载纹理库后应提示已补上，而不是继续报缺图。 */
        if (b.source === 'bru' && !b.oldTexId && b.texAssetId && b.hasTexture !== false) {
          if (textureGray(b)) out.bruTexOnly.push(b.name);
          else out.bruTexMissing.push(b.name);
          continue;
        }
        out.noTip.push(b.name);
        if (builtinTipKey(b)) out.noTipRef.push(b.name);
        else if (b.source === 'bru') out.paramOnly.push(b.name);
        else out.noTipOther.push(b.name);
        if (b.computed || b.bruProceduralTip) out.procedural.push(b.name);
        if (b.source === 'procreate') out.procreateNoTip++;
      } else if (b.tipSource === 'grain') {
        out.grainOnly.push(b.name);
      }
    }
    return out;
  }

  function tipSourceHint(audit) {
    /* 【第271轮】只留**需要用户动手**的提示。用户反馈（截图）：导入图库后仍看到
       「源文件没有笔尖图片…」和「已读取源文件内的纹理或从纹理库补上…」这类话，
       既没有可执行动作、又让人以为图库没生效。现在的口径：
         · 引用了内置图但没取到 → 提示导入图库（可解决）
         · 源里压根没有图（参数化笔尖）→ 不提示（补不了，说了也没用）
         · 纹理已补上 → 不提示（既成事实）
         · 只有纹理图没有形状图 → 不提示（导出照常，差异由转换报告覆盖）
       真正要保留的是「图案来自内置纹理但库里没有」——那一步会转成实心圆，必须提示。 */
    const msgs = [];
    const list = Object.assign({ noTip: [], noTipRef: [], paramOnly: [], noTipOther: [], procedural: [], grainOnly: [], bruTexOnly: [], bruTexMissing: [], procreateBundledMissing: [], procreateNoTip: 0 }, audit || {});
    function names(arr, n) {
      const head = arr.slice(0, n).join('、');
      return arr.length > n ? head + ' 等' : head;
    }
    if (list.noTipRef.length) {
      msgs.push(list.noTipRef.length + ' 支笔刷的笔尖图在素材库里没取到：' + names(list.noTipRef, 3) +
        '；到「高级设置 → 素材库」导入笔尖图库后重新导入，否则会按参数生成近似圆形笔尖');
    }
    if (list.bruTexMissing.length) {
      msgs.push(list.bruTexMissing.length + ' 支画世界内置笔刷的图案来自内置纹理，但纹理库里没找到：' + names(list.bruTexMissing, 3) +
        '；请在「高级设置 → 素材库」下载画世界纹理库后重新导入，否则只能转出实心圆笔尖');
    }
    if (list.procreateBundledMissing.length) {
      msgs.push(list.procreateBundledMissing.length + ' 支 Procreate 笔刷的笔尖/纹理引用的是 App 内置素材（包里不带图）：' + names(list.procreateBundledMissing, 3) +
        '；到「高级设置 → 素材库」导入 Procreate 笔尖图库后重新导入这套笔刷，否则形状/颗粒会丢、画出来是实色');
    }
    /* 画世界的参数化笔尖（源里没有图、也没有引用）只归类不提示：补不了，说了也没用。
       其它来源（abr/prbr…）真的没有笔尖图属于异常，仍要提一句「会按参数生成」。 */
    if (list.noTipOther.length) {
      msgs.push(list.noTipOther.length + ' 支笔刷没有笔尖图：' + names(list.noTipOther, 3) + '；会按参数生成近似笔尖');
    }
    return msgs;
  }

  /* 【第302轮（作者：Claude）R302-04】Procreate「Apple Pencil → 压力」自定义曲线的报告口径。
     brushset/brush：原样或写回；Krita / MyPaint：尺寸、不透明度两条按曲线形状近似；其它目标与其余曲线：丢失。 */
  const PRESSURE_CURVE_LABELS = {
    dynamicsPressureSizeCurve: '尺寸', dynamicsPressureOpacityCurve: '不透明度', dynamicsPressureHueCurve: '色相',
    dynamicsPressureSaturationCurve: '饱和度', dynamicsPressureBrightnessCurve: '亮度', dynamicsPressureSecondaryColorCurve: '副色',
    dynamicsPressureBleedCurve: '渗色', dynamicsPressureShapeRoundnessCurve: '圆度', dynamicsPressureTransferModulationCurve: '流量调制',
    dynamicsPressurePlotJitterCurve: '散布', dynamicsPressurePlotJitterLongitudinalCurve: '纵向散布', dynamicsPressurePlotSpacingJitter: '间距抖动',
    dynamicsPressureStampCountCurve: '数量', dynamicsPressureStampCountJitterCurve: '数量抖动', dynamicsPressureShapeScatterCurve: '旋转散布',
    dynamicsPressureSizeJitterCurve: '尺寸抖动', dynamicsPressureOpacityJitterCurve: '不透明度抖动', dynamicsPressureHueJitterCurve: '色相抖动',
    dynamicsPressureShapeRoundessVerticalJitterCurve: '圆度纵向抖动', dynamicsPressureGrainDepthCurve: '纹理深度',
    dynamicsPressureGrainDepthJitterCurve: '纹理深度抖动', dynamicsPressureGrainMovementCurve: '纹理移动', dynamicsPressureGrainScaleCurve: '纹理缩放',
    dynamicsPressureGrainZoomCurve: '纹理缩放(zoom)', dynamicsPressureSmudgePullCurve: '涂抹拉力', dynamicsPressureWetPullCurve: '湿混拉力',
    dynamicsPressureCharge: '湿混载色', dynamicsPressureDilutionCurve: '湿混稀释', dynamicsPressureAttackCurve: '湿混起笔',
    dynamicsPressureGradeCurve: '湿混层次', dynamicsPressureBlurCurve: '湿混模糊'
  };
  /* 【第385轮（作者：Lead，第399轮事故后重新落地）】Procreate 副笔混合在画世界 13 个混合模式里
     没有对应项的有 9 个（screen/add/exclusion/hardLight/color/luminosity/hue/saturation/softLight）。
     写出的值仍是 normal（保持既有行为不变），但报告必须说清楚，不能静默降级。
     只做「如实告知」，不写近似映射：近似值没有实画依据。 */
  const DUAL_BLEND_ZH = {
    screen: '滤色', add: '线性减淡（添加）', exclusion: '排除', hardLight: '强光',
    color: '颜色', luminosity: '明度', hue: '色相', saturation: '饱和度', softLight: '柔光'
  };
  function dualBlendReport(b, target) {
    if (!b || target !== 'bru') return [];
    if (b.source !== 'procreate' || !b.dualOn) return [];
    const name = bru.dualBlendUnmappedName ? bru.dualBlendUnmappedName(b.procreateDualBlendMode) : null;
    if (!name) return [];
    return [{
      kept: false,
      text: '副笔混合「' + (DUAL_BLEND_ZH[name] || name) + '」（Procreate ' + Number(b.procreateDualBlendMode) + '）：画世界无对应模式，已按「正常」写入'
    }];
  }
  /* 【第399轮（作者：Lead）】画布混合（f69）无对应项时必须进损失报告 —— 第389轮全 12 项标定后，
     剩下的强光(12)/排除(5)/滤色(2)… 在画世界没有对应 f69，写侧按 normal 落库，
     这里如实告知，不静默降级（与 dualBlendReport 同构）。 */
  function canvasBlendReport(b, target) {
    if (!b || target !== 'bru') return [];
    if (b.source !== 'procreate') return [];
    const name = hsjModel.canvasBlendUnmappedName ? hsjModel.canvasBlendUnmappedName(b) : null;
    if (!name) return [];
    return [{
      kept: false,
      text: '画布混合「' + name + '」（Procreate ' + Number(b.blendMode) + '）：画世界无对应模式，已按「正常」写出'
    }];
  }
  function pressureCurveReport(b, target) {
    const curves = b && b.procreatePressureCurves;
    if (!curves || typeof curves !== 'object') return [];
    return Object.keys(curves).sort().map(function (key) {
      const label = '压感曲线·' + (PRESSURE_CURVE_LABELS[key] || key);
      const sizeOrOpacity = key === 'dynamicsPressureSizeCurve' || key === 'dynamicsPressureOpacityCurve';
      if (target === 'brushset' || target === 'brush') return { kept: true, text: label + '：原生结构' };
      if (sizeOrOpacity && target === 'kbundle') return { kept: false, text: label + '：近似（Krita 传感器曲线，只换形状）' };
      if (sizeOrOpacity && target === 'myb') return { kept: false, text: label + '：近似（MyPaint 压力输入折线）' };
      return { kept: false, text: label + '：丢失（目标格式没有对应曲线）' };
    });
  }

  function brushLossReport(brushList, targets, opts) {
    const NL = String.fromCharCode(10);
    if (!Array.isArray(targets)) targets = [targets]; // 防呆：传字符串时按字符迭代会生成逐字符假报告
    const fields = [
      ['尺寸', 'sizePx', function (v) { return Math.round(v) + 'px'; }],
      ['间距', 'spacingPct', formatSpacingPercent],
      ['角度', 'angle', function (v) { return Math.round(v) + '°'; }],
      ['圆度', 'roundness', function (v) { return Math.round(v) + '%'; }],
      ['水平翻转', 'flipX', function () { return '开'; }],
      ['垂直翻转', 'flipY', function () { return '开'; }],
      ['不透明度', 'opacity', function (v) { return Math.round(v * 100) + '%'; }],
      ['流量', 'flowPct', function (v) { return Math.round(v * 100) + '%'; }],
      ['硬度', 'hardness', function (v) { return Math.round(v * 100) + '%'; }],
      ['最小直径', 'minSizeRatio', function (v) { return Math.round(v * 100) + '%'; }],
      ['最小不透明度', 'minOpacityRatio', function (v) { return Math.round(v * 100) + '%'; }],
      ['大小随机', 'sizeJitterPct', function (v) { return Math.round(v) + '%'; }],
      ['角度随机', 'angleJitterDeg', function (v) { return Math.round(v) + '°'; }],
      ['散布', 'scatterPct', function (v) { return Math.round(v) + '%'; }],
      ['散布数量', 'scatterCount', function (v) { return String(Math.round(v)); }],
      ['纹理', 'textureDepth', function (v) { return '深度' + Math.round(v * 100) + '%'; }],
      ['压感尺寸', 'pressureSize', function () { return '开'; }],
      ['压感不透明度', 'pressureOpacity', function () { return '开'; }],
      ['锥度', 'taperOn', function () { return '开'; }],
      ['湿边', 'wetEdgesOn', function () { return '开'; }],
      ['混色/涂抹', 'smudgeOn', function () { return '开'; }],
      ['橡皮模式', 'eraser', function () { return '开'; }],
      ['颜色动态', 'colorDynamicsOn', function () { return '开'; }],
      ['平滑', 'smoothingStrength', function (v) { return Math.round(v * 100) + '%'; }],
      ['毛刷笔尖', 'bristle', function (v) { return v.shapeName === 'flatPoint' ? '平点形（扁凿近似）' : (v.shapeName === 'roundDull' ? '圆钝形' : ('形状' + v.shape)); }],
      ['侵蚀/喷枪笔尖', 'dTips', function (v) { return (v.kind === 'erodible' ? '侵蚀·' : '喷枪·') + (v.shapeName || v.shape); }],
      ['双笔刷', 'dualOn', function () { return '开'; }],
      /* 【第279轮】锥度起笔/收笔长度：BRU 原生有（f75/f76，0~8 刻度），Procreate/ABR 的单位与语义
         不同（0~1，且默认值 0.2/0.3），本轮不做换算映射；但**不能静默丢**，进报告里明说。 */
      ['锥度起笔长度', 'taperStartLength', function (v) { return String(Math.round(v * 100) / 100); }],
      ['锥度收笔长度', 'taperEndLength', function (v) { return String(Math.round(v * 100) / 100); }]
    ];
    const support = {
      sut: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','纹理','双笔刷'],
      mtd: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','纹理','双笔刷'],
      abr: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','角度随机','散布','散布数量','纹理','压感尺寸','压感不透明度','湿边','平滑','双笔刷'],
      bru: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','角度随机','散布','散布数量','纹理','压感尺寸','压感不透明度','锥度','湿边','混色/涂抹','颜色动态','平滑'],
      brushset: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','角度随机','散布','散布数量','纹理','压感尺寸','压感不透明度','锥度','湿边','混色/涂抹','颜色动态','平滑'],
      brush: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','角度随机','散布','散布数量','纹理','压感尺寸','压感不透明度','锥度','湿边','混色/涂抹','颜色动态','平滑'],
      kbundle: ['橡皮模式','尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','散布','纹理','压感尺寸','压感不透明度','混色/涂抹','颜色动态'],
      gbr: ['尺寸','间距','硬度'], gih: ['尺寸','间距','硬度'],
      myb: ['橡皮模式','尺寸','间距','角度','圆度','不透明度','硬度','最小直径','最小不透明度','大小随机','散布','压感尺寸','压感不透明度','混色/涂抹','颜色动态'],
      painter: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','大小随机','散布'], sai2: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','压感尺寸','压感不透明度','大小随机','角度随机','散布','散布数量','数量随机','圆度随机','湿边','混色/涂抹','颜色动态','前背景色随机','色相随机','饱和度随机','亮度随机','平滑','纹理深度'], png: ['尺寸','间距','角度','圆度','不透明度'],
      medibang: ['尺寸','不透明度','最小直径','压感尺寸','压感不透明度'], mbini: ['尺寸','不透明度','最小直径','压感尺寸','压感不透明度'],
      gobrush: ['尺寸','间距','不透明度','最小直径','最小不透明度','流量','散布','纹理'],
      gopaint_set: ['尺寸','间距','不透明度','散布','纹理'], gopaint_abr: ['尺寸','间距','不透明度','纹理']
    };
    const reason = {
      abr: 'ABR 支持这些；纹理需配合 .pat 图案（目标 PS 里要有同名图案）',
      bru: '规则软网点可写入独立原纹理；匹配到的内置纹理可直接引用。其它自定义纹理按选项烘焙，实际笔触需验证',
      brushset: 'Procreate 原生双笔刷、倾斜/速度分开写出；不同引擎效果需验证',
      brush: 'Procreate 原生双笔刷、倾斜/速度分开写出；不同引擎效果需验证',
      kbundle: 'Krita 6 元组曲线/颜色率未映射',
      gbr: 'GIMP 格式只有「笔尖 + 间距 + 硬度」',
      gih: 'GIMP 管道格式只有「笔尖 + 间距 + 硬度」',
      myb: '当前MyPaint导出不写入自定义采样笔尖、双笔或纹理图；速度/倾斜未映射',
      painter: 'Painter写出基础XML和有损JPEG笔尖；独立材质及复杂引擎未还原',
      sai2: 'SAI2输出 SAIv2/settings 目录树（拖进去即用）；参数记录仅为兼容文本，新版原生.saitdat工具预设尚未验证',
      png: 'PNG 只导出笔尖图 + 参数文本',
      medibang: 'MediBang 只写基础字段', mbini: 'MediBang 云笔刷只写基础字段',
      gobrush: '天生会画保留原样单支，重建映射主要数值和已知独立压力曲线；原生笔触待验证',
      gopaint_set: '天生会画组写了主要数值参数',
      gopaint_abr: '天生会画 ABR 只写基础参数'
    };
    const lines = [];
    lines.push('转换差异报告（参数级，自动生成）');
    lines.push('========================================');
    lines.push('状态：原样保留 / 原生结构 / 参数映射 / 近似 / 未完整写入 / 丢失');
    lines.push('说明：参数映射不保证笔触一致；ABR/Procreate 支持原生双笔刷，画世界默认输出单支内嵌副笔尖（另可选主笔+辅助条目）。');
    lines.push('');
    for (const requestedTarget of targets) {
      const target = reportTarget(requestedTarget);
      const keep = support[target] || [];
      const rawCache = new WeakMap();
      if (target === 'sut') brushList.forEach(function (b) { rawCache.set(b, !!rawSutGroup(b, brushList, opts)); });
      lines.push('【目标格式：' + (requestedTarget === 'udongman' ? '优动漫 / CSP（ABR兼容）' : requestedTarget === 'udongman_sut' ? '优动漫 / CSP 原生 .sut（实验）' : requestedTarget === 'udongman_mtd' ? '优动漫 / .mtd 绘画助手包（实验）' : target) + '】');
      if (requestedTarget === 'udongman') lines.push('  兼容说明：导出ABR，不是原生SUT；在子工具面板导入，动态/混色/双笔/纹理效果需目标软件核对。');
      if (requestedTarget === 'udongman_sut') lines.push(brushList.every(function (b) { return rawSutGroup(b, brushList, opts); }) ? '  兼容说明：原生 SUT 完整选择且未改动，整个文件原样保留。' : '  兼容说明：原生SUT导出（实验）；未改动的完整原生SUT可原样保留；重建时有图主笔尖/纹理写入单色素材，无笔尖图时用内置圆形；压感等动态、彩色和复杂混合尚未还原。');
      if (requestedTarget === 'udongman_mtd') lines.push('  兼容说明：.mtd=zip+sut绘画助手素材包（实验，未真机验证）；素材与参数限制同.sut目标；无笔尖图时用内置圆形；如绘画助手拒绝导入请改用.sut或ABR兼容目标。');
      if (reason[target]) lines.push('  说明：' + reason[target]);
      let lostTotal = 0, keptTotal = 0, manualTotal = 0;
      brushList.forEach(function (b, i) {
        const has = [], lost = [], manual = [];
        for (const f of sai2ReportFields(fields, target)) {
          const v = b[f[1]];
          const present = v !== undefined && v !== null && v !== '' && v !== false;
          if (!present) continue;
          let text = f[2] ? f[2](v) : String(v);
          if (f[0] === '双笔刷') text = dualDesc(b);
          if (f[1] === 'angleJitterDeg' && b.source === 'abr') text = Math.round(v) + '%（PS）';
          const status = conversionStatus(b, target, f[1], keep.indexOf(f[0]) >= 0, opts, rawCache);
          if (status === '未启用') continue;
          const entry = f[0] + '(' + text + ')：' + status;
          if (/^(兼容参数|配套)/.test(status)) { manual.push(entry); manualTotal++; }
          else if (/^(原样|原生|参数映射)/.test(status)) { has.push(entry); keptTotal++; }
          else { lost.push(entry); lostTotal++; }
        }
        /* 【第302轮（作者：Claude）R302-04】Procreate 自定义压感曲线：以前不读，这里逐条说清去向 */
        pressureCurveReport(b, target).forEach(function (e) {
          if (e.kept) { has.push(e.text); keptTotal++; } else { lost.push(e.text); lostTotal++; }
        });
        dualBlendReport(b, target).forEach(function (e) {
          if (e.kept) { has.push(e.text); keptTotal++; } else { lost.push(e.text); lostTotal++; }
        });
        canvasBlendReport(b, target).forEach(function (e) {
          if (e.kept) { has.push(e.text); keptTotal++; } else { lost.push(e.text); lostTotal++; }
        });
        lines.push('  ' + (i + 1) + '. ' + (b.name || '未命名'));
        /* 【第190轮】内置纹理库补位要在参数报告里明说：只有 textureGray 带
           builtinTexture 时才加这一行；源文件自带像素（_patternPixels / grain 等）
           与无纹理都不加，避免把用户自己的纹理误标成「画世界自带」。 */
        const texSrc = textureGray(b);
        if (texSrc && texSrc.builtinTexture) {
          lines.push('     纹理：内置库 ' + texSrc.builtinTexture + '（画世界自带，非源文件自带像素）');
        }
        lines.push('     写入：' + (has.length ? has.join('、') : '（基础字段）'));
        if (lost.length) lines.push('     丢失：' + lost.join('、'));
        if (manual.length) lines.push('     旁带/手动设置：' + manual.join('、'));
      });
      lines.push('  小结：写入参数 ' + keptTotal + ' 项，近似/未完整写入/丢失 ' + lostTotal + ' 项' + (manualTotal ? '，另有旁带/手动设置 ' + manualTotal + ' 项' : ''));
      if (requestedTarget === 'udongman') lines.push('  手动补全建议：通过子工具/工具组面板导入ABR后检查尺寸、间距与纹理，不把PS图案安装步骤视为优动漫原生流程。');
      else if (requestedTarget === 'udongman_sut' && !brushList.every(function (b) { return rawSutGroup(b, brushList, opts); })) lines.push('  手动补全建议：重建的笔刷导入后核对素材、纹理强度/比例，压感等动态在「子工具详情」面板手动开启。');
      else if (requestedTarget === 'udongman_mtd') lines.push('  手动补全建议：双击 .mtd 用绘画助手导入，核对素材及动态；如绘画助手拒绝导入请改用 .sut 或 ABR 兼容目标。');
      else if (MANUAL_ADVICE[target]) lines.push('  手动补全建议：' + MANUAL_ADVICE[target]);
      lines.push('');
    }
    return lines.join(NL);
  }

  function makeTipPngPack(brushList, opts) {
    opts = opts || {};
    const zipMod = isNode ? require('./zip.js') : root.BC.zip;
    const entries = [];
    const used = new Map();
    brushList.forEach(function (b, i) {
      const made = makeTipPng(b, Object.assign({}, opts, { maxTipSize: Math.max(opts.maxTipSize || 2048, 512) }));
      let base = sanitizeName(b.name, i, true);
      let name = base, k = 2;
      while (used.has(name.toLowerCase())) { name = base + ' (' + k + ')'; k++; }
      used.set(name.toLowerCase(), 1);
      entries.push({ name: name + '.png', data: made.bytes });
    });
    const lines = [
      '笔尖/素材 PNG 导出（v2.4）',
      '============================',
      '这些 PNG 是笔尖形状图（白底+透明度），可直接导入：',
      '  · MediBang Paint：素材/画笔 → 用图片新建自定义笔刷',
      '  · Infinite Painter：笔刷库 → 创建 → 以图片创建笔刷',
      'PNG保留笔尖素材分辨率（受最大边长限制），不等于画笔绘画直径。',
      '随附参数已应用整体尺寸倍数和间距覆盖；导入图片后请在目标软件手动设置尺寸、间距和压感。'
    ];
    entries.push({ name: '说明.txt', data: util.utf8Encode(lines.join('\n')) });
    const adjusted = brushList.map(function (b) { return withExportSettings(b, opts); });
    entries.push({ name: '笔刷参数.txt', data: util.utf8Encode(brushParamText(adjusted)) });
    entries.push({ name: '笔刷参数.json', data: util.utf8Encode(JSON.stringify(adjusted.map(function (b) {
      const info = brushParamInfo(b); const obj = {}; for (const k in info) obj[k] = info[k] === '' ? null : info[k]; return obj;
    }), null, 2)) });
    return { bytes: zipMod.write(entries), count: brushList.length };
  }

  /** Brush list -> Krita resource bundle (.bundle) with GBR tips + presets. */
  function makeKritaBundle(brushList, opts) {
    const list = (brushList || []).map(function (source) {
      const b = Object.assign({}, withExportSettings(source, opts));
      b._kritaPattern = b.hasTexture && !(opts && opts.noTextureBake === true) ? textureGray(b) : null;
      if (b.dualOn && b.dualTip) b.tip = bakedTipFor(Object.assign({}, b, { angle: 0, roundness: 100 }), opts);
      // Sampled Krita tips have a native angle but no common roundness/flip
      // mapping. Bake only the latter and retain original XML on its raw path.
      if (b.tip && !(b._rawXml && (!opts || (opts.fidelity !== false && !opts.forceRebuild)))) {
        b.tip = bakeTipTransform(tipToRGBA(b), Object.assign({}, b, { angle: 0 }));
        b.roundness = 100; b.flipX = false; b.flipY = false;
      }
      return b;
    });
    return krita.writeBundle(list, opts || {});
  }

  /* 源有纹理引用却拿不到纹理像素（画世界内置材质 / Procreate 内置 Grain 等）时，
     SAI2 只会静默不写 brushtex。打包与「自动写入 SAI2 文件夹」两条路都要如实报告，
     否则桌面端用户完全看不到这条警告。 */
  function sai2TextureWarnings(list, opts) {
    if (opts && opts.noTextureBake) return [];
    return (list || []).filter(function (b) {
      return b && b.hasTexture && !b._sai2Texture && !b._sai2FlatTexture;
    }).map(function (b) {
      return (b.name || '未命名') + '：有纹理但缺纹理像素，未输出配套纹理 BMP（需在 SAI2 工具设置里手动选择纹理）';
    });
  }

  /* 大面积纯色笔尖不是真正的形状：Krita auto_brush、Procreate 空形状等来源会给出
     200x200 / 1000x1000 的全白占位图，直接写进 SAI2 就是一支实心方块笔刷。
     小尺寸实心笔尖（2px square 之类）本身合法，保持原样。 */
  function blankSai2Tip(tip) {
    if (!tip || !tip.rgba) return true;
    if (tip.w * tip.h < 64 * 64) return false;
    const first = tip.rgba[3];
    for (let i = 3; i < tip.rgba.length; i += 4) if (tip.rgba[i] !== first) return false;
    return true;
  }
  function flatSai2Texture(texture) {
    if (!texture || !texture.gray || !texture.gray.length) return false;
    const first = texture.gray[0];
    for (let i = 1; i < texture.gray.length; i++) if (texture.gray[i] !== first) return false;
    return true;
  }

  /* 两个 SAI2 出口（ZIP 包 / 桌面自动写入）共用同一套导出前预处理。 */
  function sai2ExportList(brushList, opts) {
    const warnings = [];
    const list = (brushList || []).map(function (source) {
      const b = withExportSettings(source, opts);
      try {
        let tip = bakedTipFor(Object.assign({}, b, { angle: 0, roundness: 100 }), opts || {});
        let flatTex = false;
        let synthTipUsed = false;
        if (blankSai2Tip(tip)) {
          tip = synthTip(Object.assign({}, b, { roundness: 100, angle: 0 }), 256, opts || {});
          synthTipUsed = true;
          warnings.push((b.name || '未命名') + '：源笔尖是空白占位图，已按硬度/圆度合成 SAI2 形状（原自动笔刷参数无法完整还原）');
        }
        /* SAI2 的 brushtex 是纹理素材原图，反相由工具参数 texinvf 决定（toolnrm 里会写）。
           这里若把 textureInverted 烘焙进 BMP，回读时解析器又会带着 texinvf=1 再烘焙一次，
           导出→导入→再导出就在「正/反」之间无限震荡；SAI2 里也会双重反相。 */
        const texSource = Object.assign({}, b, { textureInverted: false });
        let texture = !(opts && opts.noTextureBake) && b.hasTexture ? textureGray(texSource) : null;
        if (flatSai2Texture(texture)) {
          texture = null;
          flatTex = true;
          warnings.push((b.name || '未命名') + '：纹理是纯色图，已跳过 brushtex（纯色纹理在 SAI2 里不产生质感）');
        }
        const out = Object.assign({}, b, { tip: { w: tip.w, h: tip.h, rgba: tip.rgba }, _sai2Texture: texture });
        /* 幂等：占位图这批笔刷的硬度是「合成出来」的，不是外格式原生字段。INI 写侧
           （sai2.js EdgeHardness）按 nativeSource+moved 判定，本就只对外格式来源省键，
           合成路径若也省掉，回读后该笔刷变成 SAI2 原生来源、第二轮会补写 EdgeHardness，
           于是 导出→导入→再导出 出不了逐字节收敛（第163轮定点用例 118 项）。 */
        if (synthTipUsed) out._sai2SynthTip = true;
        if (flatTex) out._sai2FlatTexture = true;
        return withFixedTipFlips(out);
      } catch (e) { return b; }
    });
    return { list: list, warnings: warnings };
  }

  /** 桌面版「保存到 SAI2 笔刷文件夹」用：只算文件清单，不打包。
      返回 { files:[{rel, data}], count, warnings }，rel 形如 SAIv2/settings/scatter/x.bmp。 */
  function makeSai2Files(brushList, opts) {
    const prep = sai2ExportList(brushList, opts);
    const made = sai2.makeSai2Files(prep.list, opts || {});
    made.warnings = (made.warnings || []).concat(prep.warnings, sai2TextureWarnings(prep.list, opts));
    if (made.record) made.files = made.files.concat([{ rel: 'SAI2参数记录.txt', data: made.record }]);
    return made;
  }

  /** Brush list -> SAI2 scatter brush files (bmp + ini), zipped. */
  function makeSai2Pack(brushList, opts) {
    const prep = sai2ExportList(brushList, opts);
    const made = sai2.makeSai2Pack(prep.list, opts || {});
    made.warnings = (made.warnings || []).concat(prep.warnings, sai2TextureWarnings(prep.list, opts));
    return made;
  }

  function makeGoPaintAbr(brushList, opts) {
    return makeAbrPack(brushList, opts || {});
  }

  /** 天生会画（GoPaint）原生 .gobrush：ZIP含独立shape/grain、内嵌资源及快照。 */
  function makeGoPaintBrush(brush, opts) {
    opts = opts || {};
    const fileName = (sanitizeName(brush.name || 'brush', 0) || 'brush') + '.gobrush';
    // 还原优先：源就是 .gobrush 时原样输出
    if (brush._rawGobrush && brush._rawGobrush.length && rawBrushUnchanged(brush, opts) && opts.noTextureBake !== true) {
      return { bytes: new Uint8Array(brush._rawGobrush), fileName:fileName, uuid:brush.gopaintUuid, count: 1, passthrough: true };
    }
    /* 【第303轮】改过参数的原生 .gobrush 优先原位改写：未改笔尖/纹理图且未 forceRebuild 时，
       直接原位改写主 brush_<uuid>.info 里的 0xb0 参数块与 0xc0 属性块，逐字节保住 0xd0
       高分辨率资源载荷、副笔刷 .info、滑块上下限元数据（0x15）与原 UUID，不再整份重建。 */
    const canPatchNative = !!(
      brush._rawGobrush && brush._rawGobrush.length &&
      !opts.forceRebuild && opts.fidelity !== false &&
      opts.noTextureBake !== true && opts.grainMode !== 'tip' &&
      !brush.flipX && !brush.flipY && !brush.textureInverted &&
      !(brush.angle && Math.abs(brush.angle % 360) > 0.001) &&
      !(brush.roundness !== undefined && brush.roundness < 99.5) &&
      (!brush._rawTipState || brush._rawTipState === util.brushFingerprint({ tip: brush.tip })) &&
      (!brush._rawGrainState || brush._rawGrainState === util.brushFingerprint({ grain: brush.grain }))
    );
    if (canPatchNative) {
      const patched = gobrushWrite.makeGobrush(brush, Object.assign({}, opts, { _patchNative: true }));
      if (patched && patched.nativePatched) {
        return { bytes: patched.bytes, fileName: fileName, uuid: patched.uuid, count: 1, nativePatched: true };
      }
    }
    /* 仅当确实无法原位改写而走整份重建（如 forceRebuild、改动了笔尖/纹理/翻转/旋转，
       或原 .info 结构异常）时，才发出整份重建告警。 */
    const rebuildingNative = !!(brush._rawGobrush && brush._rawGobrush.length);
    const nativeWarnings = rebuildingNative ? ['天生会画：改过参数的原生 .gobrush 会整份重建——' +
      '容器内原始资源（brush_*.info 原始载荷、高分辨率 shape/grain）不保留，' +
      '笔刷上限/滑块范围按默认重算，UUID 会换新（App 里会多一支）；' +
      '只想保原样请不改参数直接导出，或用「原样导出」'] : null;
    let b2 = withTipRGBA(brush, Object.assign({}, opts, { maxTipSize: opts.maxTipSize || 2048 }), { transform: true });
    const texture = opts.noTextureBake === true ? null : textureGray(b2);
    if (texture && (!b2.grain || b2.textureInverted)) {
      const rgba = new Uint8Array(texture.w * texture.h * 4);
      for (let i = 0; i < texture.gray.length; i++) rgba.set([texture.gray[i], texture.gray[i], texture.gray[i], 255], i * 4);
      b2 = Object.assign({}, b2, { grain: { w: texture.w, h: texture.h, rgba: rgba } });
    }
    b2 = Object.assign({}, b2, { hasTexture: !!brush.hasTexture && opts.noTextureBake !== true && (!!texture || opts.grainMode === 'tip') });
    const made = gobrushWrite.makeGobrush(b2, opts || {});
    const out = { bytes: made.bytes, fileName:fileName, uuid:made.uuid, count: 1 };
    if (nativeWarnings) out.warnings = nativeWarnings.concat(made.warnings || []);
    else if (made.warnings && made.warnings.length) out.warnings = made.warnings;
    return out;
  }

  /** 整个笔刷集 -> 单个 .gobrushes 文件（GoPaint 原生笔刷组） */
  function makeGoPaintGroup(brushList, opts) {
    opts = opts || {};
    const rawGroup = brushList.length && brushList[0]._rawGoGroup;
    const groupName = opts.groupName || (rawGroup && rawGroup.name) ||
      (brushList.length && brushList.every(function (b) { return b.group === brushList[0].group; }) && brushList[0].group) || '笔刷组';
    const fileName = (sanitizeName(String(groupName), 0) || '笔刷组') + '.gobrushes';
    // 还原优先：整组来自同一个 .gobrushes 时原样输出
    if (rawGroup && opts.noTextureBake !== true && rawGroup.count === brushList.length && groupName === rawGroup.name &&
        brushList.every(function (b, i) { return b._rawGoGroup === rawGroup && b._rawGoIndex === i && rawBrushUnchanged(b, opts); })) {
      return { bytes: new Uint8Array(rawGroup.bytes), fileName:fileName, count: brushList.length, passthrough: true };
    }
    let rebuiltNative = false;
    const made = gobrushWrite.makeGobrushes(brushList, Object.assign({}, opts, {
      groupName: groupName,
      _rawGroupBytes: (rawGroup && groupName === rawGroup.name) ? rawGroup.bytes : undefined,
      _rawGroupName: rawGroup ? rawGroup.name : undefined
    }), function (b) {
      const r = makeGoPaintBrush(b, opts);
      if (b && b._rawGobrush && b._rawGobrush.length && !r.passthrough && !r.nativePatched) {
        rebuiltNative = true;
      }
      return r;
    });
    const out = { bytes: made.bytes, fileName:fileName, count: made.count };
    /* 组内只有存在「无法原位改写而走整份重建的原生笔刷」时才带告警 */
    if (rebuiltNative) {
      out.warnings = ['天生会画：整包里有改过的原生笔刷，重建会丢掉它们各自的 brush_*.info 原始载荷与高分辨率 shape/grain，UUID 也会换新'];
    }
    return out;
  }

  /** 整个笔刷集 -> 多个 .gobrush 文件（GoPaint 原生格式） */
  function makeGoPaintSet(brushList, opts) {
    const files = [];
    const names = uniqueNames(brushList);
    const warnings = [];
    const seenWarn = new Set();
    for (let i = 0; i < brushList.length; i++) {
      const b = brushList[i];
      const made = makeGoPaintBrush(b, opts);
      files.push({ name: names[i] + '.gobrush', data: made.bytes });
      if (made.warnings && made.warnings.length) {
        for (const w of made.warnings) {
          if (!seenWarn.has(w)) { seenWarn.add(w); warnings.push(w); }
        }
      }
    }
    const out = { files: files, count: files.length };
    if (warnings.length) out.warnings = warnings;
    return out;
  }

  function uniqueNames(brushes) {
    // #48（WorkBuddy 第106轮）：统一去重口径——大小写折叠（Windows/PS 文件名与预设名大小写不敏感，
    // 'ABC'/'abc' 会互相覆盖导致预设与采样错位）；加后缀后复核 60 字符上限。
    const seen = new Map();
    return brushes.map((b, i) => {
      const base = sanitizeName(b.name, i);
      let n = base;
      let k = 2;
      while (seen.has(n.normalize('NFC').toLowerCase())) {
        const suf = ' (' + k + ')';
        k++;
        n = (base.length + suf.length > 60)
          ? base.slice(0, 60 - suf.length).replace(/[. ]+$/, '') + suf
          : base + suf;
      }
      seen.set(n.normalize('NFC').toLowerCase(), 1);
      return n;
    });
  }

  const api = { detect, parseFile, restoreHsjTips, restoreProcreateBundled, builtinTipKey, expandArchive, synthTip, selectAbrPatterns, makeBru, makeBruPack, makeBruPackAsync, burntOutlineCandidate, expandBurntOutlineVariants, makeBruDualPair, buildBruDualPairBrushes, dualNeedsPair, makeAbrPack, makeAbrPackAsync, makeTplPack, makeUdongmanPack, makeUdongmanSutPack, makeUdongmanMtdPack, parseMtd, makeAbrPassthrough, makePatternFile, makeTexturePng, textureGray, textureKey, mergePatternFiles, grainNoise, bakeGrainIntoRGBA, bakeTextureIntoRGBA, makeInstallScripts, brushLossReport, buildCompareHtml, tipSourceAudit, tipSourceHint, brushParamInfo, brushParamText, parseFileAsync, makeProcreateBrush, makeProcreateBrushset, makeProcreateBrushsetAsync, makeGbr, makeMyb, makeGih, makeGihFiles, makePainter, makeMdp, makeMediBangBrush, makeMediBangIniPack, makeIpcfg, makePrbr, makeGoPaintAbr, makeGoPaintBrush, makeGoPaintSet, makeGoPaintGroup, makeSai2Files, makeSai2Pack, makeKritaBundle, makeTipPng, makeTipPngPack, tipToRGBA, bakeTipTransform, sanitizeName, uniqueNames, extLabel };
  /* 写出口统一过一遍数值卫生（见 sanitizeBrushNumbers）。包装不改变函数签名：
     数组入口逐支处理，单支入口直接处理，字节/字符串入口原样放行。
     只有真的钳制过才替换参数并附加 warnings，合法样本走原路径零影响。 */
  const GUARDED_WRITERS = ['makeBru', 'makeBruPack', 'makeBruPackAsync', 'makeBruDualPair', 'makeAbrPack', 'makeAbrPackAsync', 'makeTplPack',
    'makeUdongmanPack', 'makeUdongmanSutPack', 'makeUdongmanMtdPack', 'makePatternFile', 'makeTexturePng',
    'makeProcreateBrush', 'makeProcreateBrushset', 'makeProcreateBrushsetAsync', 'makeGbr', 'makeMyb', 'makeKpp', 'makeGih', 'makeGihFiles',
    'makePainter', 'makeMdp', 'makeMediBangBrush', 'makeMediBangIniPack', 'makeIpcfg', 'makePrbr',
    'makeGoPaintAbr', 'makeGoPaintBrush', 'makeGoPaintSet', 'makeGoPaintGroup',
    'makeSai2Files', 'makeSai2Pack', 'makeKritaBundle', 'makeTipPng', 'makeTipPngPack'];
  /* 【第198轮】画世界 BRU 的 f123 存的是「1 - 界面纹理深度」（真机：f123=0.21 ↔ 界面 79%，见 makeBru 注释），
     bru.js 读出的 textureDepth 是这个原始值，BRU→BRU 往返要靠它原样写回。
     但其它格式把 textureDepth 当「深度」用：画世界官方「小方块/网点」这类笔刷 f123 缺省(=0，界面 100%)，
     转出去成了深度 0，纹理整张丢掉，只剩一个实心圆糊成一坨。
     所以只在**非 BRU 写出口**换算成界面深度，并标记纹理按画布坐标采样（Procreate 写成「纹理化」）。 */
  const BRU_WRITERS = ['makeBru', 'makeBruPack', 'makeBruPackAsync', 'makeBruDualPair'];
  function prepareBruForCrossFormat(brush) {
    if (!brush || typeof brush !== 'object' || brush instanceof Uint8Array) return brush;
    if (brush.source !== 'bru') return brush;
    let out = brush;
    if (brush.hasTexture && !brush._bruDepthAsUi) {
      const raw = Number(brush.textureDepth);
      out = Object.assign({}, brush, {
        textureDepth: 1 - (Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0),
        textureCanvasSpace: true
      });
      // Validate before converting the BRU depth scale. Rebase the snapshot
      // only when the source pixels and texture settings are still intact.
      if (brush._procreateGrainChunk) {
        out._procreateGrainState = unchangedProcreateGrain(brush) ? procreateGrainState(out) : undefined;
      }
      if (brush._procreateDualBridge || brush._nativeArchiveBackup || (brush._noShapeMark && brush._noShapeMark.library)) out._procreateDualDepthUi = true;
      Object.defineProperty(out, '_bruDepthAsUi', { value: true, enumerable: false, configurable: true });
    }
    const sub = brush.dualSubBrush;
    if (brush.dualOn && !brush.dualTip && sub && sub.bruProceduralTip) {
      if (out === brush) out = Object.assign({}, brush);
      out.dualTip = synthTip(Object.assign({}, sub, { angle: 0, roundness: 100 }));
    }
    return out;
  }
  for (const writerName of GUARDED_WRITERS) {
    const fn = api[writerName];
    if (typeof fn !== 'function') continue;
    const crossFormat = BRU_WRITERS.indexOf(writerName) < 0;
    api[writerName] = function (first) {
      const args = Array.prototype.slice.call(arguments);
      if (crossFormat) {
        if (Array.isArray(first)) first = first.map(prepareBruForCrossFormat);
        else first = prepareBruForCrossFormat(first);
        args[0] = first;
      }
      let sanitized = first;
      let touched = false;
      const sanitizeForExport = function (b) {
        const unchangedNative = !crossFormat && b && (nativeArchiveUntouched(b) ||
          (b._pcNativeArchiveEligible && b._pcNativePairState === util.brushFingerprint(b)));
        const clean = sanitizeBrushNumbers(b);
        if (clean !== b && unchangedNative) {
          clean._pcNativeArchiveEligible = true;
          clean._pcNativePairState = util.brushFingerprint(clean);
        }
        return clean;
      };
      if (Array.isArray(first)) {
        sanitized = first.map(sanitizeForExport);
        touched = sanitized.some(function (b, i) { return b !== first[i]; });
      } else if (first && typeof first === 'object' && !(first instanceof Uint8Array)) {
        sanitized = sanitizeForExport(first);
        touched = sanitized !== first;
      }
      if (!touched) return fn.apply(this, args);
      args[0] = sanitized;
      const out = fn.apply(this, args);
      const notes = collectGuardNotes(sanitized);
      if (!notes.length) return out;
      const msg = '源参数超出目标格式可接受范围，已钳制后再写出：' + notes.slice(0, 6).join('；') +
        (notes.length > 6 ? ' 等 ' + notes.length + ' 项' : '');
      /* 【第285轮】异步写出口（makeAbrPackAsync / makeProcreateBrushsetAsync / makeBruPackAsync）
         返回的是 Promise，「给 Promise 挂 warnings」等于什么都没做——告警会凭空消失。
         这里区分 thenable：先等结果，再往结果上追加告警。 */
      const attach = function (res) {
        if (res && typeof res === 'object') {
          res.warnings = (Array.isArray(res.warnings) ? res.warnings : []).concat([msg]);
        }
        return res;
      };
      if (out && typeof out.then === 'function') return out.then(attach);
      return attach(out);
    };
  }

  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { convert: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);


