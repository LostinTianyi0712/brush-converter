/* Clip Studio Paint brush material: .sut = SQLite database.
   Brush parameters live in the `Variant` table; the tip preview lives in
   MaterialFile.FileData (tar). Verified plain C2F tiles are readable;
   encrypted/unsupported native layers use an explicitly marked preview. */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const sqlite = isNode ? require('./sqlite.js') : root.BC.sqlite;
  const png = isNode ? require('./png.js') : root.BC.png;
  const cspMaterial = isNode ? require('./cspMaterial.js') : root.BC.cspMaterial;
  const fs = isNode ? require('fs') : null;
  const nodePath = isNode ? require('path') : null;

  function isSut(bytes) {
    if (!sqlite.isSqlite(bytes)) return false;
    try {
      const db = sqlite.read(bytes);
      return !!(sqlite.getTable(db, 'Variant') || sqlite.getTable(db, 'MaterialFile'));
    } catch (e) {
      return false;
    }
  }

  /* ---------- minimal tar reader ---------- */
  function readTar(bytes) {
    const files = [];
    let pos = 0;
    let paxName = null;
    while (pos + 512 <= bytes.length) {
      const nameRaw = util.utf8Decode(bytes.subarray(pos, pos + 100)).replace(/\u0000[\s\S]*$/, '');
      if (!nameRaw) break; // end of archive
      const sizeOct = util.utf8Decode(bytes.subarray(pos + 124, pos + 136)).replace(/\u0000[\s\S]*$/, '').trim();
      const size = parseInt(sizeOct, 8) || 0;
      const type = bytes[pos + 156] || 0x30;
      const dataStart = pos + 512;
      const dataEnd = dataStart + size;
      if (!Number.isSafeInteger(size) || size < 0 || dataEnd > bytes.length) throw new Error('Truncated material TAR');
      if (type === 0x78) { // 'x' pax extended header: contains "path=..." for next entry
        const body = util.utf8Decode(bytes.subarray(dataStart, dataEnd));
        const m = /(?:^|\n)\d+ path=([^\n]*)/.exec(body);
        if (m) paxName = m[1];
      } else if (type === 0x30 || type === 0) { // regular file (may still be a directory name ending with /)
        if (!/\/$/.test(nameRaw)) {
          files.push({ name: paxName || nameRaw, data: bytes.subarray(dataStart, dataEnd) });
        }
        paxName = null;
      } else {
        paxName = null;
      }
      pos = dataStart + Math.ceil(size / 512) * 512;
    }
    return files;
  }

  function findPng(files) {
    // prefer thumbnail, then any png that is not an icon
    const order = [/thumbnail\.png$/i, /thumb/i, /\.png$/i];
    for (const re of order) {
      for (const f of files) {
        if (!re.test(f.name)) continue;
        if (!png.isPng(f.data)) continue;
        try { return f; } catch (e) { /* next */ }
      }
    }
    return null;
  }

  function decodeText(v) {
    if (typeof v !== 'string') return '';
    // CSP stores node names as UTF-8; some files keep trailing NULs
    return v.replace(/\u0000+$/, '').trim();
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // Native CSP 5.1.5 exports: ABR 90deg -> BrushRotation 270,
  // ABR 45deg -> 315. CSP uses the opposite angular direction.
  function modelAngle(rotation) { return ((360 - rotation) % 360 + 360) % 360; }

  /* 读取双笔刷（副笔）字段。参考真实样本 sample_ceshi2.sut：
     UseDualBrush=1 / DualSize=30 / DualSizeUnit=0 / DualFlow=31 / DualHardness=80 /
     DualInterval=100 / DualThickness=100 / DualRotation=0 / DualBrushCompositeMode=3。
     单位与主笔一致：DualSizeUnit 0 = px、1 = 主笔百分比口径（×10 近似）。 */
  function readDualFields(v, clamp) {
    if (!v || !v.UseDualBrush) return { dualOn: false };
    const unit = v.DualSizeUnit || 0;
    let sizePx = typeof v.DualSize === 'number' ? v.DualSize : 0;
    if (unit === 1) sizePx = sizePx * 10;
    const out = {
      dualOn: true,
      dualSizePx: Math.max(0, Math.round(sizePx)),
      dualSizeUnit: unit,
      dualFlowPct: typeof v.DualFlow === 'number' ? clamp(v.DualFlow / 100, 0, 1) : 1,
      dualHardness: typeof v.DualHardness === 'number' ? clamp(v.DualHardness / 100, 0, 1) : 1,
      dualSpacingPct: typeof v.DualInterval === 'number' ? clamp(v.DualInterval, 1, 1000) : 10,
      dualThickness: typeof v.DualThickness === 'number' ? clamp(v.DualThickness, 1, 100) : 100,
      dualAngle: typeof v.DualRotation === 'number' ? modelAngle(v.DualRotation) : 0,
      dualCompositeMode: typeof v.DualBrushCompositeMode === 'number' ? v.DualBrushCompositeMode : 0,
      dualUsePattern: !!v.DualUsePatternImage
    };
    // 其他格式（ABR/BRU/Procreate）的写出端读 dualBrush；没有这个对象时，
    // 单纯“原样导出/改一个尺寸”会把 UseDualBrush 写成 0，副笔被静默关掉。
    out.dualBrush = {
      enabled: true,
      diameter: out.dualSizePx,
      spacing: out.dualSpacingPct,
      opacity: out.dualFlowPct,
      hardness: out.dualHardness,
      roundness: out.dualThickness,
      angle: out.dualAngle,
      blend: out.dualCompositeMode
    };
    out.dualBlendMode = out.dualCompositeMode;
    return out;
  }

  /* Effector blob header (big-endian u32): [0]=header size, [1]=240/496,
     [2]=flags (0x10 = pressure on; 0 = off — every Variant stores a blob even when
     dynamics are off), [3]=minimum percent. Samples: 三角 ok.sut (size 16/57,
     opacity 16/47), SAH_BrushSmear.sut (size 16/20), sample_ceshi2.sut (size 144/10). */
  function readEffector(blob) {
    if (!(blob instanceof Uint8Array) || blob.length < 16) return { pressure: false, min: 1 };
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const flags = dv.getUint32(8, false), min = dv.getUint32(12, false);
    return { pressure: (flags & 0x10) !== 0, min: clamp(min / 100, 0, 1) };
  }

  function readExtraCspFields(v, clamp) {
    if (!v) return {};
    const taperIn = !!v.BrushUseIn, taperOut = !!v.BrushUseOut;
    const wetOn = !!v.BrushUseWaterEdge;
    const wetAmt = wetOn && typeof v.BrushWaterEdgeAlphaPower === 'number' ? clamp(Math.abs(v.BrushWaterEdgeAlphaPower) / 100, 0, 1) : 0;
    const waterOn = !!v.BrushUseWaterColor && (typeof v.BrushMixColor === 'number' ? v.BrushMixColor < 100 : false);
    const waterMix = waterOn && typeof v.BrushMixColor === 'number' ? clamp((100 - v.BrushMixColor) / 100, 0, 1) : 0;
    const smooth = v.BrushUseRevision && typeof v.BrushRevision === 'number' ? clamp(v.BrushRevision / 100, 0, 1) : 0;
    const colOn = !!v.BrushChangePatternColor;
    const hueJ = colOn && typeof v.BrushHueChange === 'number' ? clamp(Math.abs(v.BrushHueChange) / 360, 0, 1) : 0;
    const satJ = colOn && typeof v.BrushSaturationChange === 'number' ? clamp(Math.abs(v.BrushSaturationChange) / 100, 0, 1) : 0;
    const valJ = colOn && typeof v.BrushValueChange === 'number' ? clamp(Math.abs(v.BrushValueChange) / 100, 0, 1) : 0;
    const sprayOn = !!v.BrushUseSpray && (Number(v.BrushSprayDensity) || 0) > 1;
    const sprayCnt = sprayOn && typeof v.BrushSprayDensity === 'number' ? clamp(Math.round(v.BrushSprayDensity), 1, 16) : 1;
    const texRot = typeof v.TextureRotate === 'number' && v.TextureRotate ? v.TextureRotate * Math.PI / 180 : 0;
    return {
      taperOn: taperIn || taperOut,
      taperStartLength: taperIn && typeof v.BrushInLength === 'number' ? v.BrushInLength : 0,
      taperEndLength: taperOut && typeof v.BrushOutLength === 'number' ? v.BrushOutLength : 0,
      textureRotation: texRot,
      wetEdgesOn: wetOn && wetAmt > 0.001,
      wetEdgesAmount: wetAmt,
      smudgeOn: waterOn && waterMix > 0.001,
      smudgeAmount: waterMix,
      smoothingStrength: smooth,
      colorDynamicsOn: colOn && (hueJ > 0.001 || satJ > 0.001 || valJ > 0.001),
      colorJitterHue: hueJ,
      colorJitterSat: satJ,
      colorJitterVal: valJ,
      scatterOn: sprayOn,
      scatterCount: sprayCnt
    };
  }

  function parseSut(bytes, fileName) {
    const warnings = [];
    const db = sqlite.read(bytes);
    const manager = sqlite.getTable(db, 'Manager');
    const nodeTable = sqlite.getTable(db, 'Node');
    const variantTable = sqlite.getTable(db, 'Variant');
    const materialTable = sqlite.getTable(db, 'MaterialFile');
    if (!variantTable || !variantTable.rows.length) {
      throw new Error('CSP 文件里没有找到 Variant 笔刷参数');
    }
    const version = manager && manager.rows.length ? manager.rows[0].Version : 0;

    // Resolve each Variant's tip and texture separately. A texture-only SUT
    // must keep its computed tip; previews must not replace readable tiles.
    const materials = Object.create(null);
    const legacyMaterials = [];
    if (materialTable) {
      for (const mf of materialTable.rows) {
        if (!(mf.FileData instanceof Uint8Array)) continue;
        let files = [];
        try { files = readTar(mf.FileData); } catch (e) { continue; }
        const entry = {tip:null, mask:null, approximate:false};
        const layer = files.filter(function(f){return /data\/material(?:_\d+)?\.layer$/i.test(f.name);})[0];
        if (layer && cspMaterial) {
          try {
            const image = cspMaterial.read(layer.data), rgba = new Uint8Array(image.w*image.h*4);
            for(let i=0;i<image.mask.length;i++){rgba[i*4]=rgba[i*4+1]=rgba[i*4+2]=255;rgba[i*4+3]=image.mask[i];}
            entry.tip = {w:image.w,h:image.h,rgba:rgba};
            entry.mask = {w:image.w,h:image.h,mode:1,data:image.mask};
          } catch(e) { /* Explicit preview fallback for encrypted/unsupported data. */ }
        }
        const thumb = !entry.tip && findPng(files);
        if (thumb) {
          try {
            const img = png.decode(thumb.data);
            const rgba = png.toMaskRgba(img.rgba);
            entry.tip = { w: img.width, h: img.height, rgba: rgba };
            entry.mask = {w:img.width,h:img.height,mode:1,data:Uint8Array.from({length:img.width*img.height},function(_,i){return rgba[i*4+3];})};
            entry.approximate = true;
          } catch (e) { /* next */ }
        }
        if (mf.OriginalPath) materials[mf.OriginalPath] = entry;
        else if (entry.tip) legacyMaterials.push(entry);
      }
    }

    const nodes = nodeTable ? nodeTable.rows : [];
    const node = nodes.length ? nodes[0] : null;
    const baseName = (node && decodeText(node.NodeName)) || (fileName || 'csp').replace(/\.[^.]+$/, '');

    const brushes = [];
    /* CSP 的 Variant 表通常是「当前 + 初始」两份仅 VariantID 不同的参数拷贝
       （Node.NodeVariantID / NodeInitVariantID 各引用一行）。参数完全相同的行
       只出 1 支，避免自产 SUT/MTD 回读时笔刷翻倍（#285）；参数不同的行视为
       真·多变体，各出 1 支并保留 #n 命名。 */
    function variantSignature(v) {
      const parts = [];
      for (const col of variantTable.columns) {
        if (col === 'VariantID') continue;
        const val = v[col];
        if (val instanceof Uint8Array) {
          let h = val.length;
          const step = Math.max(1, Math.floor(val.length / 32));
          for (let i = 0; i < val.length; i += step) h = (h * 31 + val[i]) >>> 0;
          parts.push(col + ':' + h);
        } else parts.push(col + ':' + String(val));
      }
      return parts.join('|');
    }
    const uniqueVariants = [];
    const seenSig = {};
    /* 未初始化的骨架行（如 NodeInitVariantID 指向的备份槽：BrushSize/Opacity 全为 NULL）
       不是笔刷，不能当成第二支（「三角 ok」曾因此读成 #1/#2）。 */
    const usable = variantTable.rows.filter(function (v) { return !(v.BrushSize == null && v.Opacity == null); });
    for (const v of (usable.length ? usable : variantTable.rows)) {
      const s = variantSignature(v);
      if (seenSig[s]) continue;
      seenSig[s] = true;
      uniqueVariants.push(v);
    }
    const variantTotal = uniqueVariants.length;
    uniqueVariants.forEach(function (v, idx) {
      const tipPath = cspMaterial.referencePath(v.BrushPatternImageArray);
      const texturePath = cspMaterial.referencePath(v.TextureImage);
      const tipMaterial = v.BrushUsePatternImage && (materials[tipPath] || legacyMaterials[0]);
      const textureMaterial = materials[texturePath];
      const tip = tipMaterial ? tipMaterial.tip : null;
      if (v.BrushUsePatternImage && !tip) warnings.push('CSP 文件中没有可读的笔尖素材，转换时将自动生成圆头笔尖');
      if (tipMaterial && !materials[tipPath]) warnings.push('CSP 旧素材缺少 OriginalPath，无法准确定位笔尖；暂用首个素材预览，需核对图案');
      if (tipMaterial && tipMaterial.approximate) warnings.push('CSP 笔尖取自缩略图（原始 material.layer 加密或像素布局不支持，无法还原精确笔尖）');
      if (texturePath && !(textureMaterial && textureMaterial.mask)) warnings.push('CSP 纹理素材不可读，纹理未提取');
      if (textureMaterial && textureMaterial.approximate) warnings.push('CSP 纹理取自缩略图，分辨率与原始纹理可能不同');
      const sizeRaw = typeof v.BrushSize === 'number' ? v.BrushSize : 80;
      const unit = v.BrushSizeUnit || 0;
      let sizePx = sizeRaw;
      if (unit === 1) sizePx = sizeRaw * 10; // percent-ish unit -> rough px
      sizePx = clamp(sizePx, 1, 4000);
      // Native CSP exports preserve 1% as BrushInterval=1, not a fraction.
      const interval = typeof v.BrushInterval === 'number' ? v.BrushInterval : 10;
      const spacingPct = clamp(interval || 10, 1, 1000);
      const opacityBase = typeof v.Opacity === 'number' ? v.Opacity / 100 : 1;
      const flow = typeof v.BrushFlow === 'number' ? v.BrushFlow / 100 : 1;
      const hardness = typeof v.BrushHardness === 'number' ? clamp(v.BrushHardness / 100, 0, 1) : 1;
      const thickness = typeof v.BrushThickness === 'number' ? clamp(v.BrushThickness, 1, 100) : 100;
      const rotation = typeof v.BrushRotation === 'number' ? v.BrushRotation : 0;
      const sizeFx = readEffector(v.BrushSizeEffector);
      const opacityFx = readEffector(v.BrushOpacityEffector);
      const hasSizeDynamics = sizeFx.pressure;
      const hasOpacityDynamics = opacityFx.pressure;
      brushes.push(Object.assign({
        name: variantTotal > 1 ? baseName + ' #' + (idx + 1) : baseName,
        tip: tip,
        hasTexture: !!(textureMaterial && textureMaterial.mask),
        _patternPixels: textureMaterial ? textureMaterial.mask : null,
        textureDepth: typeof v.TextureDensity === 'number' ? clamp(v.TextureDensity / 100, 0, 1) : 1,
        textureScale: typeof v.TextureScale2 === 'number' ? Math.max(0.01,v.TextureScale2 / 100) : 1,
        textureInverted: !!v.TextureReverseDensity,
        sizePx: sizePx,
        spacingPct: spacingPct,
        opacity: clamp(opacityBase, 0, 1),
        flowPct: clamp(flow, 0, 1),
        hardness: hardness,
        angle: modelAngle(rotation),
        roundness: thickness,
        pressure: hasSizeDynamics || hasOpacityDynamics,
        pressureSize: hasSizeDynamics,
        minSizeRatio: hasSizeDynamics ? sizeFx.min : 1,
        pressureOpacity: hasOpacityDynamics,
        minOpacityRatio: hasOpacityDynamics ? opacityFx.min : 1,
        source: 'csp',
        cspVersion: version,
        // 回写原生 SUT 时用于定位这一支对应的 Variant 行（同一 SUT 的“当前/初始”副本）
        _rawSutVariantId: v.VariantID
      }, readExtraCspFields(v, clamp), readDualFields(v, clamp)));
    });
    return { brushes: brushes, warnings: warnings };
  }

  /* ---------- decrypted CSP dump (sut unpacked + material thumbnails) ----------
     A companion folder `_decrypted/<brush>/` produced by the CSP decrypt tool
     contains `<brush>.params.json` (all Variant parameters) and real material
     previews under `tips/matNN_preview.png`.  When present we prefer it over
     the .sut itself: the tips are real bitmaps (not the encrypted C2F layer). */
  function readTipPng(file) {
    try {
      const img = png.decode(new Uint8Array(fs.readFileSync(file)));
      return { w: img.width, h: img.height, rgba: png.toMaskRgba(img.rgba) };
    } catch (e) { return null; }
  }

  /* Build brushes from an already-loaded decrypted dump:
     `json` = params.json content (object or string),
     `tips` = array aligned with json.materials, each {w,h,rgba} or null. */
  function parseDecryptedAssets(json, tips, fallbackName) {
    if (json && (json instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(json)))) {
      json = util.utf8Decode(json);
    }
    if (typeof json === 'string') json = JSON.parse(json);
    const warnings = [];
    const rootDir = '';
    const brushName = String(json.brush_name || fallbackName || 'csp').trim();
    warnings.push('CSP 笔尖来自解密目录的真实材质（不再是加密 layer 的近似）');
    tips = Array.isArray(tips) ? tips : [];
    const materials = Array.isArray(json.materials) ? json.materials : [];
    if (!tips.some(Boolean)) warnings.push('解密目录里没有可读的笔尖预览图，将自动生成圆头笔尖');

    const variants = Array.isArray(json.variants) ? json.variants : [];
    if (!variants.length) throw new Error('解密目录里没有 Variant 参数');
    // 与 parseSut 一致：「当前+初始」相同参数拷贝只出 1 支（#285）
    const uniqueVariants = [];
    const seenSig = {};
    for (const variant of variants) {
      const p = (variant && variant.params) || {};
      const sigParts = [];
      Object.keys(p).sort().forEach(function (k) {
        if (k === 'VariantID') return;
        sigParts.push(k + '=' + JSON.stringify(p[k]));
      });
      const s = sigParts.join('|');
      if (seenSig[s]) continue;
      seenSig[s] = true;
      uniqueVariants.push(variant);
    }
    const variantTotal = uniqueVariants.length;
    const brushes = [];
    uniqueVariants.forEach(function (variant, idx) {
      const p = variant.params || {};
      const rawSize = typeof p.BrushSize === 'number' ? p.BrushSize : 80;
      let sizePx = rawSize;
      if (p.BrushSizeUnit === 1) sizePx = rawSize * 10;
      sizePx = clamp(sizePx, 1, 4000);
      const interval = typeof p.BrushInterval === 'number' ? p.BrushInterval : 10;
      const spacingPct = clamp(interval || 10, 1, 1000);
      const opacityBase = typeof p.Opacity === 'number' ? p.Opacity / 100 : 1;
      const flow = typeof p.BrushFlow === 'number' ? p.BrushFlow / 100 : 1;
      const hardness = typeof p.BrushHardness === 'number' ? clamp(p.BrushHardness / 100, 0, 1) : 1;
      const thickness = typeof p.BrushThickness === 'number' ? clamp(p.BrushThickness, 1, 100) : 100;
      const rotation = typeof p.BrushRotation === 'number' ? p.BrushRotation : 0;
      const sizeCurve = p.BrushSizeEffector && Array.isArray(p.BrushSizeEffector.curve) ? p.BrushSizeEffector.curve.length : 0;
      const flowCurve = p.BrushFlowEffector && Array.isArray(p.BrushFlowEffector.curve) ? p.BrushFlowEffector.curve.length : 0;
      const hasSizeDynamics = sizeCurve > 2;
      const hasOpacityDynamics = flowCurve > 2;
      let tip = null;
      const items = (p.BrushPatternImageArray && Array.isArray(p.BrushPatternImageArray.items))
        ? p.BrushPatternImageArray.items : [];
      const referenced = [];
      for (const item of items) {
        const key = String(item);
        const hit = materials.findIndex(function (m) {
          const cat = m && m.catalog_path ? String(m.catalog_path) : '';
          return cat && (key.indexOf(cat) >= 0 || cat.indexOf(key) >= 0);
        });
        if (hit >= 0 && tips[hit]) { if (referenced.indexOf(hit) < 0) referenced.push(hit); }
      }
      if (referenced.length) tip = tips[referenced[0]];
      if (!tip) {
        const pool = tips.filter(Boolean);
        if (pool.length) tip = pool[idx % pool.length];
      }
      if (referenced.length > 1) warnings.push('CSP 变体含多个图案材质，转换时使用其中第一个作为笔尖');
      brushes.push(Object.assign({
        name: variantTotal > 1 ? brushName + ' #' + (idx + 1) : brushName,
        tip: tip,
        sizePx: sizePx,
        spacingPct: spacingPct,
        opacity: clamp(opacityBase, 0, 1),
        flowPct: clamp(flow, 0, 1),
        hardness: hardness,
        angle: modelAngle(rotation),
        roundness: thickness,
        pressure: hasSizeDynamics || hasOpacityDynamics,
        pressureSize: hasSizeDynamics,
        minSizeRatio: hasSizeDynamics ? 0.2 : 1,
        pressureOpacity: hasOpacityDynamics,
        minOpacityRatio: hasOpacityDynamics ? 0.3 : 1,
        source: 'csp-decrypted',
        cspVersion: json.manager && json.manager.Version
      }, readExtraCspFields(p, clamp), readDualFields(variant, clamp)));
    });
    return { brushes: brushes, warnings: warnings };
  }

  /* Read a decrypted dump folder from disk (desktop / node only). */
  function parseDecrypted(dir) {
    if (!isNode) throw new Error('解密目录解析仅在桌面版可用');
    let paramsPath = dir;
    if (!/\.json$/i.test(dir)) {
      const files = fs.readdirSync(dir).filter(function (f) { return /\.params\.json$/i.test(f); });
      if (!files.length) throw new Error('解密目录里没有 *.params.json');
      paramsPath = nodePath.join(dir, files[0]);
    }
    const rootDir = nodePath.dirname(paramsPath);
    const json = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
    const materials = Array.isArray(json.materials) ? json.materials : [];
    const tips = materials.map(function (mat) {
      const prev = (mat.previews && mat.previews[0]) || null;
      if (!prev || !prev.file) return null;
      return readTipPng(nodePath.join(rootDir, prev.file.replace(/\//g, nodePath.sep)));
    });
    return parseDecryptedAssets(json, tips, nodePath.basename(rootDir));
  }

  /** Locate the decrypted dump for a .sut even when the folder name differs
      from the file name (the dump records the source name in params.json). */
  function findDecryptedFor(sutPath) {
    if (!isNode) return null;
    try {
      const base = nodePath.basename(sutPath).toLowerCase();
      const parent = nodePath.dirname(sutPath);
      const root = nodePath.join(parent, '_decrypted');
      if (!fs.existsSync(root)) return null;
      // 1) same-name folder
      const same = nodePath.join(root, nodePath.basename(sutPath).replace(/\.[^.]+$/, ''));
      if (hasDecrypted(same)) return same;
      // 2) scan folders for a params.json whose "sut" matches
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const dir = nodePath.join(root, ent.name);
        const jsons = fs.readdirSync(dir).filter(function (f) { return /\.params\.json$/i.test(f); });
        for (const j of jsons) {
          try {
            const meta = JSON.parse(fs.readFileSync(nodePath.join(dir, j), 'utf8'));
            if (String(meta.sut || '').toLowerCase() === base) return dir;
          } catch (e) { /* next */ }
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function hasDecrypted(dir) {
    if (!isNode) return false;
    try {
      if (!fs.statSync(dir).isDirectory()) return false;
      return fs.readdirSync(dir).some(function (f) { return /\.params\.json$/i.test(f); });
    } catch (e) { return false; }
  }

  const api = { isSut, parseSut, parseDecrypted, parseDecryptedAssets, hasDecrypted, findDecryptedFor, readTar };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { csp: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
