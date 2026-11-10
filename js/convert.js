/* Conversion pipeline: detect -> parse -> normalize -> write .bru */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const nodePath = isNode ? require('path') : null;
  const util = isNode ? require('./util.js') : root.BC.util;
  const png = isNode ? require('./png.js') : root.BC.png;
  const zip = isNode ? require('./zip.js') : root.BC.zip;
  const abr = isNode ? require('./abr.js') : root.BC.abr;
  const tpl = isNode ? require('./tpl.js') : root.BC.tpl;
  const procreate = isNode ? require('./procreate.js') : root.BC.procreate;
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

  function sutVariantRowIndex(bytes, variantId) {
    if (variantId === undefined || variantId === null) return -1;
    const v = sutVariantTable(bytes);
    if (!v) return -1;
    for (let i = 0; i < v.rows.length; i++) {
      if (String(v.rows[i].VariantID) === String(variantId)) return i;
    }
    return -1;
  }

  function filterSutParams(params, columns, dropped) {
    const out = {};
    for (const k in params) {
      if (columns.indexOf(k) >= 0) out[k] = params[k];
      else if (dropped && dropped.indexOf(k) < 0 && !(k === 'UseDualBrush' && !params[k])) dropped.push(k);
    }
    return out;
  }

  function sameSutParams(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (a[k] !== b[k]) return false;
    return true;
  }

  function withSizeAndSpacing(brush, opts) {    opts = opts || {};
    const b = Object.assign({}, brush);
    if (Number.isFinite(opts.sizeScale) && opts.sizeScale > 0) {
      b.sizePx = (brush.sizePx || 40) * opts.sizeScale;
      if (brush.dualBrush && brush.dualBrush.diameter > 0) {
        b.dualBrush = Object.assign({}, brush.dualBrush, {diameter:brush.dualBrush.diameter * opts.sizeScale});
      }
      if(brush.dualSubBrush && brush.dualSubBrush.sizePx>0)b.dualSubBrush=Object.assign({},brush.dualSubBrush,{sizePx:brush.dualSubBrush.sizePx*opts.sizeScale});
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
        if (painterlib && safe(function () { return painterlib.isLibraryZip(bytes); })) return 'painter';
        if (zentries.some(e => /Brush\.archive$/i.test(e.name))) return 'procreate';
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

  /* 内置笔尖引用只有一种写法：oldTexId 里直接放内置图库的键 psN（早期样本如此）。
     texAssetId 的 ptN 是【纹理】编号，不是笔尖形状编号 —— 第178轮曾按编号相同
     猜成 psN 去补笔尖，结果用户导入后笔刷图案完全变了（第179轮实测反馈）。
     拿不到真实笔尖时宁可留空交给上层合成，也不能猜一个形状塞进去。 */
  function builtinTipKey(b) {
    if (!b) return null;
    const old = String(b.oldTexId || '');
    return /^ps[1-9][0-9]*$/.test(old) ? old : null;
  }

  function restoreHsjTips(result, opts) {
    if (!result || !result.brushes) return 0;
    const missing = result.brushes.filter(function (b) {
      return b.source === 'bru' && !b.tip && !!builtinTipKey(b);
    });
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
      if (!key) return;
      const raw = lib ? lib.get(key) : null;
      let pngBytes = raw ? b64ToBytes(raw) : null;
      if (!pngBytes && resMap) {
        const cand = resMap.get(key.toLowerCase() + '.png') ||
          (b.texAssetId ? resMap.get(String(b.texAssetId).toLowerCase() + '.png') : null);
        if (cand instanceof Uint8Array) pngBytes = cand;
      }
      if (!pngBytes) return;          // 内置库没有这一号：保持无笔尖，交给上层合成
      const image = png.decode(pngBytes);
      b.tip = { w: image.width, h: image.height, rgba: png.toMaskRgba(image.rgba) };
      b._tipFromBuiltin = key;
      if (b.tipSource === 'synth') delete b.tipSource;
      count++;
    });
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
    // Procreate .brushset 的组名（brushset.plist 的 name）：导出时原样写回，避免退回第一支笔刷名
    if (result.name !== undefined) out.name = result.name;
    return out;
  }

  /** 异步解析：ABR 大文件会分片让出主线程并回报进度 */
  async function parseFileAsync(name, bytes, opts) {
    opts = opts || {};
    const kind = detect(name, bytes);
    if (kind === 'abr') {
      const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
      const r = await abr.parseAsync(bytes, { onProgress: onProgress || undefined });
      return { kind: 'abr', kindLabel: extLabel('abr'), brushes: r.brushes, warnings: r.warnings || [] };
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

  function sanitizeName(name, index, preserveFileName) {
    // #48（WorkBuddy 第106轮）：补充控制字符（\x00-\x1f）与零宽/双向控制字符（U+200B-F、U+202A-E、U+FEFF）
    // NFD（macOS 解压）先归一化，避免同名被当成两份
    let n = (name || '').normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\ufeff]/g, ' ');
    if (!preserveFileName) n = n.replace(/\s+/g, ' ');
    n = n.trim();
    // Windows 不允许文件名以点/空格结尾（"a." 会被系统截断或创建失败）
    n = n.replace(/[. ]+$/, '');
    if (!n) n = 'brush_' + String(index + 1).padStart(3, '0');
    // Resource labels keep their format limits; external files keep source names.
    if (!preserveFileName && n.length > 60) n = n.slice(0, 60).replace(/[. ]+$/, '').trim();
    // Windows 保留设备名：CON/PRN/AUX/NUL/COM1-9/LPT1-9，带扩展名同样不可用
    // 截断后可能又变回保留名（CONSOLE… → CON），这里再查一次
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = '_' + n;
    return n;
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
    const sec = Object.assign({}, info, sub, {
      source: sub.source || brush.source,
      name: sanitizeName(brush.name || 'brush', 0).slice(0, 54) + '_副笔尖',
      tip: tip,
      sizePx: Math.max(1, Math.round(info.diameter || brush.sizePx || 100)),
      spacingPct: info.spacing !== undefined ? info.spacing : (brush.spacingPct === undefined ? 10 : brush.spacingPct),
      opacity: sub.opacity === undefined ? 1 : sub.opacity,
      angle: info.angle || 0,
      roundness: info.roundness === undefined ? 100 : info.roundness,
      dualOn: false,
      dualTip: undefined,
      dualBrush: undefined,
      dualSubBrush: undefined,
      scatterOn: info.useScatter === undefined ? !!sub.scatterOn : !!info.useScatter,
      scatterCount: info.count === undefined ? sub.scatterCount : info.count,
      scatterBothAxes: info.bothAxes === undefined ? sub.scatterBothAxes : info.bothAxes,
      scatterPct: info.scatterPct === undefined ? sub.scatterPct : info.scatterPct,
      bruUuid: secUuid,
      bruDualRefUuid: null,
      pkgId: pkgUuid
    });
    const primary = Object.assign({}, brush, {
      bruUuid: priUuid,
      bruDualRefUuid: pkgUuid,
      dualSubName: sec.name,
      bruDualSubBrush: sec,
      bruDualEnabled: true,
      pkgId: pkgUuid,
      dualOn: false,
      dualTip: undefined
    });
    return { primary: primary, secondary: sec, primaryUuid: priUuid, secondaryUuid: secUuid, pkgUuid: pkgUuid };
  }

  function makeBruDualPair(brush, opts) {
    const pair = buildBruDualPairBrushes(brush);
    if (!pair) return null;
    const opts2 = Object.assign({}, opts, { pkgId: pair.pkgUuid });
    const made = makeBruPack([pair.primary, pair.secondary], opts2);
    return { bytes: made.bytes, count: 2, primaryUuid: pair.primaryUuid, secondaryUuid: pair.secondaryUuid };
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
      embeddedSubPng: sub.pngBytes,
      bruDualSubBrush: sub.meta,
      bruDualEnabled: enabled,
      dualSubName: sub.meta.name,
      pkgId: pair.pkgUuid
    });
    return makeBru(primary, Object.assign({}, opts, { embedSubTip: false }));
  }

  /* Procreate 的纹理亮度/对比度：中性 51 / 100，调低会写成负数（偏移语义）。
     画世界 f35/f33 是 0~100 的绝对值，所以负值要加回中性再看。 */
  function bruTexBrightness(brush) {
    const v = brush && brush.textureBrightness;
    if (v === undefined || !Number.isFinite(Number(v))) return 51;
    const n = Number(v);
    const abs = n < 0 ? 51 + n : n;
    return Math.max(0, Math.min(100, Math.round(abs * 100) / 100));
  }
  function bruTexContrast(brush) {
    const v = brush && brush.textureContrast;
    if (v === undefined || !Number.isFinite(Number(v))) return 100;
    const n = Number(v);
    const abs = n < 0 ? 100 + n : n;
    return Math.max(0, Math.min(100, Math.round(abs * 100) / 100));
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

  function makeBru(brush, opts) {
    brush = angleControlAliases(brush);
    if (opts && opts.embedSubTip && brush && brush.dualTip) return makeBruEmbedded(brush, opts);
    opts = opts || {};
    /* 同格式直抄：源就是 .bru、目标也是 .bru，且尺寸/间距/压感/烘焙等选项都没动过
       —— 原样返回源字节。画世界内置笔刷常常没有内嵌位图（450B 那类），任何重新
       生成都会换掉笔尖图案；透传是唯一能保证「导入后和原来一模一样」的路径。 */
    if (brush._rawBru && brush._rawBru.length && rawBrushUnchanged(brush, opts)) {
      return { bytes: new Uint8Array(brush._rawBru), pngBytes: null, meta: null,
        tipW: 0, tipH: 0, passthrough: true };
    }
    let tipImg = tipToRGBA(brush);
    const synthesizedTip = !tipImg;
    if (!tipImg) tipImg = synthTip(brush, 256, opts);
    const bakingDual = !brush.bruDualRefUuid && opts.dualBake !== false && brush.dualOn && brush.dualTip && (brush.dualTip.rgba || brush.dualTip.data) && opts.noDualBake !== true;
    if (bakingDual) tipImg = bakeDualTip(tipImg, brush);
    // 圆度/角度只在 bakeTipTransform 里应用一次（之前 abr 源会被压两次 → 笔刷变得又细又扁）
    if (brush.source !== 'bru' && !synthesizedTip) {
      // Procreate angle/roundness are written to native BRU f20/f22. Preserve
      // the shape canvas: also baking/cropping them deforms the same tip twice.
      const transform = brush.source === 'procreate' ? Object.assign({},brush,{angle:0,roundness:100}) : brush;
      tipImg = bakeTipTransform(tipImg, transform);
    }
    const maxTip = Math.max(16, Math.min(2048, opts.maxTipSize || 512));
    let w = tipImg.w, h = tipImg.h, rgba = tipImg.rgba;
    const maxSide = Math.max(w, h);
    if (maxSide > maxTip) {
      const scale = maxTip / maxSide;
      const nw = Math.max(1, Math.round(w * scale));
      const nh = Math.max(1, Math.round(h * scale));
      rgba = png.resize(rgba, w, h, nw, nh);
      w = nw; h = nh;
    }
    // A texture switch without a texture image renders blank in the native app.
    // BRU currently embeds the shape only. Bake real source pixels when requested;
    // never substitute procedural noise or enable an empty independent layer.
    let textureBaked = false;
    if (brush.source !== 'bru' && brush.hasTexture && opts.noTextureBake !== true) {
      const texture = textureGray(brush);
      if (texture) {
        rgba = new Uint8Array(rgba);
        bakeTextureIntoRGBA(rgba, w, h, {
          _patternPixels: { w: texture.w, h: texture.h, mode: 1, data: texture.gray },
          /* 以前这里只传像素， textureScale / grainDepthMinimum / textureRotation 全部丢失，
             导致「纹理缩放」在 BRU 路径上根本不生效（对着色世界就是这个路径）。 */
          textureScale: brush.textureScale,
          grainDepthMinimum: brush.grainDepthMinimum,
          textureRotation: brush.textureRotation
        }, brush.textureDepth === undefined ? 0.35 : brush.textureDepth);
        textureBaked = true;
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
    const effectiveTextureDepth = (texAssetId || brush.source === 'bru' || brush.hasTexture) ? outTextureDepth : undefined;
    const pngBytes = png.encode(w, h, brush.source === 'bru' ? rgba : png.toMaskRgba(rgba));
    const sizeScale = opts.sizeScale || 1;
    let sizePx = (brush.sizePx || 100) * sizeScale;
    if (!isFinite(sizePx) || sizePx <= 0) sizePx = Math.max(4, Math.max(w, h));
    sizePx = Math.max(1, Math.min(3000, Math.round(sizePx * 100) / 100));
    let spacingPct = opts.spacingOverride > 0 ? opts.spacingOverride : (brush.spacingPct === undefined ? 10 : brush.spacingPct);
    spacingPct = Math.max(0.1, Math.min(1000, spacingPct));
    const usePressure = opts.pressure === undefined ? (pressureSizeOn(brush) || !!brush.pressureOpacity) : !!opts.pressure;
    // 笔迹浓度归一（画世界）：真机标定发现画世界按每个笔尖累加 alpha——间距 4.2% 时同一位置叠约 24 次，
    // α=0.18 的笔尖最终覆盖 1-(0.82)^24≈99%，必然画成纯黑（实测亮度 26.8、颇粒 hf 2.68），
    // 而 Procreate 原样张是中灰的半透明颇粒（目标覆盖 ~0.6）。
    // 实测同一支笔刷：不透明度 22% → 亮度 144.1、hf 9.01、颇孔 4.2%。
    // 所以这里按「目标覆盖度」反算每个笔尖应有的 alpha，再折成不透明度。
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
    const meta = {
      name: brush.name || '',
      bruShapeInverted: !!brush.bruShapeInverted,
      pkgId: brush.pkgId || opts.pkgId,
      /* f7(MASKTEXPATH) = 笔尖图在 App 里的文件名。第179轮用 exportBrushes 的两支
         原生样本验证：App 导出时 oldTexId 逐字节等于内嵌 PNG 的 md5，导入时 App 就
         按这个值在 textures/ 下建文件。据此定规则：
         · 源自己的 mask 名仍然对得上（_tipFromBuiltin === oldTexId，含 psN 占位）
           → 原样保留，别无谓改写用户文件；
         · 笔尖是补回来的内置图 / 重新烘焙过的 → 用内容 md5，保证名字与图一一对应；
         · 绝不能写空：v2.8.53 曾把内置来源的 f7 留空，App 没有文件名可用，
           导入后笔刷空白（这正是「导出还是不行」的原因之一）。 */
      texId: brush.source === 'bru' && brush._tipFromBuiltin && brush._tipFromBuiltin === brush.oldTexId &&
        opts.fidelity !== false && !opts.forceRebuild
        ? brush.oldTexId : util.md5(pngBytes).toUpperCase(),
      sizePx,
      maxSizePx:Math.max(sizePx,brush._rawMaxWidth||500),
      spacingPct,
      opacity: densityOpacity !== null ? densityOpacity : (brush.opacity === undefined ? 1 : brush.opacity),
      minSizeRatio: usePressure ? (brush.minSizeRatio === undefined ? 0.1 : brush.minSizeRatio) : 1,
      minOpacityRatio: usePressure ? (brush.minOpacityRatio === undefined ? 0.25 : brush.minOpacityRatio) : 1,
      pressure: usePressure,
      // 把能写进 .bru 的其它参数一起带上（纹理/散布/抖动/锥度/湿边/混色/颜色动态/圆度硬度/流量）
      pressureSize: opts.pressure === undefined ? pressureSizeOn(brush) : !!opts.pressure,
      pressureOpacity: opts.pressure === false ? false : !!brush.pressureOpacity,
      flowPct: brush.flowPct,
      minFlowRatio: brush.minFlowRatio,
      roundness: brush.roundness,
      hardness: brush.hardness === undefined ? hardnessFromAlpha(rgba, w, h) : brush.hardness,
      smoothingStrength: brush.smoothingStrength,
      angle: brush.angle,
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
      scatterOn: brush.scatterOn,
      // PS沿用已有15%校准；Procreate等来源不套用该系数，用户明确选择时才覆盖。
      scatterPct: brush.scatterPct === undefined ? undefined : Math.min(1000, brush.scatterPct * (brush.source === 'bru' ? 1 : (opts.scatterScale === undefined ? (brush.source === 'abr' ? 0.15 : 1) : opts.scatterScale))),
      scatterBothAxes: brush.scatterBothAxes,
      scatterCount: brush.scatterCount,
      // App 内置纹理库资源 id（f6）：只在目标不是原生 BRU 且调用方/源笔刷指定了 id 时才写。
      // 原生 BRU 进来的笔刷原样保留自己已有的 id（raw 元数据路径会保持）。
      texAssetId: texAssetId || brush.texAssetId || (opts && opts.texAssetId),
      hasTexture: brush.source === 'bru' ? brush.hasTexture : !!texAssetId,
      textureInverted: brush.textureInverted,
      textureScale: brush.textureScale,
      textureBrightness: bruTexBrightness(brush),
      textureContrast: bruTexContrast(brush),
      textureDepth: effectiveTextureDepth,
      taperOn: brush.taperOn,
      taperSize: brush.taperSize,
      taperOpacity: brush.taperOpacity,
      wetEdgesOn: brush.wetEdgesOn,
      wetEdgesAmount: brush.wetEdgesAmount,
      wetEdgesDepth: brush.wetEdgesDepth,
      hollowPct: brush.hollowPct,
      antialiasLevel: brush.antialiasLevel,
      borderOn: !!brush.borderOn,
      borderBlend: brush.borderBlend,
      borderBrightness: brush.borderBrightness,
      borderStrength: brush.borderStrength,
      renderCount: brush.renderCount,
      speedPressure: !!brush.speedPressure,
      // #37（WorkBuddy 第106轮）：Procreate 湿混「混合」(dynamicsMix) 在 smudge 字段缺失时兜底，
      // 跨格式（Procreate→BRU）混色强度不再丢回默认值
      smudgeOn: brush.smudgeOn !== undefined ? brush.smudgeOn : (brush.dynamicsMix > 0 ? true : brush.smudgeOn),
      smudgeAmount: brush.smudgeAmount !== undefined ? brush.smudgeAmount : (brush.dynamicsMix !== undefined ? brush.dynamicsMix : brush.smudgeAmount),
      colorDynamicsOn: brush.colorDynamicsOn,
      colorJitterHue: brush.colorJitterHue,
      colorJitterSat: brush.colorJitterSat,
      colorJitterVal: brush.colorJitterVal,
      bruUuid: brush.bruUuid,
      bruDualRefUuid: brush.bruDualRefUuid,
      dualSubName: brush.dualSubName,
      bruDualSubBrush: brush.bruDualSubBrush,
      /* 副笔已经烘焙进笔尖时（bakingDual），画世界的「双笔刷」开关必须显式关掉。
         bru.js 写 f119 的规则是 `=== false ? 0 : 1`，undefined 也写 1 —— Procreate
         源的 bruDualEnabled 本来就是 undefined，于是笔尖里含一层副笔、双笔刷又画一层，
         同一笔落两次墨 = 用户看到的「重影」（黄土笔刷实测）。 */
      bruDualEnabled: bakingDual ? false : brush.bruDualEnabled,
      embeddedSubPng: brush.embeddedSubPng,
      bruLinkTemplate: brush.bruLinkTemplate,
      dualBlendMode: brush.dualBlendMode === undefined ? (brush.dualBrush && brush.dualBrush.blend) : brush.dualBlendMode,
      bruDualBlendMode: brush.bruDualBlendMode,
      oldTexId: brush.oldTexId,
      _rawMeta: opts.fidelity !== false && !opts.forceRebuild ? brush._rawMeta : undefined,
      _rawOriginalName:brush._rawState && brush._rawState.name
    };
    if(meta._rawMeta){
      const old=brush._rawState||{},fields=new Set();
      const mapping={name:[3],pkgId:[2],sizePx:[8,9,12,50,135,136],spacingPct:[17],opacity:[13,14],minSizeRatio:[9,50],minOpacityRatio:[14],
        pressure:[36,47,9,50,14],pressureSize:[36],pressureOpacity:[47],bruShapeInverted:[32],flowPct:[25,26,51],minFlowRatio:[26,51],angle:[20],angleJitterDeg:[21],bruRotationMode:[19,115],
        roundness:[22],hardness:[23],sizeJitterPct:[10],spacingJitterPct:[18],flowJitterPct:[27],countJitterPct:[60],
        hasTexture:[28,123],texAssetId:[6],textureInverted:[29],textureDepth:[123],textureScale:[24],textureBrightness:[35],textureContrast:[33],scatterOn:[56,57,58,59],
        scatterPct:[58],scatterCount:[59],scatterBothAxes:[57],taperOn:[74,77,78],taperSize:[77],taperOpacity:[78],wetEdgesOn:[100,101,129],
        wetEdgesAmount:[101],wetEdgesDepth:[129],borderOn:[92],borderBlend:[95],borderBrightness:[93],borderStrength:[94],renderCount:[97],
        bruUuid:[120],bruDualRefUuid:[119,120,121,122],dualSubName:[121],bruDualEnabled:[119],dualBlendMode:[122],
        smudgeOn:[103,104],smudgeAmount:[104],smoothingStrength:[80],hollowPct:[44],antialiasLevel:[96]};
      Object.keys(mapping).forEach(k=>{if(meta[k]!==old[k])mapping[k].forEach(f=>fields.add(f));});
      if(meta.texId!==brush.oldTexId)fields.add(7);
      if(brush.bruDualSubBrush)fields.add(121);
      meta._rawPatchFields=Array.from(fields);
    }
    const bytes = bru.writeBrush(Object.assign({ png: pngBytes }, meta), opts);
    return { bytes, pngBytes, meta, tipW: w, tipH: h, textureBaked, density: densityInfo };
  }

  /**
   * Convert a list of parsed brushes into ONE multi-brush .bru pack
   * (画世界Pro keeps the whole set together when importing a single .bru).
   */
  function makeBruPack(brushList, opts) {
    opts = opts || {};
    const items = [];
    const used = new Map();
    if (brushList.length === 1) {
      const only = makeBru(brushList[0], opts);
      if (only.passthrough) return { bytes: only.bytes, count: 1, meta: null, passthrough: true };
    }
    brushList.forEach(function (brush, i) {
      const made = makeBru(brush, opts);
      let base = sanitizeName(brush.name, i);
      let name = base, k = 2;
      while (used.has(name.toLowerCase())) { name = base + ' (' + k + ')'; k++; }
      used.set(name.toLowerCase(), 1);
      items.push(Object.assign({}, made.meta, { name: name, png: made.pngBytes }));
    });
    if (!items.length) throw new Error('没有可打包的笔刷');
    // Build embedded secondary metadata from the very same converted parameters
    // used for its standalone record (including scatter/size calibration).
    items.forEach(function (item, i) {
      if (!item.bruDualSubBrush) return;
      const sub = item.bruDualSubBrush;
      if (item.embeddedSubPng) {
        // makeBruEmbedded has already converted the secondary metadata.
        item.dualSubName = sub.name;
        return;
      }
      const ix = brushList.indexOf(sub);
      item.bruDualSubBrush = ix >= 0 ? items[ix] : makeBru(sub, opts).meta;
      item.dualSubName = item.bruDualSubBrush.name;
    });
    const bytes = bru.writePack(items, { pkgId: opts.pkgId, fidelity: opts.fidelity, keepRawMeta: opts.keepRawMeta });
    return { bytes, count: items.length, meta: items };
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

  function makeAbrPack(brushList, opts) {
    opts = opts || {};
    // 重名会让 Photoshop 导入时去重/合并，导致预设与采样错位（画出来变成别的笔刷），
    // 这里统一给重名加序号
    const names = uniqueNames(brushList);
    const items = [];
    brushList.forEach(function (source, i) {
      const brush=withExportSettings(source,opts);
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
      const maxTip = Math.max(64, Math.min(2048, opts.maxTipSize || 512));
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
      items.push({
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
        colorPerTip: brush.colorPerTip,
        colorJitterHue: brush.colorJitterHue,
        colorJitterSat: brush.colorJitterSat,
        colorJitterVal: brush.colorJitterVal,
        colorJitterPurity: brush.colorJitterPurity,
        psTexture: usePsTexture,
        patternRef: patternRef,
        textureDepth: brush.textureDepth,
        textureScale: brush.textureScale,
        textureBlendMode: brush.textureBlendMode,
        textureEnabled: !!brush.hasTexture,
        // PatternRef 里的 .pat 已经烘入了“是否需要反转”（inversionBaked），所以只要引用了它，
        // InvT 就必须是 false；否则 PS 会把已反转的图案再反转一次，纹理回到未反转原貌。
        // 以前多了 !willUseRaw 前置，只修了非 raw 重建路径，漏了 raw 源「改了参数→走重建」的兄弟路径（#260）。
        textureInverted: effectiveTextureInverted,
        // 源就是 ABR 时，保留原始描述符/样本字节（部分导出也能保住 PS 原版特性）
        rawPreset: keepRaw ? brush._rawPreset : undefined,
        rawPatchPaths: Array.from(paths), mainTipChanged:tipChanged,
        rawSample: keepRaw && !tipChanged ? brush._rawSample : undefined,
        keepSampleUuids: keepRaw && !dualTipChanged && brush.dualBrush && brush.dualBrush.uuid ? [brush.dualBrush.uuid] : [],
        sampleMap: brush._sampleMap,
        rawDualObjc: keepRaw ? brush._rawDualObjc : undefined,
        rawDualChanged:dualChanged || dualTipChanged,
        dualOn: !!brush.dualOn,
        rle: opts.abrRle !== false,
        uuid: (opts.abrUuids && opts.abrUuids[i]) || (keepRaw && !tipChanged && brush._rawPreset ? brush.uuid : undefined)
      });
    });
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
    // 源 ABR 的纹理图案：优先只带"被这些笔刷引用到的"图案记录（避免整块 143MB 全搬）
    let patternBlock = null;
    let patternRecords = null;
    let patternWarning = null;
    if (opts.preserveRaw !== false) {
      const seen = {};
      const picked = [];
      for (const b of brushList) {
        const rec = b && b._patternRecord;
        if (rec && !seen[rec.id + '|' + rec.name]) { seen[rec.id + '|' + rec.name] = 1; picked.push(rec); }
      }
      if (picked.length) {
        let total = 0;
        for (const r of picked) total += r.data.length;
        if (total <= 32 * 1024 * 1024) {
          patternRecords = picked;
        } else {
          patternWarning = '引用的纹理图案合计过大（' + Math.round(total / 1048576) + 'MB），已跳过';
        }
      }
      if (!patternRecords) {
        const withPatt = brushList.find(function (b) { return b && b._pattBlock && b._pattBlock.length; });
        if (withPatt && withPatt._pattBlock.length <= 32 * 1024 * 1024) patternBlock = withPatt._pattBlock;
      }
    }
    const bytes = abr.writeAbrV6(items, { groups: hasNamed ? groups : null, patternBlock: patternBlock, patternRecords: patternRecords });
    if (patternWarning && !opts._patternWarned) { opts._patternWarned = true; console.warn(patternWarning); }
    return { bytes: bytes, count: items.length, meta: items };
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
    const made = makeAbrPack(brushList, opts || {});
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

  /** Convert one brush to a Procreate .brush file (zip). */
  function makeProcreateBrush(brush, opts) {
    opts = opts || {};
    brush=withExportSettings(brush,opts);
    // 还原优先：源本身就是 Procreate，且没有强制重建时，直接原样打包
    if (opts.fidelity !== false && brush._rawArchive && !opts.forceRebuild) {
      const bytes = procreate.writeBrush(brush, opts);
      return { bytes: bytes, name: brush.name || 'brush', passthrough: procreate.unchanged(brush,opts), nativePatched:!procreate.unchanged(brush,opts) };
    }
    const tip = tipToRGBA(brush) || synthTip(Object.assign({},brush,{roundness:100,angle:0}), 256, opts);
    const b2 = Object.assign({}, brush, { tip: { w: tip.w, h: tip.h, rgba: tip.rgba } });
    const bytes = procreate.writeBrush(b2, opts);
    void b2;
    return { bytes: bytes, name: brush.name || 'brush' };
  }

  /** Convert a whole set to one Procreate .brushset file (zip). */
  function makeProcreateBrushset(brushList, opts) {
    opts = opts || {};
    // 同一包里重名笔刷：Procreate 里会显示多支同名，用户无法区分，统一去重
    // （#48 WorkBuddy 第106轮：改用全局 uniqueNames，与 ABR/GoPaint 的大小写折叠与长度上限口径一致）
    const names = uniqueNames(brushList);
    const list = brushList.map(function (b, i) {
      b=withExportSettings(b,opts);
      if (b.name !== names[i]) b = Object.assign({}, b, { name: names[i] });
      // Native Procreate resources may be builtin references with no Shape.png.
      // Match the single-brush raw path instead of replacing them with a circle.
      if (opts.fidelity !== false && b._rawArchive && !opts.forceRebuild) return b;
      const tip = tipToRGBA(b) || synthTip(Object.assign({},b,{roundness:100,angle:0}), 256, opts);
      return Object.assign({}, b, { tip: { w: tip.w, h: tip.h, rgba: tip.rgba } });
    });
    const bytes = procreate.writeBrushset(list, opts);
    return { bytes: bytes, count: list.length };
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
  function dualBlendCode(m) {
    if (m === undefined || m === null || m === '') return '';
    if (typeof m === 'number') {
      return ['', 'drkn', 'mltp', 'drkn', 'mltp', 'lghn', 'scrn', 'mltp', 'ovrl', 'mltp', 'mltp', 'mltp'][m] || '';
    }
    const s = String(m).toLowerCase().replace(/[^a-z]/g, '');
    if (s.indexOf('scrn') >= 0 || s.indexOf('screen') >= 0 || s.indexOf('lghn') >= 0 || s.indexOf('lighten') >= 0) return 'scrn';
    if (s.indexOf('ovrl') >= 0 || s.indexOf('overlay') >= 0) return 'ovrl';
    if (s.indexOf('drkn') >= 0 || s.indexOf('darken') >= 0) return 'drkn';
    return '';
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
    const blend = dualBlendCode(brush.dualBlendMode !== undefined ? brush.dualBlendMode : info.blend);
    const ratio = info.diameter > 0 && brush.sizePx > 0 ? info.diameter / brush.sizePx : 1;
    // Convert logical diameter into main-image pixels, then into secondary-image
    // coordinates. Changing the secondary image resolution must not resize it.
    const scale = Math.max(w, h) * ratio / Math.max(d.w, d.h);
    const ang = ((info.angle || 0) * Math.PI) / 180;
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
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a1 = tip.rgba[(y * w + x) * 4 + 3] / 255;
        const a2 = dualAlpha(x, y);
        let a;
        if (blend === 'scrn' || blend === 'lghn') a = 1 - (1 - a1) * (1 - a2);
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
    const bytes = mypaint.writeMyb(b);
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
    const lossy = list.some(function (b) {
      return b && (b.flowPct !== undefined || b.hardness !== undefined || b.hasTexture ||
        (b.scatterOn && (b.scatterPct || b.scatterCount)));
    });
    if (lossy) warnings.push('GIH：GIMP 位图笔刷不保存流量、硬度、散布与纹理参数，再导入时会重置为默认值');
    return { bytes: gimp.writeGih(list, name), count: list.length, warnings: warnings };
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

  /** Brush list -> MediBang .mdp (heuristic zip). */
  function makeMdp(brushList, opts, name) {
    const list = brushList.map(function (b) { return withTipRGBA(b, opts, { bake: true, fit: true }); });
    return { bytes: genericBrush.writeMdp(list, name || 'BrushConv'), count: list.length };
  }

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
    const limit = Math.max(1, Math.min(2048, opts.maxTipSize || 512));
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
    const chunks = [];
    for (const b of list) {
      const b2 = withTipRGBA(withExportSettings(b, opts), opts, { bake: true, fit: true });
      chunks.push({ name: (sanitizeName(b2.name || 'material', 0)) + '.mdp', data: medibang.writeMdp(b2) });
    }
    /* 第165轮：.mdp 是「材质/图章文档」，XML 只带图像宽高，不存任意笔刷参数；
       parseMdp 回读时 sizePx 由裁切后的位图反推、spacingPct 固定 25。
       互转时这些值每跳都会重置，必须明确告知。 */
    const warnings = ['MDP：MediBang 材质文件只保存笔尖图像，不保存尺寸、间距、流量等笔刷参数；再导入时会按位图重新推算并重置为默认值'];
    if (chunks.length === 1) return { bytes: chunks[0].data, count: 1, warnings: warnings };
    return { files: chunks, count: chunks.length, warnings: warnings };
  }

  /** Build a MediBang Paint brush package: black-shape tip PNG + Brush2.ini entry.
      Install: copy the PNG into %LOCALAPPDATA%\\Medibang\\CloudAlpaca\\brush_bitmap\\
      and append the ini snippet to Brush2.ini, then restart MediBang. */
  function makeMediBangIniPack(brushList, opts) {
    // 保证每支都有笔尖（程序笔刷也转成位图笔刷，否则缺少 .bs 脚本无法被 MediBang 识别）
    const list = (brushList || []).map(function (b) {
      try { return withTipRGBA(withExportSettings(b, opts), opts || {}, { transform: true }); } catch (e) { return b; }
    });
    return medibangIni.writeIniPack(list, opts || {});
  }

  function makeMediBangBrush(brush, opts) {
    opts = opts || {};
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
    const bytes = zipMod.write([
      { name: 'brush_bitmap/' + pngName, data: pngBytes },
      { name: 'Brush2.ini.snippet.txt', data: util.utf8Encode(section) },
      { name: '安装.bat', data: util.utf8Encode(installBat) },
      { name: 'install.ps1', data: util.utf8Encode(String.fromCharCode(0xfeff) + installPs1) },
      { name: '安装说明.txt', data: util.utf8Encode(readme) }
    ]);
    return { bytes: bytes, name: pngName, section: section, count: 1 };
  }

  /** 天生会画(GoPaint) 目前只支持导入 .abr 与原生 .gobrush；这里按 ABR 导出。 */
  /** Export the brush tip as a standalone PNG (material for apps without a brush-file import:
      MediBang Paint / Infinite Painter: create a custom brush from an image). */
  function makeTipPng(brush, opts) {
    opts = opts || {};
    const maxTip = Math.max(64, Math.min(2048, opts.maxTipSize || 512));
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
      纹理: b.hasTexture ? '有' : '无',
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
  function bakeTextureIntoRGBA(rgba, w, h, brush, strength) {
    const rawStrength = strength === undefined ? 0.35 : Number(strength);
    // NaN/Infinity 经 Math.min/max 仍是 NaN，写入 Uint8Array 后会变成 0，
    // 导致整支笔尖透明；非有限输入按既有默认强度处理。
    const k = Number.isFinite(rawStrength) ? Math.max(0, Math.min(1, rawStrength)) : 0.35;
    const gray = textureGray(brush);
    const tex = gray ? {w:gray.w,h:gray.h,sample:function(x,y){return gray.gray[y*gray.w+x]/255;}} : null;
    if (!tex) return rgba;
    /* Procreate 的「纹理缩放」与「深度最小值」以前没参与烘焙：
       - textureScale > 1 → 纹理更大，< 1 → 更细（坐标缩放 + 平铺）；
       - grainDepthMinimum → 纹理暗部不应完全透明（否则整条笔迹发黑）；
       未指定时保持旧行为（0.15 底部 + 不缩放），避免改变已有笔刷的观感。 */
    const scale = Math.max(0.02, Math.min(20, brush && brush.textureScale ? brush.textureScale : 1));
    const useScale = Math.abs(scale - 1) > 0.001;
    /* Procreate 的「纹理旋转」以前也没参与烘焙（静态笔尖里纹理方向永远是正的）。
       值 ≤1 当“圈数”，>1 当角度；旋转采样坐标即可。 */
    const rotRaw = brush && brush.textureRotation ? Number(brush.textureRotation) : 0;
    const rotRad = rotRaw ? (Math.abs(rotRaw) <= 1 ? rotRaw * Math.PI * 2 : rotRaw * Math.PI / 180) : 0;
    const useRot = Math.abs(rotRad) > 1e-4;
    const minDepth = brush && brush.grainDepthMinimum !== undefined && brush.grainDepthMinimum > 0
      ? Math.max(0, Math.min(1, brush.grainDepthMinimum)) : 0.15;
    const invScale = useScale ? 1 / scale : 1;
    const cosR = useRot ? Math.cos(rotRad) : 1, sinR = useRot ? Math.sin(rotRad) : 0;
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
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
        const v = tex.sample(tx, ty);
        const factor = 1 - k + k * (minDepth + (1 - minDepth) * v);
        rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(a * factor)));
      }
    }
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
        const limit = Math.max(1, Math.min(2048, opts.maxTipSize || 512));
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
    if (key === 'spacingPct' && target === 'bru') {
      const override = opts.spacingOverride > 0 ? opts.spacingOverride : undefined;
      const affected = [];
      if ((override === undefined ? brush.spacingPct : override) < 0.1) affected.push('主笔间距');
      const nativeDual = opts.embedSubTip === true || opts.bruEmbed === true || opts.dualPair !== false;
      const info = brush.dualBrush || {};
      const subSpacing = info.spacing === undefined ? (brush.spacingPct === undefined ? 10 : brush.spacingPct) : info.spacing;
      if (nativeDual && brush.dualOn && brush.dualTip && (override === undefined ? subSpacing : override) < 0.1) affected.push('副笔间距');
      if (affected.length) return '近似（' + affected.join('、') + '按当前BRU写出下限设为0.1%，低间距未原样保留）';
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
        return !raw && (opts.noTextureBake === true || opts.grainBake === false)
          ? '未写出（已关闭纹理输出，重建时禁用纹理）' : '参数映射（原纹理图，笔触待验证）';
      }
      if (target === 'bru') {
        if (brush.source !== 'bru') {
          if (!(pixels && opts.noTextureBake !== true)) return '未写出（缺少原图或已关闭烘焙，禁用空纹理避免无墨）';
          return opts.bruTexAsset && opts.bruTexAsset !== 'off'
            ? '近似（烘焙进笔尖 + 画世界内置材质纹理层，材质 id 依赖 App 版本）'
            : '近似（真实纹理烘焙进笔尖，未开启单独纹理层）';
        }
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
      ['间距', 'spacingPct', function (v) { return (Math.round(v * 10) / 10) + '%'; }],
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
      ['双笔刷', 'dualOn', function () { return '开'; }]
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
    abr: '纹理：先在 PS 图案面板导入配套 .pat；双笔刷：本格式原样保留，无需补',
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
    const out = { noTip: [], procedural: [], grainOnly: [] };
    for (const b of (brushList || [])) {
      if (!b || b.enabled === false) continue;
      const hasTip = !!b.tip; // A secondary image cannot replace the missing primary.
      if (!hasTip) {
        out.noTip.push(b.name);
        if (b.computed) out.procedural.push(b.name);
      } else if (b.tipSource === 'grain') {
        out.grainOnly.push(b.name);
      }
    }
    return out;
  }

  function tipSourceHint(audit) {
    const msgs = [];
    const list = audit || { noTip: [], procedural: [], grainOnly: [] };
    function names(arr, n) {
      const head = arr.slice(0, n).join('、');
      return arr.length > n ? head + ' 等' : head;
    }
    if (list.noTip.length) {
      let m = list.noTip.length + ' 支笔刷源文件没有笔尖（shape）图片：' + names(list.noTip, 3) +
        '；跨软件或强制重建只能生成近似圆形/椭圆笔尖，笔触可能不同；Procreate原生保留路径可保留内置引用';
      if (list.procedural.length === list.noTip.length) m += '（这些笔刷本身就是参数化笔刷，没有采样图像）';
      else if (list.procedural.length) m += '（其中 ' + list.procedural.length + ' 支为参数化生成）';
      msgs.push(m);
    }
    if (list.grainOnly.length) {
      msgs.push(list.grainOnly.length + ' 支笔刷只有纹理（grain）图、没有形状（shape）图：' + names(list.grainOnly, 3) +
        '；已用纹理图当笔尖，边缘与密度可能与源文件不同');
    }
    return msgs;
  }

  function brushLossReport(brushList, targets, opts) {
    const NL = String.fromCharCode(10);
    if (!Array.isArray(targets)) targets = [targets]; // 防呆：传字符串时按字符迭代会生成逐字符假报告
    const fields = [
      ['尺寸', 'sizePx', function (v) { return Math.round(v) + 'px'; }],
      ['间距', 'spacingPct', function (v) { return (Math.round(v * 10) / 10) + '%'; }],
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
      ['双笔刷', 'dualOn', function () { return '开'; }]
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
      bru: '外来真实纹理按选项近似烘焙进笔尖；开「画世界真纹理」时会再叠一层内置材质（受 App 版本影响）；动态和实际笔触需验证',
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
        lines.push('  ' + (i + 1) + '. ' + (b.name || '未命名'));
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
      const made = makeTipPng(b, Object.assign({}, opts, { maxTipSize: Math.max(opts.maxTipSize || 512, 512) }));
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
        if (blankSai2Tip(tip)) {
          tip = synthTip(Object.assign({}, b, { roundness: 100, angle: 0 }), 256, opts || {});
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
    let b2 = withTipRGBA(brush, Object.assign({}, opts, { maxTipSize: opts.maxTipSize || 2048 }), { transform: true });
    const texture = opts.noTextureBake === true ? null : textureGray(b2);
    if (texture && (!b2.grain || b2.textureInverted)) {
      const rgba = new Uint8Array(texture.w * texture.h * 4);
      for (let i = 0; i < texture.gray.length; i++) rgba.set([texture.gray[i], texture.gray[i], texture.gray[i], 255], i * 4);
      b2 = Object.assign({}, b2, { grain: { w: texture.w, h: texture.h, rgba: rgba } });
    }
    b2 = Object.assign({}, b2, { hasTexture: !!brush.hasTexture && opts.noTextureBake !== true && (!!texture || opts.grainMode === 'tip') });
    const made = gobrushWrite.makeGobrush(b2, opts || {});
    return { bytes: made.bytes, fileName:fileName, uuid:made.uuid, count: 1 };
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
    const made = gobrushWrite.makeGobrushes(brushList, Object.assign({}, opts, {groupName:groupName}),
      function (b) { return makeGoPaintBrush(b, opts); });
    return { bytes: made.bytes, fileName:fileName, count: made.count };
  }

  /** 整个笔刷集 -> 多个 .gobrush 文件（GoPaint 原生格式） */
  function makeGoPaintSet(brushList, opts) {
    const files = [];
    const names = uniqueNames(brushList);
    for (let i = 0; i < brushList.length; i++) {
      const b = brushList[i];
      const made = makeGoPaintBrush(b, opts);
      files.push({ name: names[i] + '.gobrush', data: made.bytes });
    }
    return { files: files, count: files.length };
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

  const api = { detect, parseFile, restoreHsjTips, builtinTipKey, expandArchive, synthTip, makeBru, makeBruPack, makeBruDualPair, buildBruDualPairBrushes, makeAbrPack, makeTplPack, makeUdongmanPack, makeUdongmanSutPack, makeUdongmanMtdPack, parseMtd, makeAbrPassthrough, makePatternFile, makeTexturePng, textureGray, textureKey, mergePatternFiles, grainNoise, bakeGrainIntoRGBA, bakeTextureIntoRGBA, makeInstallScripts, brushLossReport, buildCompareHtml, tipSourceAudit, tipSourceHint, brushParamInfo, brushParamText, parseFileAsync, makeProcreateBrush, makeProcreateBrushset, makeGbr, makeMyb, makeGih, makePainter, makeMdp, makeMediBangBrush, makeMediBangIniPack, makeIpcfg, makePrbr, makeGoPaintAbr, makeGoPaintBrush, makeGoPaintSet, makeGoPaintGroup, makeSai2Files, makeSai2Pack, makeKritaBundle, makeTipPng, makeTipPngPack, tipToRGBA, bakeTipTransform, sanitizeName, uniqueNames, extLabel };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { convert: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);

