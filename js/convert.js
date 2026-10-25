/* Conversion pipeline: detect -> parse -> normalize -> write .bru */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const nodePath = isNode ? require('path') : null;
  const util = isNode ? require('./util.js') : root.BC.util;
  const png = isNode ? require('./png.js') : root.BC.png;
  const zip = isNode ? require('./zip.js') : root.BC.zip;
  const abr = isNode ? require('./abr.js') : root.BC.abr;
  const procreate = isNode ? require('./procreate.js') : root.BC.procreate;
  const bru = isNode ? require('./bru.js') : root.BC.bru;
  const gimp = isNode ? require('./gimp.js') : root.BC.gimp;
  const mypaint = isNode ? require('./mypaint.js') : root.BC.mypaint;
  const krita = isNode ? require('./krita.js') : root.BC.krita;
  const genericBrush = isNode ? require('./genericbrush.js') : root.BC.genericBrush;
  const csp = isNode ? require('./csp.js') : root.BC.csp;
  const medibang = isNode ? require('./medibang.js') : root.BC.medibang;
  const medibangIni = isNode ? require('./medibangIni.js') : root.BC.medibangIni;
  const sai2read = isNode ? require('./sai2read.js') : root.BC.sai2read;
  const painterlib = isNode ? require('./painterlib.js') : root.BC.painterlib;
  const gobrush = isNode ? require('./gobrush.js') : root.BC.gobrush;
  const gobrushWrite = isNode ? require('./gobrushWrite.js') : root.BC.gobrushWrite;
  const sai2 = isNode ? require('./sai2.js') : root.BC.sai2;
  const infpainter = isNode ? require('./infpainter.js') : root.BC.infpainter;

  function detect(name, bytes) {
    const lower = (name || '').toLowerCase();
    const safe = function (fn) { try { return !!fn(); } catch (e) { return false; } };
    if (/\.params\.json$/.test(lower)) return 'csp-decrypted';
    if (medibangIni && safe(function () { return medibangIni.isIni(bytes); })) return 'mbini';
    if (sai2read && safe(function () { return sai2read.isToolnrm(bytes); })) return 'sai2tool';
    if (sai2read.isBrushIni(bytes)) return 'sai2ini';
    if (bru && safe(function () { return bru.isBru(bytes); })) return 'bru';
    if (csp && safe(function () { return csp.isSut(bytes); })) return 'sut';
    if (gobrush && safe(function () { return gobrush.isGobrush(lower); })) return 'gobrush';
    if (zip && safe(function () { return zip.isZip(bytes); })) {
      let zentries = null;
      try { zentries = zip.read(bytes); } catch (e) { /* ignore */ }
      if (zentries) {
        if (zentries.some(e => /^brush2\.ini$/i.test(e.name.replace(/^.*\//, '')))) return 'mbini_set';
        if (zentries.some(e => /(^|\/)(brushform|brushtex|papertex|scatter|bristle)\.conf$/i.test(e.name))) return 'sai2pack';
        if (painterlib && safe(function () { return painterlib.isLibraryZip(bytes); })) return 'painter';
        if (zentries.some(e => /Brush\.archive$/i.test(e.name))) return 'procreate';
        if (zentries.some(e => /^paintoppresets\/[^/]+\.kpp$/i.test(e.name))) return 'kbundle';
      }
      return null;
    }
    if (bytes && bytes.length > 10 && bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x54) return 'pat';
    if (abr && safe(function () { return abr.isAbr(bytes); })) return 'abr';
    if (krita && safe(function () { return krita.isKpp(bytes); })) return 'kpp';
    if (gimp && safe(function () { return gimp.isGbr(bytes); })) return /.gih$/i.test(lower) ? 'gih' : 'gbr';
    if (mypaint && safe(function () { return mypaint.isMyb(bytes); })) return 'myb';
    if (genericBrush && safe(function () { return genericBrush.isPainterXml(bytes); })) return 'painter';
    // extension fallbacks
    if (lower.endsWith('.abr')) return 'abr';
    if (lower.endsWith('.bru')) return 'bru';
    if (lower.endsWith('.brush') || lower.endsWith('.brushset')) return 'procreate';
    if (lower.endsWith('.kpp')) return 'kpp';
    if (lower.endsWith('.gbr')) return 'gbr';
    if (lower.endsWith('.gih')) return 'gih';
    if (lower.endsWith('.myb')) return 'myb';
    if (lower.endsWith('.brushcategory') || lower.endsWith('.brushlibrary')) return 'painter';
    if (lower.endsWith('.sut')) return 'sut';
    if (lower.endsWith('.gobrush') || lower.endsWith('.gobrushes')) return 'gobrush';
    return null;
  }

  function extLabel(kind) {
    return {
      abr: 'Photoshop ABR',
      procreate: 'Procreate 笔刷',
      bru: '画世界Pro BRU',
      kpp: 'Krita KPP',
      gbr: 'GIMP GBR',
      gih: 'GIMP GIH',
      myb: 'MyPaint MYB',
      painter: 'Corel Painter',
      mdp: 'MediBang MDP',
      sut: 'Clip Studio Paint SUT',
      gobrush: '天生会画 GoBrush',
      kbundle: 'Krita 资源包 BUNDLE',
      'csp-decrypted': 'CSP 解密目录',
      mbini: 'MediBang 云笔刷 Brush2.ini',
      'mbini_set': 'MediBang 云笔刷包',
      sai2pack: 'SAI 2 素材包',
      sai2ini: 'SAI 2 笔刷 ini',
      sai2tool: 'SAI 2 笔刷预设 toolnrm',
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
      let data;
      try { data = entry.data(); } catch (e) { warnings.push(entry.name + ' 读取失败'); continue; }
      try {
        const r = krita.parseKpp(data instanceof Uint8Array ? data : new Uint8Array(data), entry.name, resourceMap);
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

  function parseFile(name, bytes, opts) {
    const kind = detect(name, bytes);
    if (!kind) throw new Error('无法识别的文件格式（支持 .bru/.abr/.brush/.brushset/.gobrush/.gobrushes/.sut/.kpp/.gbr/.gih/.myb/.brushcategory/.brushlibrary，或包含笔刷的 ZIP）');
    let result;
    if (kind === 'bru') {
      result = bru.parseBru(bytes);
      result.brushes = result.brushes.map(b => Object.assign({}, b, { source: 'bru' }));
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
            hasTexture: true,
            _patternPixels: { w: pt.width, h: pt.height, mode: 1, data: pt.gray },
            source: 'pat'
          };
        }),
        warnings: []
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
      result = procreate.parse(bytes, name);
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
    return { kind, kindLabel: extLabel(kind), brushes: result.brushes, warnings: result.warnings || [] };
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
    const rotNeeded = Math.abs(Math.sin(angle)) > 0.001;
    if (!rotNeeded && round >= 0.995 && !flipX && !flipY) return img;
    const w = img.w, h = img.h, src = img.rgba;
    const cos = Math.cos(angle), sin = Math.sin(angle);
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

  function sanitizeName(name, index) {
    let n = (name || '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!n) n = 'brush_' + String(index + 1).padStart(3, '0');
    if (n.length > 60) n = n.slice(0, 60).trim();
    return n;
  }

  /**
   * Convert one parsed brush to a .bru file.
   * opts: { maxTipSize, sizeScale, spacingOverride, pressure }
   */
  function makeBru(brush, opts) {
    opts = opts || {};
    let tipImg = tipToRGBA(brush);
    if (!tipImg) tipImg = synthTip(brush, 256, opts);
    if (brush.dualOn && brush.dualTip && (brush.dualTip.rgba || brush.dualTip.data) && opts.noDualBake !== true) tipImg = bakeDualTip(tipImg, brush);
    // 圆度/角度只在 bakeTipTransform 里应用一次（之前 abr 源会被压两次 → 笔刷变得又细又扁）
    tipImg = bakeTipTransform(tipImg, brush);
    const maxTip = Math.max(32, Math.min(2048, opts.maxTipSize || 512));
    const wantTip = Math.max(32, Math.min(512, Math.round(((brush.sizePx || 100) * (opts.sizeScale || 1)))));
    let w = tipImg.w, h = tipImg.h, rgba = tipImg.rgba;
    const maxSide = Math.max(w, h);
    if (maxSide > maxTip) {
      const scale = maxTip / maxSide;
      const nw = Math.max(1, Math.round(w * scale));
      const nh = Math.max(1, Math.round(h * scale));
      rgba = png.resize(rgba, w, h, nw, nh);
      w = nw; h = nh;
    }
    if (Math.max(w, h) > wantTip) {
      const scale2 = wantTip / Math.max(w, h);
      const nw2 = Math.max(1, Math.round(w * scale2));
      const nh2 = Math.max(1, Math.round(h * scale2));
      rgba = png.resize(rgba, w, h, nw2, nh2);
      w = nw2; h = nh2;
    }
    const pngBytes = png.encode(w, h, png.toMaskRgba(rgba));
    const sizeScale = opts.sizeScale || 1;
    let sizePx = (brush.sizePx || 100) * sizeScale;
    if (!isFinite(sizePx) || sizePx < 1) sizePx = Math.max(4, Math.max(w, h));
    sizePx = Math.max(1, Math.min(3000, Math.round(sizePx * 100) / 100));
    let spacingPct = opts.spacingOverride > 0 ? opts.spacingOverride : (brush.spacingPct || 10);
    spacingPct = Math.max(1, Math.min(1000, spacingPct));
    const usePressure = opts.pressure === undefined ? !!brush.pressure : !!opts.pressure;
    const meta = {
      name: brush.name || '',
      pkgId: opts.pkgId || brush.pkgId,
      texId: util.md5(pngBytes).toUpperCase(),
      sizePx,
      spacingPct,
      opacity: brush.opacity === undefined ? 1 : brush.opacity,
      minSizeRatio: usePressure ? (brush.minSizeRatio || 0.1) : 1,
      minOpacityRatio: usePressure ? (brush.minOpacityRatio || 0.25) : 1,
      pressure: usePressure,
      // 把能写进 .bru 的其它参数一起带上（纹理/散布/抖动/锥度/湿边/混色/颜色动态/圆度硬度/流量）
      pressureSize: !!brush.pressureSize || !!brush.pressure,
      pressureOpacity: !!brush.pressureOpacity,
      flowPct: brush.flowPct,
      minFlowRatio: brush.minFlowRatio,
      roundness: brush.roundness,
      hardness: brush.hardness,
      smoothingStrength: brush.smoothingStrength,
      angle: brush.angle,
      angleJitterDeg: brush.angleJitterDeg,
      sizeJitterPct: brush.sizeJitterPct,
      spacingJitterPct: brush.spacingJitterPct,
      flowJitterPct: brush.flowJitterPct,
      countJitterPct: brush.countJitterPct,
      scatterOn: brush.scatterOn,
      // 画世界的散布刻度比 Procreate/PS 小：默认按 15% 缩放（界面高级设置可调）
      scatterPct: brush.scatterPct === undefined ? undefined : Math.min(1000, brush.scatterPct * (opts.scatterScale === undefined ? 0.15 : opts.scatterScale)),
      scatterBothAxes: brush.scatterBothAxes,
      scatterCount: brush.scatterCount,
      hasTexture: brush.hasTexture,
      textureScale: brush.textureScale,
      textureBrightness: brush.textureBrightness,
      textureContrast: brush.textureContrast,
      textureDepth: brush.textureDepth,
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
      smudgeOn: brush.smudgeOn,
      smudgeAmount: brush.smudgeAmount,
      colorDynamicsOn: brush.colorDynamicsOn,
      colorJitterHue: brush.colorJitterHue,
      colorJitterSat: brush.colorJitterSat,
      colorJitterVal: brush.colorJitterVal,
      _rawMeta: opts.fidelity !== false ? brush._rawMeta : undefined
    };
    const bytes = bru.writeBrush(Object.assign({ png: pngBytes }, meta), opts);
    return { bytes, pngBytes, meta, tipW: w, tipH: h };
  }

  /**
   * Convert a list of parsed brushes into ONE multi-brush .bru pack
   * (画世界Pro keeps the whole set together when importing a single .bru).
   */
  function makeBruPack(brushList, opts) {
    opts = opts || {};
    const items = [];
    const used = new Map();
    brushList.forEach(function (brush, i) {
      const made = makeBru(brush, opts);
      let base = sanitizeName(brush.name, i);
      let name = base, k = 2;
      while (used.has(name.toLowerCase())) { name = base + ' (' + k + ')'; k++; }
      used.set(name.toLowerCase(), 1);
      items.push(Object.assign({}, made.meta, { name: name, png: made.pngBytes }));
    });
    if (!items.length) throw new Error('没有可打包的笔刷');
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
    if (brush._patternPixels && brush._patternPixels.w > 0) {
      const pp = brush._patternPixels, w = pp.w, h = pp.h;
      const gray = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        if (pp.mode === 3) { const o = i * 3; gray[i] = Math.round((pp.data[o] + pp.data[o + 1] + pp.data[o + 2]) / 3); }
        else gray[i] = pp.data[i];
      }
      return { w: w, h: h, gray: gray };
    }
    if (brush._grainRgba && brush._grainRgba.w > 0) {
      const g = brush._grainRgba, w = g.w, h = g.h;
      const gray = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) gray[i] = g.rgba[i * 4 + 3];
      return { w: w, h: h, gray: gray };
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
      list.push({ key: key, t: t, name: (b.textureName || 'brushconv-texture') });
    }
    if (!list.length) {
      const made = patMod.buildGrainPat({ size: opts.size || 256, seed: opts.seed || 11 });
      return { bytes: made.bytes, count: 1, refs: new Map(), ref: { id: made.id, name: made.name }, width: made.width, height: made.height };
    }
    const records = [];
    const refs = new Map();
    let i = 0;
    for (const item of list) {
      i++;
      const base = String(item.name || 'texture').replace(/^.*=/, '');
      const nm = (base && base !== 'brushconv-texture' ? base : ('纹理 ' + i)).slice(0, 30) + (i > 1 ? (' ' + i) : '');
      const p = patMod.buildPattern(nm, item.t.w, item.t.h, [item.t.gray, item.t.gray, item.t.gray], undefined, true);
      records.push(p);
      refs.set(item.key, { id: p.id, name: p.name });
    }
    const bytes = patMod.buildPat(records);
    // 自检：用内置 .pat 读取器回读，确认图案数量/尺寸与预期一致（不需要真实 PS）
    let selfCheck = { ok: true, readCount: records.length, names: records.map(function (r) { return r.name; }) };
    try {
      const reader = isNode ? require('./patRead.js') : root.BC.patRead;
      if (reader && reader.readPat) {
        const back = reader.readPat(bytes);
        selfCheck.readCount = back.length;
        selfCheck.ok = back.length === records.length && back.every(function (pt, idx) {
          return pt.width === list[idx].t.w && pt.height === list[idx].t.h;
        });
        selfCheck.names = back.map(function (x) { return x.name; });
      }
    } catch (e) { selfCheck.ok = false; selfCheck.error = e.message; }
    return { bytes: bytes, count: records.length, refs: refs, ref: records[0] ? { id: records[0].id, name: records[0].name } : null, width: list[0].t.w, height: list[0].t.h, selfCheck: selfCheck };
  }

  function makeAbrPack(brushList, opts) {
    opts = opts || {};
    // 重名会让 Photoshop 导入时去重/合并，导致预设与采样错位（画出来变成别的笔刷），
    // 这里统一给重名加序号
    const names = uniqueNames(brushList);
    const items = [];
    brushList.forEach(function (brush, i) {
      let tipImg = tipToRGBA(brush);
      if (!tipImg) tipImg = synthTip(brush, 256, opts);
      if (brush.source === 'abr') tipImg = bakeTipTransform(tipImg, brush);
      const maxTip = Math.max(64, Math.min(2048, opts.maxTipSize || 512));
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
      const willUseRaw = opts.preserveRaw !== false && !!brush._rawPreset;
      const textureMode = opts.textureMode === 'pattern';
      const usePsTexture = !!brush.hasTexture && (textureMode || (opts.writePsTexture === true && willUseRaw));
      if (brush.hasTexture && !usePsTexture && !textureMode && opts.noTextureBake !== true) {
        rgba = bakeTextureIntoRGBA(rgba, w, h, brush, brush.textureDepth === undefined ? (brush.grainStrength === undefined ? 0.35 : brush.grainStrength) : brush.textureDepth);
      }
      items.push({
        name: name, w: w, h: h, gray: abr.maskFromRGBA(rgba),
        sizePx: brush.sizePx, spacingPct: brush.spacingPct,
        angle: brush.angle, roundness: brush.roundness,
        flipY: !!opts.abrFlipY,
        pressureSize: !!brush.pressureSize || !!brush.pressure,
        pressureOpacity: !!brush.pressureOpacity,
        minSizeRatio: brush.minSizeRatio,
        minOpacityRatio: brush.minOpacityRatio,
        angleJitterDeg: brush.angleJitterDeg || 0,
        sizeJitterPct: brush.sizeJitterPct || 0,
        flowJitterPct: brush.flowJitterPct || 0,
        countJitterPct: brush.countJitterPct || 0,
        scatterOn: !!brush.scatterOn,
        scatterPct: brush.scatterPct || 0,
        scatterBothAxes: !!brush.scatterBothAxes,
        scatterCount: brush.scatterCount || 1,
        flowPct: brush.flowPct === undefined ? 1 : brush.flowPct,
        opacityPct: brush.opacity === undefined ? 1 : brush.opacity,
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
        colorJitterHue: brush.colorJitterHue,
        colorJitterSat: brush.colorJitterSat,
        colorJitterVal: brush.colorJitterVal,
        colorJitterPurity: brush.colorJitterPurity,
        psTexture: usePsTexture,
        patternRef: (usePsTexture && ((opts.patternRefs && opts.patternRefs.get(textureKey(brush))) || opts.patternRef)) || null,
        textureDepth: brush.textureDepth,
        textureScale: brush.textureScale,
        // 源就是 ABR 时，保留原始描述符/样本字节（部分导出也能保住 PS 原版特性）
        rawPreset: opts.preserveRaw !== false ? brush._rawPreset : undefined,
        rawSample: opts.preserveRaw !== false ? brush._rawSample : undefined,
        keepSampleUuids: brush.dualBrush && brush.dualBrush.uuid ? [brush.dualBrush.uuid] : [],
        sampleMap: brush._sampleMap,
        rawDualObjc: brush._rawDualObjc,
        dualOn: !!(brush.dualBrush && brush.dualBrush.enabled),
        rle: opts.abrRle !== false,
        uuid: (opts.abrUuids && opts.abrUuids[i]) || undefined
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

  /** Convert one brush to a Procreate .brush file (zip). */
  function makeProcreateBrush(brush, opts) {
    opts = opts || {};
    // 还原优先：源本身就是 Procreate，且没有强制重建时，直接原样打包
    if (opts.fidelity !== false && brush._rawArchive && !opts.forceRebuild) {
      const bytes = procreate.writeBrush(brush, { maxTipSize: opts.maxTipSize || 512, noTextureBake: opts.noTextureBake, fidelity: true });
      return { bytes: bytes, name: brush.name || 'brush', passthrough: true };
    }
    const tip = bakedTipFor(brush, opts);
    const b2 = Object.assign({}, brush, { tip: { w: tip.w, h: tip.h, rgba: tip.rgba } });
    const bytes = procreate.writeBrush(b2, { maxTipSize: opts.maxTipSize || 512, noTextureBake: opts.noTextureBake, fidelity: opts.fidelity, forceRebuild: opts.forceRebuild });
    void b2;
    return { bytes: bytes, name: brush.name || 'brush' };
  }

  /** Convert a whole set to one Procreate .brushset file (zip). */
  function makeProcreateBrushset(brushList, opts) {
    opts = opts || {};
    const list = brushList.map(function (b) {
      const tip = bakedTipFor(b, opts);
      return Object.assign({}, b, { tip: { w: tip.w, h: tip.h, rgba: tip.rgba } });
    });
    const bytes = procreate.writeBrushset(list, { maxTipSize: opts.maxTipSize || 512 });
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
      warnings.push('压缩包里没有找到可识别的笔刷文件（支持 .abr/.bru/.brush/.brushset，或包含 .sut + _decrypted 的压缩包）');
    } else if (skipped.length) {
      warnings.push('压缩包内 ' + skipped.length + ' 个不相关文件已忽略（' + skipped.slice(0, 3).join(', ') + '…）');
    }
    return { files, skipped, warnings };
  }

  /* 把双笔刷的第二支笔尖按 alpha 合成进主笔尖（近似，非 PS 的双笔尖混合算法） */
  function bakeDualTip(tip, brush) {
    const d = brush.dualTip;
    if (!d || !tip || !tip.rgba) return tip;
    if (!d.rgba && !d.data) return tip;
    const bpp = d.bpp || 1;
    const dualAlpha = function (x, y) {
      const o = y * d.w + x;
      if (d.rgba) return d.rgba[o * 4 + 3] / 255;
      if (bpp >= 3) return (d.data[o * bpp] + d.data[o * bpp + 1] + d.data[o * bpp + 2]) / 3 / 255;
      return d.data[o] / 255;
    };
    const w = tip.w, h = tip.h;
    const out = new Uint8Array(w * h * 4);
    const blend = String(brush.dualBlendMode || '').toLowerCase();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.min(d.w - 1, Math.floor(x * d.w / w));
        const sy = Math.min(d.h - 1, Math.floor(y * d.h / h));
        const a1 = tip.rgba[(y * w + x) * 4 + 3] / 255;
        const a2 = dualAlpha(sx, sy);
        let a;
        if (blend.indexOf('scrn') >= 0 || blend.indexOf('lghn') >= 0) a = 1 - (1 - a1) * (1 - a2);
        else if (blend.indexOf('drkn') >= 0) a = Math.min(a1, a2);
        else if (blend.indexOf('ovrl') >= 0) a = a1 < 0.5 ? 2 * a1 * a2 : 1 - 2 * (1 - a1) * (1 - a2);
        else a = a1 * a2; // 默认按乘（PS 双笔刷最常见的遮罩语义）
        const o = (y * w + x) * 4;
        out[o] = tip.rgba[o]; out[o + 1] = tip.rgba[o + 1]; out[o + 2] = tip.rgba[o + 2];
        out[o + 3] = Math.max(0, Math.min(255, Math.round(Math.max(a1 * 0.05, a) * 255)));
      }
    }
    return { w: w, h: h, rgba: out };
  }

  /* 取笔尖并（在目标不支持双笔刷时）把第二支笔尖合成进去 */
  function bakedTipFor(brush, opts) {
    opts = opts || {};
    let tip = tipToRGBA(brush) || synthTip(brush, 256, opts);
    if (brush.dualOn && brush.dualTip && (brush.dualTip.rgba || brush.dualTip.data) && opts.noDualBake !== true) {
      tip = bakeDualTip(tip, brush);
    }
    return tip;
  }

  /** Convert one brush to a GIMP .gbr file (8-bit gray tip). */
  function makeGbr(brush, opts) {
    opts = opts || {};
    // 还原优先：源就是 .gbr 时直接原样输出
    if (opts.fidelity !== false && brush._rawKind === 'gbr' && brush._rawFile) {
      return { bytes: new Uint8Array(brush._rawFile), count: 1, passthrough: true };
    }
    const b2 = withTipRGBA(brush, opts, { bake: true, fit: true });
    const w = b2.tip.w, h = b2.tip.h;
    const gray = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) gray[k] = b2.tip.rgba[k * 4 + 3];
    const name = String(brush.name || 'brush').trim().slice(0, 120);


    return { bytes: gimp.writeGbr({ name: name, tip: { w: w, h: h, data: gray }, spacingPct: brush.spacingPct }), count: 1 };
  }

  /** Convert one brush to a MyPaint .myb file. */
  function makeMyb(brush, opts) {
    opts = opts || {};
    // 还原优先：源就是 .myb 时原样输出
    if (opts.fidelity !== false && brush._rawMyb && brush._rawMyb.length) {
      return { bytes: new Uint8Array(brush._rawMyb), count: 1, passthrough: true };
    }
    const bt = bakedTipFor(brush, opts);
    const bytes = mypaint.writeMyb(Object.assign({}, brush, { tip: { w: bt.w, h: bt.h, rgba: bt.rgba } }));
    return { bytes: bytes, count: 1 };
  }

  /** One brush -> Krita .kpp (best-effort preset). */
  function makeKpp(brush, opts) {
    const b2 = withTipRGBA(brush, opts);
    return { bytes: krita.writeKpp(b2), count: 1 };
  }

  /** Brush list -> one GIMP .gih pipe. */
  function makeGih(brushList, opts) {
    opts = opts || {};
    // 还原优先：整组来自同一个 .gih 时原样输出
    if (opts.fidelity !== false && brushList.length && brushList.every(function (b) { return b._rawKind === 'gih' && b._rawFile; })) {
      const ref = brushList[0]._rawFile;
      const sameBytes = function (a, b) {
        if (!a || !b || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
      };
      const same = brushList.every(function (b) { return b._rawFile === ref || sameBytes(b._rawFile, ref); });
      if (same) return { bytes: new Uint8Array(brushList[0]._rawFile), count: brushList.length, passthrough: true };
    }
    const list = brushList.map(function (b) { return withTipRGBA(b, opts); });
    const name = (opts.name && String(opts.name).trim()) ||
      (list.length ? String(list[0].name || '').trim() : '') || 'brushconv';
    return { bytes: gimp.writeGih(list, name), count: list.length };
  }

  /** Brush list -> Corel Painter .brushcategory XML (heuristic). */
  function makePainter(brushList, opts, name) {
    const painter = isNode ? require('./painterlib.js') : root.BC.painterlib;
    // 没有真实笔尖的笔刷先合成一个，保证每支都能生成 .nib
    const list = (brushList || []).map(function (b) {
      try { return withTipRGBA(b, opts || {}); } catch (e) { return b; }
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
      - flags.bake: squash the tip width by brush.roundness so formats without a
        roundness field (GBR/BRU/MDP/PRBR) still look oval;
      - flags.fit: scale the tip to brush.sizePx so pixel-sized brush formats
        (GBR/GIH/MDP/PRBR) keep the intended brush size. */
  function withTipRGBA(brush, opts, flags) {
    opts = opts || {};
    flags = flags || {};
    let tip = tipToRGBA(brush) || synthTip(brush, 256, opts);
    // 目标格式没有"双笔刷"时：把第二支笔尖按 alpha 混合进主笔尖，保留大致外观
    if (flags.dual !== false && brush.dualOn && brush.dualTip && (brush.dualTip.rgba || brush.dualTip.data)) {
      tip = bakeDualTip(tip, brush);
    }
    let w = tip.w, h = tip.h, rgba = tip.rgba;
    if (flags.bake) {
      const round = Math.max(5, Math.min(100, brush.roundness === undefined ? 100 : brush.roundness)) / 100;
      if (round < 0.98 && w > 1) {
        const nw = Math.max(1, Math.round(w * round));
        rgba = png.resize(rgba, w, h, nw, h);
        w = nw;
      }
    }
    const limit = Math.max(16, Math.min(2048, opts.maxTipSize || 512));
    const maxSide = Math.max(w, h);
    let target = null;
    if (flags.fit && brush.sizePx) target = Math.max(4, Math.min(limit, Math.round(brush.sizePx)));
    if (target && Math.abs(maxSide - target) > 1) {
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

  /** One brush -> Infinite Painter .prbr */
  function makePrbr(brush, opts) {
    const b2 = withTipRGBA(brush, opts, { bake: true, fit: true });
    return { bytes: infpainter.writePrbr(b2), count: 1 };
  }

  /** One brush -> MediBang .mdp material (stamp document). */
  function makeMdp(brushList, opts) {
    const list = Array.isArray(brushList) ? brushList : [brushList];
    const chunks = [];
    for (const b of list) {
      const b2 = withTipRGBA(b, opts, { bake: true, fit: true });
      chunks.push({ name: (sanitizeName(b2.name || 'material', 0)) + '.mdp', data: medibang.writeMdp(b2) });
    }
    if (chunks.length === 1) return { bytes: chunks[0].data, count: 1 };
    return { files: chunks, count: chunks.length };
  }

  /** Build a MediBang Paint brush package: black-shape tip PNG + Brush2.ini entry.
      Install: copy the PNG into %LOCALAPPDATA%\\Medibang\\CloudAlpaca\\brush_bitmap\\
      and append the ini snippet to Brush2.ini, then restart MediBang. */
  function makeMediBangIniPack(brushList, opts) {
    // 保证每支都有笔尖（程序笔刷也转成位图笔刷，否则缺少 .bs 脚本无法被 MediBang 识别）
    const list = (brushList || []).map(function (b) {
      try { return withTipRGBA(b, opts || {}); } catch (e) { return b; }
    });
    return medibangIni.writeIniPack(list, opts || {});
  }

  function makeMediBangBrush(brush, opts) {
    opts = opts || {};
    const b2 = withTipRGBA(brush, opts, { fit: true });
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
    const opacity = Math.max(0.01, Math.min(1, brush.opacity === undefined ? 1 : brush.opacity)).toFixed(3);
    const width = Math.max(1, Math.min(1000, Math.round(brush.sizePx || 40)));
    const section = '[' + (opts.index === undefined ? 100 : opts.index) + ']' + EOL +
      'name=' + (brush.name || 'brush') + EOL +
      'type=bitmap' + EOL +
      'group=-1' + EOL +
      'width=' + width + EOL +
      'min=0' + EOL +
      'opacity=' + opacity + EOL +
      'pSize=true' + EOL +
      'pAlpha=false' + EOL +
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
    let img = tipToRGBA(brush);
    if (!img) img = synthTip(brush, 256, opts);
    if (brush.source === 'abr') img = bakeTipTransform(img, brush);
    const maxTip = Math.max(64, Math.min(2048, opts.maxTipSize || 512));
    let w = img.w, h = img.h, rgba = img.rgba;
    const maxSide = Math.max(w, h);
    if (maxSide > maxTip) {
      const s = maxTip / maxSide;
      const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
      rgba = png.resize(rgba, w, h, nw, nh);
      w = nw; h = nh;
    }
    return {
      bytes: png.encode(w, h, png.toMaskRgba(rgba)),
      w: w, h: h,
      meta: { name: brush.name || 'brush', sizePx: brush.sizePx, spacingPct: brush.spacingPct, opacity: brush.opacity }
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
      压感大小: b.pressureSize ? '是' : (b.pressure ? '是' : '否'),
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

  /* 用源笔刷的真实纹理（ABR 图案 / Procreate Grain）烘焙；没有时退回程序化噪声 */
  function bakeTextureIntoRGBA(rgba, w, h, brush, strength) {
    const k = Math.max(0, Math.min(1, strength === undefined ? 0.35 : strength));
    let tex = null;
    if (brush && brush._grainRgba && brush._grainRgba.w > 0) {
      tex = { w: brush._grainRgba.w, h: brush._grainRgba.h, sample: function (x, y) { return brush._grainRgba.rgba[((y * brush._grainRgba.w) + x) * 4 + 3] / 255; } };
    } else if (brush && brush._patternPixels && brush._patternPixels.w > 0) {
      const pp = brush._patternPixels;
      tex = {
        w: pp.w, h: pp.h, sample: function (x, y) {
          const o = (y * pp.w) + x;
          if (pp.mode === 3) { const o3 = o * 3; return (pp.data[o3] + pp.data[o3 + 1] + pp.data[o3 + 2]) / 765; }
          return pp.data[o] / 255;
        }
      };
    }
    if (!tex) return bakeGrainIntoRGBA(rgba, w, h, k, 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const a = rgba[i * 4 + 3];
        if (!a) continue;
        const tx = Math.min(tex.w - 1, Math.floor(x * tex.w / Math.max(1, w)));
        const ty = Math.min(tex.h - 1, Math.floor(y * tex.h / Math.max(1, h)));
        const v = tex.sample(tx, ty);
        const factor = 1 - k + k * (0.15 + 0.85 * v);
        rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(a * factor)));
      }
    }
    return rgba;
  }

  function bakeGrainIntoRGBA(rgba, w, h, strength, seed) {
    const noise = grainNoise(w, h, seed || 1, 3);
    const k = Math.max(0, Math.min(1, strength === undefined ? 0.35 : strength));
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
        'Get-ChildItem $PSScriptRoot -Include *.gbr,*.gih -File | Copy-Item -Destination $brushes -Force',
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
        'Write-Host "重启 MyPaint 后，在笔刷列表里即可看到"'
      ].join(NL));
      mk('安装到MyPaint.bat', ['@echo off', 'chcp 65001 >nul', 'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装到MyPaint.ps1"', 'pause', ''].join(NL));
      mk('安装说明.txt', 'MyPaint 安装说明' + NL + '运行「安装到MyPaint.bat」，然后重启 MyPaint。' + NL + '笔刷目录：%APPDATA%/mypaint/brushes');
    } else if (target === 'kbundle') {
      mk('安装到Krita.ps1', [
        '$ErrorActionPreference = "SilentlyContinue"',
        '$dst = Join-Path $env:APPDATA "krita"',
        'if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }',
        'Get-ChildItem $PSScriptRoot -Filter *.bundle -File | Copy-Item -Destination $dst -Force',
        'Write-Host ("已复制到 " + $dst)',
        'Write-Host "重启 Krita 后，在 设置->管理资源 里应能看到；看不到就用「导入资源」手动选一次"'
      ].join(NL));
      mk('安装到Krita.bat', ['@echo off', 'chcp 65001 >nul', 'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装到Krita.ps1"', 'pause', ''].join(NL));
      mk('安装说明.txt', [
        'Krita 笔刷包安装说明',
        '方法一（一键）：运行「安装到Krita.bat」，重启 Krita',
        '方法二：Krita -> 设置 -> 管理资源 -> 导入资源 -> 选择本目录的 .bundle',
        '导入后在「画笔预设」里搜索包名即可。'
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
  /* 生成「参数对比页」HTML（原参数 vs 目标格式支持情况 + 笔尖缩略图），无需外部样本 */
  function buildCompareHtml(brushList, target, meta) {
    const NL = String.fromCharCode(10);
    const fields = [
      ['尺寸', 'sizePx', function (v) { return Math.round(v) + 'px'; }],
      ['间距', 'spacingPct', function (v) { return (Math.round(v * 10) / 10) + '%'; }],
      ['角度', 'angle', function (v) { return Math.round(v) + '°'; }],
      ['圆度', 'roundness', function (v) { return Math.round(v) + '%'; }],
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
      ['颜色动态', 'colorDynamicsOn', function () { return '开'; }],
      ['平滑', 'smoothingStrength', function (v) { return Math.round(v * 100) + '%'; }],
      ['双笔刷', 'dualOn', function () { return '开'; }]
    ];
    const support = {
      abr: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','角度随机','散布','散布数量','纹理深度','锥度','湿边','混色/涂抹','颜色动态','平滑','双笔刷'],
      bru: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','角度随机','散布','散布数量','纹理深度','锥度','湿边','混色/涂抹','颜色动态','平滑'],
      brushset: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','散布','散布数量','纹理深度','锥度','湿边','混色/涂抹','颜色动态','平滑'],
      brush: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','散布','散布数量','纹理深度','锥度','湿边','混色/涂抹','颜色动态','平滑'],
      kbundle: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','散布','纹理深度','混色/涂抹','颜色动态'],
      gbr: ['尺寸','间距','硬度'], gih: ['尺寸','间距','硬度'],
      myb: ['尺寸','间距','角度','圆度','不透明度','硬度','最小直径','最小不透明度','大小随机','散布','混色/涂抹','颜色动态'],
      painter: ['尺寸'], sai2: ['尺寸','间距'], png: ['尺寸','间距','角度','圆度','不透明度'],
      medibang: ['尺寸','间距','不透明度'], mbini: ['尺寸','间距','不透明度'],
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
    out.push('<title>参数对比 · ' + esc(target) + '</title>');
    out.push('<style>');
    out.push('body{font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:24px;color:#222;background:#fafafa}');
    out.push('h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}');
    out.push('.meta{color:#666;margin-bottom:16px}');
    out.push('.card{background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:16px;margin-bottom:16px;display:flex;gap:16px;flex-wrap:wrap}');
    out.push('.tip{width:120px;text-align:center;color:#888}.tip img{max-width:96px;max-height:96px;background:#f0f0f0;border-radius:6px}');
    out.push('table{border-collapse:collapse;flex:1;min-width:320px}');
    out.push('th,td{border:1px solid #eee;padding:5px 8px;text-align:left;font-size:13px}');
    out.push('th{background:#f7f7f7;font-weight:600}');
    out.push('.ok{color:#2a7a2a;font-weight:600}.no{color:#b03030;font-weight:600}');
    out.push('</style></head><body>');
    out.push('<h1>参数对比</h1>');
    out.push('<div class="meta">目标格式：<b>' + esc(target) + '</b> · 笔刷数：' + brushList.length + (meta && meta.fileName ? ' · 来源：' + esc(meta.fileName) : '') + '</div>');
    out.push('<div class="meta">✅ = 目标格式能保留（值按源笔刷写入）　❌ = 目标格式没有这个概念（转换后丢失）</div>');
    out.push('<div class="meta">双笔刷：ABR 目标原样保留，其它目标按笔尖合成近似</div>');
    if (MANUAL_ADVICE[target]) out.push('<div class="meta">手动补全建议：' + esc(MANUAL_ADVICE[target]) + '</div>');
    brushList.forEach(function (b, idx) {
      out.push('<div class="card">');
      out.push('<div class="tip">' + thumb(b) + '<div>' + esc(b.name || ('笔刷 ' + (idx + 1))) + '</div></div>');
      out.push('<table><tr><th>参数</th><th>原值</th><th>状态</th></tr>');
      for (const f of fields) {
        const v = b[f[1]];
        if (v === undefined || v === null || v === '' || v === 0 || v === false) continue;
        const text = f[2] ? f[2](v) : String(v);
        const ok = keep.indexOf(f[0]) >= 0;
        out.push('<tr><td>' + esc(f[0]) + '</td><td>' + esc(text) + '</td><td class="' + (ok ? 'ok' : 'no') + '">' + (ok ? '✅ 保留' : '❌ 丢失') + '</td></tr>');
      }
      out.push('</table></div>');
    });
    out.push('</body></html>');
    return out.join(NL);
  }

  const MANUAL_ADVICE = {
    abr: '纹理：先在 PS 图案面板导入配套 .pat；双笔刷：本格式原样保留，无需补',
    bru: '散布：画世界刻度更小，可用「散布换算系数」微调；双笔刷：已按笔尖合成近似',
    brushset: '双笔刷：已合成进笔尖；倾斜/速度动态 Procreate 无对应字段',
    brush: '双笔刷：已合成进笔尖；倾斜/速度动态 Procreate 无对应字段',
    kbundle: '不透明度/流量曲线：在 Krita「画笔设置」里手动调；双笔刷：已合成近似',
    gbr: '不透明度/圆度：在 GIMP 画笔选项里手动设；散布/动态：GIMP 不支持',
    gih: '不透明度/圆度：在 GIMP 管道画笔选项里手动设',
    myb: '速度/倾斜传感器：MyPaint 笔刷设置里手动勾选；双笔刷：已合成近似',
    painter: '笔尖/半径：Painter 里按 PNG/nib 手动微调；双笔刷：已合成近似',
    sai2: '完整笔刷参数在 SAI2 的 toolsettings 里，导入 BMP/INI 后手动补',
    png: '仅笔尖图 + 参数文本，需在目标软件里手动建笔刷',
    medibang: '位图笔刷导入后可在 MediBang 里调间距/压感',
    mbini: '复制到 CloudAlpaca 后重启；程序笔刷已转成位图笔刷',
    gobrush: '压力曲线按模板写入，可在天生会画里手动调曲线',
    gopaint_set: '压力曲线按模板写入，可在天生会画里手动调曲线',
    gopaint_abr: '文本参数有限，需在目标软件里补全'
  };

  function brushLossReport(brushList, targets) {
    const NL = String.fromCharCode(10);
    const fields = [
      ['尺寸', 'sizePx', function (v) { return Math.round(v) + 'px'; }],
      ['间距', 'spacingPct', function (v) { return (Math.round(v * 10) / 10) + '%'; }],
      ['角度', 'angle', function (v) { return Math.round(v) + '°'; }],
      ['圆度', 'roundness', function (v) { return Math.round(v) + '%'; }],
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
      ['颜色动态', 'colorDynamicsOn', function () { return '开'; }],
      ['平滑', 'smoothingStrength', function (v) { return Math.round(v * 100) + '%'; }],
      ['双笔刷', 'dualOn', function () { return '开'; }]
    ];
    const support = {
      abr: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','角度随机','散布','散布数量','纹理','压感尺寸','压感不透明度','湿边','平滑'],
      bru: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','角度随机','散布','散布数量','纹理','压感尺寸','压感不透明度','锥度','湿边','混色/涂抹','颜色动态','平滑'],
      brushset: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','散布','散布数量','纹理','压感尺寸','压感不透明度','锥度','湿边','混色/涂抹','颜色动态','平滑'],
      brush: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','大小随机','散布','散布数量','纹理','压感尺寸','压感不透明度','锥度','湿边','混色/涂抹','颜色动态','平滑'],
      kbundle: ['尺寸','间距','角度','圆度','不透明度','流量','硬度','最小直径','最小不透明度','散布','纹理','压感尺寸','压感不透明度','混色/涂抹','颜色动态'],
      gbr: ['尺寸','间距','硬度'], gih: ['尺寸','间距','硬度'],
      myb: ['尺寸','间距','角度','圆度','不透明度','硬度','最小直径','最小不透明度','大小随机','散布','压感尺寸','混色/涂抹','颜色动态'],
      painter: ['尺寸'], sai2: ['尺寸','间距'], png: ['尺寸','间距','角度','圆度','不透明度'],
      medibang: ['尺寸','间距','不透明度'], mbini: ['尺寸','间距','不透明度'],
      gobrush: ['尺寸','间距','不透明度','最小直径','最小不透明度','流量','散布','纹理'],
      gopaint_set: ['尺寸','间距','不透明度','散布','纹理'], gopaint_abr: ['尺寸','间距','不透明度','纹理']
    };
    const reason = {
      abr: 'ABR 支持这些；纹理需配合 .pat 图案（目标 PS 里要有同名图案）',
      bru: '画世界Pro 字段最多，基本都能写',
      brushset: 'Procreate 支持这些；倾斜/速度/釉化等无对应字段',
      brush: 'Procreate 支持这些；倾斜/速度/釉化等无对应字段',
      kbundle: 'Krita 6 元组曲线/颜色率未映射',
      gbr: 'GIMP 格式只有「笔尖 + 间距 + 硬度」',
      gih: 'GIMP 管道格式只有「笔尖 + 间距 + 硬度」',
      myb: 'MyPaint 传感器有限，速度/倾斜未映射',
      painter: 'Painter 笔刷格式只写了笔尖',
      sai2: 'SAI2 只写了尺寸与间距',
      png: 'PNG 只导出笔尖图 + 参数文本',
      medibang: 'MediBang 只写基础字段', mbini: 'MediBang 云笔刷只写基础字段',
      gobrush: '天生会画写了主要数值参数，压力曲线仍为模板',
      gopaint_set: '天生会画组写了主要数值参数',
      gopaint_abr: '天生会画 ABR 只写基础参数'
    };
    const lines = [];
    lines.push('转换差异报告（参数级，自动生成）');
    lines.push('========================================');
    lines.push('格式：保留（含值） / 丢失（目标格式没有该参数）');
    lines.push('说明：双笔刷只在 ABR 目标原样保留；其它目标会把第二支笔尖合成进笔尖（近似效果）');
    lines.push('');
    for (const target of targets) {
      const keep = support[target] || [];
      lines.push('【目标格式：' + target + '】');
      if (reason[target]) lines.push('  说明：' + reason[target]);
      let lostTotal = 0, keptTotal = 0;
      brushList.forEach(function (b, i) {
        const has = [], lost = [];
        for (const f of fields) {
          const v = b[f[1]];
          const present = v !== undefined && v !== null && v !== '' && v !== 0 && v !== false;
          if (!present) continue;
          const text = f[2] ? f[2](v) : String(v);
          if (keep.indexOf(f[0]) >= 0) { has.push(f[0] + '(' + text + ')'); keptTotal++; }
          else { lost.push(f[0] + '(' + text + ')'); lostTotal++; }
        }
        lines.push('  ' + (i + 1) + '. ' + (b.name || '未命名'));
        lines.push('     保留：' + (has.length ? has.join('、') : '（基础字段）'));
        if (lost.length) lines.push('     丢失：' + lost.join('、'));
      });
      lines.push('  小结：保留参数 ' + keptTotal + ' 项，丢失 ' + lostTotal + ' 项');
      if (MANUAL_ADVICE[target]) lines.push('  手动补全建议：' + MANUAL_ADVICE[target]);
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
      let base = sanitizeName(b.name, i);
      let name = base, k = 2;
      while (used.has(name.toLowerCase())) { name = base + ' (' + k + ')'; k++; }
      used.set(name.toLowerCase(), 1);
      entries.push({ name: name + '_笔尖.png', data: made.bytes });
    });
    const lines = [
      '笔尖/素材 PNG 导出（v2.4）',
      '============================',
      '这些 PNG 是笔尖形状图（白底+透明度），可直接导入：',
      '  · MediBang Paint：素材/画笔 → 用图片新建自定义笔刷',
      '  · Infinite Painter：笔刷库 → 创建 → 以图片创建笔刷',
      '尺寸 = 原笔刷设置的像素尺寸；间距/压感请在 App 内手动设置（文件里不带）。'
    ];
    entries.push({ name: '说明.txt', data: util.utf8Encode(lines.join('\n')) });
    entries.push({ name: '笔刷参数.txt', data: util.utf8Encode(brushParamText(brushList)) });
    entries.push({ name: '笔刷参数.json', data: util.utf8Encode(JSON.stringify(brushList.map(function (b) {
      const info = brushParamInfo(b); const obj = {}; for (const k in info) obj[k] = info[k] === '' ? null : info[k]; return obj;
    }), null, 2)) });
    return { bytes: zipMod.write(entries), count: brushList.length };
  }

  /** Brush list -> Krita resource bundle (.bundle) with GBR tips + presets. */
  function makeKritaBundle(brushList, opts) {
    const list = (brushList || []).map(function (b) {
      if (!(b.dualOn && b.dualTip)) return b;
      const tip = bakedTipFor(b, opts);
      return Object.assign({}, b, { tip: { w: tip.w, h: tip.h, rgba: tip.rgba } });
    });
    return krita.writeBundle(list, opts || {});
  }

  /** Brush list -> SAI2 scatter brush files (bmp + ini), zipped. */
  function makeSai2Pack(brushList, opts) {
    const list = (brushList || []).map(function (b) {
      try {
        const tip = bakedTipFor(b, opts || {});
        return Object.assign({}, b, { tip: { w: tip.w, h: tip.h, rgba: tip.rgba } });
      } catch (e) { return b; }
    });
    return sai2.makeSai2Pack(list, opts || {});
  }

  function makeGoPaintAbr(brushList, opts) {
    return makeAbrPack(brushList, opts || {});
  }

  /** 天生会画（GoPaint）原生 .gobrush：zip(info.json + 10x10 shape/grain + brush_<uuid>.info + 快照) */
  function makeGoPaintBrush(brush, opts) {
    opts = opts || {};
    // 还原优先：源就是 .gobrush 时原样输出
    if (opts.fidelity !== false && brush._rawGobrush && brush._rawGobrush.length) {
      return { bytes: new Uint8Array(brush._rawGobrush), count: 1, passthrough: true };
    }
    let b2 = brush;
    if (brush.dualOn && brush.dualTip) {
      const tip = bakedTipFor(brush, opts);
      b2 = Object.assign({}, brush, { tip: { w: tip.w, h: tip.h, rgba: tip.rgba } });
    }
    const made = gobrushWrite.makeGobrush(b2, opts || {});
    const name = sanitizeName((brush.name || 'brush'), 0) || 'brush';
    return { bytes: made.bytes, fileName: name + '.gobrush', count: 1 };
  }

  /** 整个笔刷集 -> 单个 .gobrushes 文件（GoPaint 原生笔刷组） */
  function makeGoPaintGroup(brushList, opts) {
    opts = opts || {};
    // 还原优先：整组来自同一个 .gobrushes 时原样输出
    if (opts.fidelity !== false && brushList.length && brushList.every(function (b) { return b._rawGobrush; })) {
      const ref = brushList[0]._rawGobrush;
      const same = brushList.every(function (b) { return b._rawGobrush === ref || (b._rawGobrush.length === ref.length && (function () { for (let i = 0; i < ref.length; i++) if (b._rawGobrush[i] !== ref[i]) return false; return true; })()); });
      if (same) return { bytes: new Uint8Array(ref), count: brushList.length, passthrough: true };
    }
    const made = gobrushWrite.makeGobrushes(brushList, opts || {});
    const name = sanitizeName((opts && opts.groupName) || '笔刷组', 0) || '笔刷组';
    return { bytes: made.bytes, fileName: name + '.gobrushes', count: made.count };
  }

  /** 整个笔刷集 -> 多个 .gobrush 文件（GoPaint 原生格式） */
  function makeGoPaintSet(brushList, opts) {
    const files = [];
    for (const b of brushList) {
      const made = makeGoPaintBrush(b, opts);
      files.push({ name: made.fileName, data: made.bytes });
    }
    return { files: files, count: files.length };
  }

  function uniqueNames(brushes) {
    const seen = new Map();
    return brushes.map((b, i) => {
      let base = sanitizeName(b.name, i);
      let n = base;
      let k = 2;
      while (seen.has(n)) { n = base + ' (' + k + ')'; k++; }
      seen.set(n, 1);
      return n;
    });
  }

  const api = { detect, parseFile, expandArchive, synthTip, makeBru, makeBruPack, makeAbrPack, makeAbrPassthrough, makePatternFile, makeTexturePng, textureGray, textureKey, grainNoise, bakeGrainIntoRGBA, bakeTextureIntoRGBA, makeInstallScripts, brushLossReport, buildCompareHtml, brushParamInfo, brushParamText, parseFileAsync, makeProcreateBrush, makeProcreateBrushset, makeGbr, makeMyb, makeGih, makePainter, makeMdp, makeMediBangBrush, makeMediBangIniPack, makeIpcfg, makePrbr, makeGoPaintAbr, makeGoPaintBrush, makeGoPaintSet, makeGoPaintGroup, makeSai2Pack, makeKritaBundle, makeTipPng, makeTipPngPack, tipToRGBA, bakeTipTransform, sanitizeName, uniqueNames, extLabel };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { convert: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);

