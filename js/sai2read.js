/* PaintTool SAI 2 素材/笔刷读取
 *  - init 素材包：brushform.conf / brushtex.conf / papertex.conf / scatter.conf / bristle.conf
 *    每行 "序号,文件夹\文件.bmp"，纹理解码为笔尖/纹理
 *  - 笔刷 ini（scatter 笔刷）：[Parameters] 里的 Density / AngleControl / Angle / Blur ... 
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const zip = isNode ? require('./zip.js') : root.BC.zip;
  const png = isNode ? require('./png.js') : root.BC.png;

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function isBmp(bytes) { return bytes && bytes.length > 26 && bytes[0] === 0x42 && bytes[1] === 0x4d; }
  function isPng(bytes) { return bytes && bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50; }

  function decodeText(bytes) {
    if (typeof TextDecoder !== 'undefined' && bytes && bytes.length >= 2) {
      if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le').decode(bytes).replace(/^\uFEFF/, '');
      if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be').decode(bytes).replace(/^\uFEFF/, '');
    }
    const text = util.utf8Decode(bytes).replace(/^\uFEFF/, '');
    if (text.indexOf('\uFFFD') >= 0 && typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('shift_jis').decode(bytes); } catch (e) { /* retain UTF8 result */ }
    }
    return text;
  }

  /* BMP -> {w,h,gray}（支持 8 位调色板 / 24 位 / 32 位，含自底向上与自顶向下） */
  function decodeBmp(bytes) {
    if (!isBmp(bytes) || bytes.length < 54) return null;
    const offBits = u32(bytes, 10);
    const headerSize = u32(bytes, 14);
    const w = u32(bytes, 18) | 0;
    let h = u32(bytes, 22) | 0;
    const bpp = u16(bytes, 28);
    const compression = u32(bytes, 30);
    if (headerSize < 40 || 14 + headerSize > bytes.length || u16(bytes, 26) !== 1 ||
        compression !== 0 || w <= 0 || h === 0 || [8, 24, 32].indexOf(bpp) < 0) return null;
    const topDown = h < 0;
    h = Math.abs(h);
    const rowSize = Math.ceil(bpp * w / 32) * 4;
    if (!Number.isSafeInteger(w * h) || w * h > 16 * 1024 * 1024 ||
        offBits < 14 + headerSize || offBits + rowSize * h > bytes.length) return null;
    const colors = bpp === 8 ? (u32(bytes, 46) || 256) : 0;
    if (colors > 256 || (colors && 14 + headerSize + colors * 4 > offBits)) return null;
    const gray = new Uint8Array(w * h);
    const palette = [];
    if (bpp === 8) {
      for (let i = 0; i < colors; i++) {
        const o = 14 + headerSize + i * 4;
        palette.push([bytes[o + 2], bytes[o + 1], bytes[o]]);
      }
    }
    for (let y = 0; y < h; y++) {
      const srcRow = topDown ? y : (h - 1 - y);
      const rowOff = offBits + srcRow * rowSize;
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        if (bpp === 8) {
          const idx = bytes[rowOff + x];
          const p = palette[idx];
          if (!p) return null;
          r = p[0]; g = p[1]; b = p[2];
        } else if (bpp === 24) {
          const o = rowOff + x * 3;
          b = bytes[o]; g = bytes[o + 1]; r = bytes[o + 2];
        } else if (bpp === 32) {
          const o = rowOff + x * 4;
          b = bytes[o]; g = bytes[o + 1]; r = bytes[o + 2];
        } else return null;
        gray[y * w + x] = Math.round((r + g + b) / 3);
      }
    }
    return { w: w, h: h, gray: gray };
  }

  function decodeImage(bytes) {
    if (isBmp(bytes)) {
      const g = decodeBmp(bytes);
      if (!g) return null;
      const rgba = new Uint8Array(g.w * g.h * 4);
      for (let i = 0; i < g.w * g.h; i++) {
        const v = g.gray[i];
        rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = v;
      }
      return { w: g.w, h: g.h, rgba: rgba };
    }
    if (isPng(bytes)) {
      try {
        const img = png.decode(bytes);
        const rgba = png.toMaskRgba(img.rgba);
        let alphaMask = false;
        for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] !== 255) { alphaMask = true; break; }
        // Native grayscale assets use white as coverage; transparent PNGs carry
        // their coverage in alpha (including black RGB under visible pixels).
        if (!alphaMask) for (let i = 0; i < rgba.length; i += 4) rgba[i + 3] = Math.round((img.rgba[i] + img.rgba[i + 1] + img.rgba[i + 2]) / 3);
        return { w: img.width, h: img.height, rgba: rgba };
      } catch (e) { return null; }
    }
    return null;
  }

  function isSai2Pack(bytes, knownEntries) {
    if (!zip.isZip(bytes)) return false;
    let entries;
    try { entries = knownEntries || zip.read(bytes); } catch (e) { return false; }
    if(entries.some(e => /(^|\/)(brushform|brushtex|papertex|scatter|bristle|blotmap)\.conf$/i.test(e.name)))return true;
    if(entries.some(e => !e.dir && isToolRecord(e.name) && isToolnrm(e.data())))return true;
    const names=new Set(entries.filter(e=>!e.dir).map(e=>e.name.replace(/\\/g,'/').toLowerCase()));
    return entries.some(e=>!e.dir&&/\.ini$/i.test(e.name)&&
      ['.bmp','.png'].some(ext=>names.has(e.name.replace(/\\/g,'/').replace(/\.ini$/i,ext).toLowerCase()))&&isBrushIni(e.data()));
  }

  function isBrushIni(bytes) {
    if (!bytes || bytes.length < 20 || bytes.length > 1024 * 1024 || zip.isZip(bytes)) return false;
    const head = decodeText(bytes.subarray(0, Math.min(4096, bytes.length)));
    return /\[Parameters\]/i.test(head) && /(?:^|\r?\n)\s*(?:Density|AngleControl|Angle|AngleJitter|Scaling|ShapeSize|SizeJitter|Spacing|Scattering|WxHRatio|WxHJitter|Count|CountJitter|AllDirScattering|GaussianDistribution|AbsoluteSize|IntegerPosition|HighQualitySampling|ColJitter|HueJitter|SaturationJitter|BrightnessJitter|ApplyToEachShape|Opacity|EdgeHardness)\s*=/i.test(head);
  }

  function parseIniParams(text) {
    const out = {};
    for (const line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.charAt(0) === ';' || t.charAt(0) === '[') continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      out[k] = /^[+-]?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    return out;
  }

  function parseBrushIni(bytes, fileName) {
    const p = parseIniParams(decodeText(bytes));
    const density = p.Opacity === undefined ? (p.Density === undefined ? 100 : p.Density) : p.Opacity;
    /* Density 只按它自己取 flow；没有 Density 时不再把 Opacity 复制成流量
       （官方 [Parameters] 里没有 Density/Opacity，二者都是本项目内部约定） */
    const flowRaw = p.Density !== undefined && isFinite(Number(p.Density)) ? Number(p.Density) : undefined;
    const angle = p.Angle === undefined ? 0 : p.Angle;
    const base = String(fileName || 'sai2-brush').replace(/\.ini$/i, '').replace(/^.*[\\/]/, '');
    const scatPct = Math.max(0, Math.min(1000, Number(p.Scattering) || 0));
    const scatCnt = Math.max(1, Math.min(20, Math.round(Number(p.Count) || 1)));
    const colJ = Math.max(0, Math.min(1, (Number(p.ColJitter) || 0) / 100));
    const hueJ = Math.max(0, Math.min(1, (Number(p.HueJitter) || 0) / 100));
    const satJ = Math.max(0, Math.min(1, (Number(p.SaturationJitter) || 0) / 100));
    const briJ = Math.max(0, Math.min(1, (Number(p.BrightnessJitter) || 0) / 100));
    const colOn = colJ > 0.001 || hueJ > 0.001 || satJ > 0.001 || briJ > 0.001;
    const angCtl = p.AngleControl === undefined ? 1 : Number(p.AngleControl);
    const followsDir = angCtl === 1;
    const followsTilt = angCtl === 2;
    const perTip = p.ApplyToEachShape === undefined ? undefined : Number(p.ApplyToEachShape) === 1;
    /* 官方注释：Scaling 0～200，缺省 100；0 是合法值，不能用 || 100 兜底 */
    const scalingVal = p.Scaling === undefined || String(p.Scaling).trim() === '' || !isFinite(Number(p.Scaling))
      ? undefined : Math.max(0, Math.min(200, Number(p.Scaling)));
    return {
      brushes: [{
        name: base,
        tip: null,
        sizePx: p.ShapeSize === undefined ? 100 : Math.max(1, Math.min(5000, p.ShapeSize)),
        spacingPct: p.Spacing === undefined ? 25 : Math.max(0, Math.min(1000, p.Spacing)),
        opacity: Math.max(0, Math.min(1, density / 100)),
        flowPct: flowRaw === undefined ? undefined : Math.max(0, Math.min(1, flowRaw / 100)),
        minSizeRatio: 0,
        minOpacityRatio: 0,
        pressureSize: true,
        pressureOpacity: false,
        hardness: p.EdgeHardness === undefined ? 1 : Math.max(0, Math.min(1, p.EdgeHardness / 100)),
        angle: angle,
        dynamicsControlAngle: followsDir ? 6 : (followsTilt ? 3 : undefined),
        bruRotationMode: followsDir ? 1 : (followsTilt ? 4 : 0),
        tiltAngleDyn: followsTilt ? 1 : undefined,
        angleJitterDeg: Math.max(0, Math.min(360, (Number(p.AngleJitter) || 0) * 3.6)),
        sizeJitterPct: Math.max(0, Math.min(100, Number(p.SizeJitter) || 0)),
        roundness: typeof p.WxHRatio==='string' && /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(p.WxHRatio) && Number(p.WxHRatio.split(':')[1])>0
          ? Math.max(0,Math.min(100,100*Number(p.WxHRatio.split(':')[0])/Number(p.WxHRatio.split(':')[1]))) : 100,
        roundnessJitterPct: Math.max(0, Math.min(100, Number(p.WxHJitter) || 0)),
        scatterOn: scatPct > 0.01 || scatCnt > 1,
        scatterPct: scatPct,
        scatterCount: scatCnt,
        countJitterPct: Math.max(0, Math.min(100, Number(p.CountJitter) || 0)),
        scatterBothAxes: p.AllDirScattering === undefined ? false : Number(p.AllDirScattering) !== 0,
        colorDynamicsOn: colOn,
        colorJitterFgBg: colJ,
        jitterSecondary: colJ > 0 ? colJ : undefined,
        colorJitterHue: hueJ,
        colorJitterSat: satJ,
        colorJitterVal: briJ,
        colorPerTip: perTip,
        sai2Scaling: scalingVal,
        source: 'sai2',
        _sai2SourceOpacity: Math.max(0, Math.min(1, density / 100)),
        _sai2ini: p
      }],
      warnings: ['SAI2 笔刷 ini 只含笔形参数，笔尖图需从素材包（blotmap/brshape/brushtex）里配套使用']
    };
  }

  /* 兼容参数记录：老包叫 toolnrm，新包（第161轮，改成可直接拖进 SAI2 的目录结构）叫
     「SAI2参数记录.txt」。两种都要能读回，否则纹理缩放/流量这些旁带参数会丢。 */
  function isToolRecord(name) {
    const n = String(name || '');
    return /(^|[\\/])toolnrm$/i.test(n) || /(^|[\\/])SAI2参数记录\.txt$/i.test(n);
  }

  /* SAI2 笔刷预设文件（toolnrm）：INI 结构，每条笔刷一组 key=value
    参考字段：id/name/desc/brpat_vsbpos/brwav/drawmode/bri/depth/f_prs2dp/f_prs2sz/
             prsfeel/szmin/dpmin/dpmax/quality/blend/water/stretch/bfval/txval/
             brfnam/texnam/brsize/brsizesc/smooth/edgehdns */
  function isToolnrm(bytes) {
    if (!bytes || bytes.length < 40 || bytes.length > 4 * 1024 * 1024 || zip.isZip(bytes)) return false;
    const head = decodeText(bytes.subarray(0, Math.min(bytes.length, 8192)));
    return /brsize\s*=/.test(head) && /(szmin|depth|drawmode)\s*=/.test(head);
  }

  function parseToolnrm(bytes) {
    const text = decodeText(bytes);
    const hasSections = /^\s*\[[^\]\r\n]+\]/m.test(text);
    const lines = text.split(String.fromCharCode(10));
    const records = [];
    let cur = {};
    let started = false;
    const flush = function () {
      if (started && Object.keys(cur).length) records.push(cur);
      cur = {};
      started = false;
    };
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) { if (!hasSections) flush(); continue; }
      if (t.charAt(0) === ';' || t.charAt(0) === '#') continue;
      if (t.charAt(0) === '[') { flush(); started = true; cur.__section = t.slice(1, -1); continue; }
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      started = true;
      cur[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    flush();
    const brushes = [];
    let idx = 0;
    for (const r of records) {
      if (r.name === undefined && r.brsize === undefined) continue;
      idx++;
      const size = Math.max(1, Math.min(5000, Number(r.brsize) || Number(r.brsizesc) || 30));
      const szmin = Number(r.szmin);
      const depth = Number(r.depth);
      const bfval = r.bfval !== undefined && String(r.bfval).trim() !== '' && isFinite(Number(r.bfval))
        ? Math.max(0, Math.min(1, Number(r.bfval) / 100)) : undefined;
      const texscl = r.texscl !== undefined && String(r.texscl).trim() !== '' && isFinite(Number(r.texscl)) && Number(r.texscl) > 0
        ? Math.max(0.01, Math.min(10, Number(r.texscl) / 100)) : undefined;
      const texinvf = r.texinvf !== undefined && String(r.texinvf).trim() !== '' ? Number(r.texinvf) === 1 : undefined;
      const stretch = r.stretch !== undefined && String(r.stretch).trim() !== '' && isFinite(Number(r.stretch))
        ? Math.max(0, Math.min(1, Number(r.stretch) / 100)) : undefined;
      brushes.push({
        name: r.name || ('SAI2 ' + idx),
        tip: null,
        sizePx: Math.round(size),
        spacingPct: 10,
        opacity: isFinite(depth) ? Math.max(0, Math.min(1, depth / 100)) : 1,
        flowPct: bfval,
        minSizeRatio: isFinite(szmin) ? Math.max(0, Math.min(1, szmin / 100)) : 0,
        minOpacityRatio: Number(r.dpmin) ? Math.max(0, Math.min(1, Number(r.dpmin) / 100)) : 0,
        pressureSize: r.f_prs2sz === '1',
        pressureOpacity: r.f_prs2dp === '1',
        pressureSmudge: r.f_prs2bl !== undefined ? r.f_prs2bl === '1' : undefined,
        keepOpacity: r.f_keepopac !== undefined ? r.f_keepopac === '1' : undefined,
        hardness: r.edgehdns !== undefined && isFinite(Number(r.edgehdns)) ? Math.max(0, Math.min(1, Number(r.edgehdns) / 100))
          : (r.prsfeel !== undefined && isFinite(Number(r.prsfeel)) ? Math.max(0, Math.min(1, Number(r.prsfeel) / 100)) : 1),
        angle: 0,
        roundness: 100,
        smudgeOn: Number(r.blend) > 0,
        smudgeAmount: Number(r.blend) ? Math.max(0, Math.min(1, Number(r.blend) / 100)) : 0,
        wetEdgesOn: Number(r.water) > 0,
        wetEdgesAmount: Number(r.water) ? Math.max(0, Math.min(1, Number(r.water) / 100)) : 0,
        colorStretch: stretch,
        smoothingStrength: Number(r.smooth) ? Math.max(0, Math.min(1, Number(r.smooth) / 100)) : 0,
        textureScale: texscl,
        textureInverted: texinvf,
        source: 'sai2',
        _sai2tool: r
      });
    }
    return { brushes: brushes, warnings: brushes.length ? [] : ['toolnrm 里没有读到笔刷条目'] };
  }

  function parsePack(bytes, fileName) {
    const entries = zip.read(bytes), files = new Map(), confs = [], brushes = [], warnings = [];
    const consumedShapes = new Set(), consumedTextures = new Set(), consumedIni = new Set();
    const key = name => String(name).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    const folder = name => key(name).replace(/[^/]+$/, '');
    const stem = name => key(name).replace(/^.*\//, '').replace(/\.(bmp|png|ini)$/i, '');
    for (const entry of entries) {
      if (entry.dir) continue;
      if (!files.has(key(entry.name))) files.set(key(entry.name), entry);
      const m = key(entry.name).match(/(^|\/)(brushform|brushtex|papertex|scatter|bristle|blotmap)\.conf$/);
      if (m) confs.push({category:m[2], entry:entry});
    }
    function resolveImage(ref, prefix, role, allowUniqueName) {
      if (!ref) return null;
      const path = key(ref).replace(/^"|"$/g, '');
      const candidates = [], suffixes = /\.(bmp|png)$/.test(path) ? [''] : ['.bmp','.png'];
      const dirs = role === 'texture' ? ['brushtex/',''] : ['', 'scatter/', 'brushfom/brshape/', 'brshape/', 'blotmap/'];
      for (const base of [prefix, '']) for (const dir of dirs) for (const ext of suffixes) candidates.push(base + dir + path + ext);
      for (const candidate of candidates) if (files.has(candidate)) return files.get(candidate);
      /* 第161轮：包内改成可直接拖进 SAI2 的目录树（SAIv2/settings/scatter/...）后，
         工具记录（参数记录）在根目录、形状在子目录，原来的「前缀 + 目录」拼法找不到。
         这里按「目录/文件名」做后缀匹配，且只在唯一命中时采用，避免张冠李戴。 */
      for (const dir of dirs) {
        for (const ext of suffixes) {
          const tail = dir + path + ext;
          const hits = entries.filter(e => !e.dir && (key(e.name) === tail || key(e.name).endsWith('/' + tail)));
          if (hits.length === 1) return hits[0];
        }
      }
      if (allowUniqueName) {
        const matches = entries.filter(e => !e.dir && /\.(bmp|png)$/i.test(e.name) && key(e.name).indexOf(prefix) === 0 && stem(e.name) === stem(path));
        if (matches.length === 1) return matches[0];
      }
      return null;
    }
    function attachTexture(brush, record, prefix) {
      if (!record.texnam) return;
      const entry = resolveImage(record.texnam, prefix, 'texture', false);
      let image = null;
      if (entry) {
        if (isBmp(entry.data())) {
          const gray = decodeBmp(entry.data());
          if (gray) {
            const rgba = new Uint8Array(gray.w * gray.h * 4);
            for (let i = 0; i < gray.gray.length; i++) rgba.set([gray.gray[i],gray.gray[i],gray.gray[i],255],i*4);
            image = {w:gray.w,h:gray.h,rgba:rgba};
          }
        } else if (isPng(entry.data())) {
          try { const im=png.decode(entry.data()); image={w:im.width,h:im.height,rgba:im.rgba}; } catch (e) { /* reported below */ }
        }
      }
      if (!image) { warnings.push('缺少或无法解码纹理 ' + record.texnam); return; }
      consumedTextures.add(key(entry.name));
      brush._grainRgba = image; brush.hasTexture = true; brush.textureName = record.texnam;
      brush.textureDepth = record.txval === undefined ? 1 : Math.max(0,Math.min(1,Number(record.txval)/100));
      if (record.texscl !== undefined && String(record.texscl).trim() !== '' && isFinite(Number(record.texscl)) && Number(record.texscl) > 0) {
        brush.textureScale = Math.max(0.01, Math.min(10, Number(record.texscl) / 100));
      }
      if (record.texinvf !== undefined && String(record.texinvf).trim() !== '') {
        brush.textureInverted = Number(record.texinvf) === 1;
      }
    }
    function finish(brush, imageEntry, iniEntry, meta, prefix) {
      if (meta) {
        const record = meta._sai2tool;
        const fields = {name:['name'],sizePx:['brsize','brsizesc'],opacity:['depth'],minSizeRatio:['szmin'],minOpacityRatio:['dpmin'],
          pressureSize:['f_prs2sz'],pressureOpacity:['f_prs2dp'],pressureSmudge:['f_prs2bl'],keepOpacity:['f_keepopac'],
          hardness:['edgehdns','prsfeel'],smudgeOn:['blend'],smudgeAmount:['blend'],
          wetEdgesOn:['water'],wetEdgesAmount:['water'],colorStretch:['stretch'],smoothingStrength:['smooth'],
          textureScale:['texscl'],textureInverted:['texinvf']};
        for (const field of Object.keys(fields)) if (fields[field].some(k=>record[k]!==undefined && String(record[k]).trim()!=='')) brush[field]=meta[field];
        if (!iniEntry && record.bfval !== undefined && String(record.bfval).trim() !== '') brush.flowPct = meta.flowPct;
        brush._sai2tool = record;
        attachTexture(brush, record, prefix);
      }
      brush._sai2SourceSize = brush.sizePx;
      brush._sai2SourceOpacity = brush.opacity;
      brush._sai2SourceRoundness = brush.roundness;
      if (imageEntry) {
        brush.tip = decodeImage(imageEntry.data());
        const ratio = brush._sai2ini && String(brush._sai2ini.WxHRatio || '').split(':').map(Number);
        if (brush.tip && ratio && ratio.length === 2 && ratio.every(Number.isFinite) && ratio[0] > ratio[1] && ratio[1] > 0) {
          // The common roundness field compresses width. A wide native pattern
          // instead compresses height, so carry that geometry in the mask.
          const original = brush.tip, h = Math.max(1,Math.round(original.h*ratio[1]/ratio[0]));
          const top = Math.floor((original.h-h)/2), rgba = new Uint8Array(original.rgba.length).fill(255);
          for(let n=3;n<rgba.length;n+=4)rgba[n]=0;
          for(let y=0;y<h;y++)for(let x=0;x<original.w;x++)rgba[((top+y)*original.w+x)*4+3]=original.rgba[(Math.floor(y*original.h/h)*original.w+x)*4+3];
          brush._sai2AspectOriginalTip=original;
          brush.tip={w:original.w,h:original.h,rgba:rgba};
          brush._sai2AspectTipState=util.brushFingerprint({tip:brush.tip});
        }
        if (brush.tip) consumedShapes.add(key(imageEntry.name));
        else warnings.push('无法解码笔尖 ' + imageEntry.name);
      } else warnings.push('缺少笔尖配图 ' + (iniEntry ? iniEntry.name : brush.name));
      if (iniEntry) consumedIni.add(key(iniEntry.name));
      brushes.push(brush);
    }
    // A tool's explicit shape reference belongs to its own package directory.
    for (const toolEntry of entries.filter(e=>!e.dir && isToolRecord(e.name))) {
      const tools = parseToolnrm(toolEntry.data()).brushes, prefix = folder(toolEntry.name), used = new Set();
      for (const meta of tools) {
        const base = String(meta.name||'brush').replace(/[\\/:*?"<>|]/g,'_').slice(0,60)||'brush';
        let fallback=base,n=2;while(used.has(fallback.toLowerCase()))fallback=base+'_'+n++;used.add(fallback.toLowerCase());
        const ref = meta._sai2tool.brfnam;
        const imageEntry = resolveImage(ref || fallback, prefix, 'shape', !ref);
        const iniEntry = imageEntry && files.get(key(imageEntry.name).replace(/\.(bmp|png)$/i,'.ini'));
        const validIni = iniEntry && isBrushIni(iniEntry.data()) ? iniEntry : null;
        const brush = validIni ? parseBrushIni(validIni.data(),validIni.name).brushes[0] : Object.assign({},meta);
        finish(brush,imageEntry,validIni,meta,prefix);
      }
    }
    for (const entry of entries) {
      if (entry.dir || consumedIni.has(key(entry.name)) || !/\.ini$/i.test(entry.name) || !isBrushIni(entry.data())) continue;
      const path = key(entry.name).replace(/\.ini$/i,'');
      const imageEntry = files.get(path+'.bmp') || files.get(path+'.png');
      finish(parseBrushIni(entry.data(),entry.name).brushes[0],imageEntry,entry,null,folder(entry.name));
    }
    for (const conf of confs) {
      for (const line of decodeText(conf.entry.data()).split(/\r?\n/)) {
        const t=line.trim(), comma=t.indexOf(',');if(!t||/^[;#]/.test(t)||comma<0)continue;
        const path=t.slice(comma+1).trim().replace(/^"|"$/g,'').replace(/\\/g,'/');
        const entry=files.get(folder(conf.entry.name)+key(path))||files.get(key(path));
        if(!entry){warnings.push('缺少素材 '+path);continue;}
        if(consumedShapes.has(key(entry.name))||consumedTextures.has(key(entry.name)))continue;
        if(conf.category==='brushtex'||conf.category==='papertex'){
          warnings.push('独立纹理 '+path+' 未绑定工具，未作为笔尖生成笔刷');continue;
        }
        const tip=decodeImage(entry.data());if(!tip){warnings.push('无法解码素材 '+path);continue;}
        consumedShapes.add(key(entry.name));
        brushes.push({name:entry.name.replace(/^.*[\\/]/,'').replace(/\.[^.]+$/,''),tip:tip,sizePx:Math.max(tip.w,tip.h),spacingPct:100,
          opacity:1,minSizeRatio:0,minOpacityRatio:0,pressureSize:true,hardness:1,angle:0,roundness:100,hasTexture:false,source:'sai2',
          _sai2:{category:conf.category,slot:t.slice(0,comma).trim(),file:path}});
      }
    }
    return {brushes:brushes,warnings:warnings.concat(brushes.length?[]:['SAI2素材包没有可转换笔刷；请同时提供形状/工具及其引用素材'])};
  }

  const api = { isSai2Pack, isBrushIni, isToolnrm, parseToolnrm, parsePack, parseBrushIni, decodeBmp };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { sai2read: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
