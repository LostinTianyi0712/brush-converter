/* Adobe ABR (Photoshop brush) parser -> normalized brushes */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  function req(p) { return require(p); }
  const util = isNode ? req('./util.js') : root.BC.util;
  const desc = isNode ? req('./descriptor.js') : root.BC.descriptor;
  const uuidPool = isNode ? req('./abrUuidPool.js') : (root.BC.abrUuidPool || { list: [] });
  const patternTpl = isNode ? req('./abrPatternTemplate.js') : (root.BC.abrPatternTemplate || null);

  function isAbr(bytes) {
    if (bytes.length < 8) return false;
    if (util.ascii(bytes, 0, 4) === '8BPS') return true;
    const major = util.u16(bytes, 0);
    if (major === 1 || major === 2) return true; // legacy entry stream (no 8BPS / no 8BIM)
    return [6, 7, 9, 10].indexOf(major) >= 0 && util.ascii(bytes, 4, 4) === '8BIM';
  }

  function packbitsDecode(row, out, maxOut) {
    let i = 0;
    while (i < row.length && out.length < maxOut) {
      const n = (row[i] << 24) >> 24; i++;
      if (n >= 0) {
        const count = n + 1;
        for (let k = 0; k < count && i < row.length && out.length < maxOut; k++) out.push(row[i++]);
      } else if (n !== -128) {
        const count = 1 - n;
        const val = row[i++];
        for (let k = 0; k < count && out.length < maxOut; k++) out.push(val);
      }
    }
  }

  function decodeBitmap(pixels, header) {
    const w = header.width, h = header.height, bpp = header.depth === 16 ? 2 : 1;
    const need = w * h * bpp;
    if (header.compression === 0) {
      const data = pixels.subarray(0, need);
      return { w, h, bpp, data: data.length === need ? data : null };
    }
    // RLE: h * 2-byte row counts, then PackBits rows
    const countsLen = h * 2;
    if (pixels.length < countsLen) return null;
    const out = new Uint8Array(need);
    let produced = 0;
    let pos = countsLen;
    for (let row = 0; row < h; row++) {
      const cnt = (pixels[row * 2] << 8) | pixels[row * 2 + 1];
      if (pos + cnt > pixels.length) return null;
      const rowData = pixels.subarray(pos, pos + cnt);
      pos += cnt;
      const rowOut = [];
      packbitsDecode(rowData, rowOut, w * bpp);
      if (rowOut.length !== w * bpp) return null;
      out.set(rowOut, row * w * bpp);
      produced++;
    }
    return { w, h, bpp, data: out };
  }

  function findHeader(body, documented) {
    function at(off) {
      if (off + 19 > body.length) return null;
      const top = util.i32(body, off), left = util.i32(body, off + 4),
        bottom = util.i32(body, off + 8), right = util.i32(body, off + 12);
      const depth = util.u16(body, off + 16), compression = body[off + 18];
      const w = right - left, h = bottom - top;
      if (depth !== 8 && depth !== 16) return null;
      if (compression > 2) return null;
      if (w <= 0 || h <= 0 || w > 8192 || h > 8192) return null;
      if (Math.abs(top) > 65000 || Math.abs(left) > 65000) return null;
      return { top, left, bottom, right, depth, compression, width: w, height: h, offset: off };
    }
    if (documented !== undefined) {
      const h = at(documented);
      if (h) return h;
    }
    for (let k = 0; k + 19 <= body.length && k < 2048; k++) {
      // quick reject: depth byte must be 8 or 16 right before compression
      const comp = body[k + 18];
      if (comp > 2) continue;
      const h = at(k);
      if (h) return h;
    }
    return null;
  }

  function extractUuid(body) {
    if (body.length >= 38 && body[0] === 0x24 /* $ */) {
      const s = util.ascii(body, 1, 36);
      if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)) return s.toLowerCase();
    }
    return null;
  }

  function parseSampEntryBody(body, documented) {
    const uuid = extractUuid(body);
    const header = findHeader(body, documented);
    let tip = null;
    if (header && header.compression !== 2) {
      const decoded = decodeBitmap(body.subarray(header.offset + 19), header);
      if (decoded && decoded.data) tip = decoded;
    }
    return { uuid, tip, header, body };
  }

  function sampDocumentedOffset(version, subversion) {
    return (version === 6 && subversion === 1) ? 47 : 301;
  }

  function parseSampBlock(data, version, subversion) {
    const documented = sampDocumentedOffset(version, subversion);
    const entries = [];
    let at = 0;
    while (at + 4 <= data.length) {
      const len = util.u32(data, at);
      if (len === 0 || at + 4 + len > data.length) break;
      entries.push(parseSampEntryBody(data.subarray(at + 4, at + 4 + len), documented));
      at = (at + 4 + len + 3) & ~3;
    }
    return entries;
  }

  /* 大文件解析：在读取采样条目之间让出主线程，可显示进度/避免界面长时间无响应 */
  async function parseAsync(bytes, opts) {
    opts = opts || {};
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    const version = util.u16(bytes, 0), subversion = util.u16(bytes, 2);
    if (!(version >= 1)) return parse(bytes);
    let start = 4;
    if (util.ascii(bytes, 0, 4) === '8BPS') start = 4 + 26 + 4 + 4 + 4 + 4;
    const blocks = readBlocks(bytes, start);
    const sampBlk = blocks.find(function (b) { return b.type === 'samp'; });
    if (!sampBlk) return parse(bytes);
    const data = sampBlk.data;
    const documented = sampDocumentedOffset(version, subversion);
    // 先统计条目数（只读长度字段，很快）
    let total = 0, at = 0;
    while (at + 4 <= data.length) {
      const len = util.u32(data, at);
      if (len === 0 || at + 4 + len > data.length) break;
      total++;
      at = (at + 4 + len + 3) & ~3;
    }
    const entries = [];
    at = 0;
    let i = 0;
    const sleep = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
    while (at + 4 <= data.length) {
      const len = util.u32(data, at);
      if (len === 0 || at + 4 + len > data.length) break;
      entries.push(parseSampEntryBody(data.subarray(at + 4, at + 4 + len), documented));
      at = (at + 4 + len + 3) & ~3;
      i++;
      if (i % 8 === 0 || i === total) {
        onProgress(total ? i / total : 1, '解析采样 ' + i + '/' + total);
        await sleep();
      }
    }
    const result = parse(bytes, { sampEntries: entries });
    onProgress(1, '解析完成');
    return result;
  }

  function legacyParse(bytes, count, startPos, legacyVersion) {
    const r = new util.Reader(bytes, startPos);
    const brushes = [];
    for (let i = 0; i < count; i++) {
      if (r.left() < 6) break;
      const brushType = r.u16();
      if (brushType !== 2) {
        if (r.left() < 4) break;
        const len = r.u32();
        r.skip(len);
        continue;
      }
      const entryLen = r.u32();
      const entryEnd = r.p + entryLen;
      try {
        r.u32(); r.u16();
        let name = '';
        if (legacyVersion === 2) {
          const charCount = r.u32();
          if (charCount > 0 && charCount < 4096) {
            let s = '';
            for (let k = 0; k < charCount; k++) {
              const cu = r.u16();
              if (cu !== 0) s += String.fromCharCode(cu);
            }
            name = s;
          }
        }
        r.u8();
        for (let k = 0; k < 4; k++) r.i16();
        const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
        const depth = r.u16();
        const compression = r.u8();
        const w = right - left, h = bottom - top;
        const bpp = depth === 16 ? 2 : 1;
        if (w <= 0 || h <= 0 || w > 8192 || h > 8192) { r.seek(entryEnd); continue; }
        let pixelData;
        if (compression === 0) pixelData = r.bytes(w * h * bpp);
        else {
          const rest = bytes.subarray(r.p, Math.min(entryEnd, bytes.length));
          const header = { width: w, height: h, depth, compression };
          const dec = decodeBitmap(rest, header);
          if (dec) pixelData = dec.data;
          r.seek(entryEnd);
        }
        if (pixelData) {
          brushes.push({
            name,
            tip: { w, h, bpp, data: pixelData },
            sizePx: Math.max(w, h),
            spacingPct: 25,
            angle: 0,
            roundness: 100,
            pressureSize: true,
            pressure: true,
            minSizeRatio: 0.1,
            pressureOpacity: false,
            minOpacityRatio: 1
          });
        }
      } catch (e) { r.seek(entryEnd); }
      r.seek(entryEnd);
    }
    return brushes;
  }

  function readBlocks(bytes, start) {
    const blocks = [];
    let p = start;
    while (p + 12 <= bytes.length) {
      const sig = util.ascii(bytes, p, 4);
      if (sig !== '8BIM') break;
      const type = util.ascii(bytes, p + 4, 4);
      const len = util.u32(bytes, p + 8);
      if (p + 12 + len > bytes.length) {
        blocks.push({ type, data: bytes.subarray(p + 12) });
        break;
      }
      blocks.push({ type, data: bytes.subarray(p + 12, p + 12 + len) });
      // 8BIM 块按偶数长度对齐（真实 PS 文件里奇数长度块后有 1 字节 pad）；
      // 不对齐会导致奇数长度 desc 之后的块（如 phry 分组）被静默丢弃
      p += 12 + len + (len & 1);
    }
    return blocks;
  }

  function parse(bytes, preOpts) {
    if (!isAbr(bytes)) throw new Error('不是有效的 ABR 文件');
    const warnings = [];
    let start, version, subversion;
    if (util.ascii(bytes, 0, 4) === '8BPS') {
      version = util.u16(bytes, 4); subversion = util.u16(bytes, 6); start = 8;
    } else {
      version = util.u16(bytes, 0); subversion = util.u16(bytes, 2); start = 4;
    }
    if (version === 1 || version === 2) {
      const brushes = legacyParse(bytes, subversion, start, version);
      return { version, brushes, warnings };
    }
    const blocks = readBlocks(bytes, start);
    let sampEntries = [];
    let descBlockData = null;
    let pattBlockData = null;
    const presets = [];
    for (const blk of blocks) {
      if (blk.type === 'samp') {
        if (preOpts && preOpts.sampEntries && !sampEntries.length) {
          sampEntries = preOpts.sampEntries;
        } else {
          sampEntries = sampEntries.concat(parseSampBlock(blk.data, version, subversion));
        }
      } else if (blk.type === 'patt') {
        if (blk.data && blk.data.length) pattBlockData = blk.data;
      } else if (blk.type === 'desc') {
        try {
          descBlockData = blk.data;
          const parsed = desc.parseDescBlock(blk.data);
          const brsh = desc.getItem(parsed.root, 'Brsh');
          if (brsh && brsh.type === 'list') {
            for (const el of brsh.items) {
              if (el && el.type === 'descriptor') presets.push(el);
            }
          }
        } catch (e) {
          warnings.push('描述信息解析失败: ' + e.message);
        }
      }
    }
    // phry(hierarchy)：Grup{Nm} / preset{} / groupEnd{} 扁平 token 流，preset 按位置对应 desc 预设
    const presetGroups = [];
    for (const blk of blocks) {
      if (blk.type !== 'phry') continue;
      try {
        const pr = desc.parseDescBlock(blk.data);
        const h = desc.getItem(pr.root, 'hierarchy');
        if (h && h.type === 'list') {
          let cur = null, idx = 0;
          for (const el of h.items) {
            if (!el || el.type !== 'descriptor') continue;
            const cls = el.classId;
            if (cls === 'Grup') cur = desc.getItem(el, 'Nm  ') || '';
            else if (cls === 'preset') presetGroups[idx++] = cur || undefined;
            else if (cls === 'groupEnd') cur = null;
          }
        }
      } catch (e) { warnings.push('分组信息解析失败: ' + e.message); }
    }
    const tipByUuid = new Map();
    for (const en of sampEntries) {
      if (!en.uuid || !en.tip) continue;
      const k = en.uuid.toLowerCase();
      // 多个预设可能引用同一个样本（uuid 重复）：按 uuid 单条绑定，重复引用复用同一条
      if (!tipByUuid.has(k)) tipByUuid.set(k, en);
    }

    const brushes = [];
    const usedTips = new Set();
    let computedCount = 0;
    function toBrush(preset, tip) {
      const inner = desc.getItem(preset, 'Brsh');
      let diameter = desc.unitValue(desc.getItem(inner, 'Dmtr'));
      const spacing = desc.unitValue(desc.getItem(inner, 'Spcn'));
      const angle = desc.unitValue(desc.getItem(inner, 'Angl')) || 0;
      const roundness = desc.unitValue(desc.getItem(inner, 'Rndn'));
      const useTipDynamics = desc.getItem(preset, 'useTipDynamics');
      const szVr = desc.getItem(preset, 'szVr');
      const opVr = desc.getItem(preset, 'opVr');
      const minDiam = desc.unitValue(desc.getItem(preset, 'minimumDiameter'));
      const minRound = desc.unitValue(desc.getItem(preset, 'minimumRoundness'));
      const flipX = desc.getItem(preset, 'flipX');
      const flipY = desc.getItem(preset, 'flipY');
      const useScatter = desc.getItem(preset, 'useScatter');
      const cntRaw = desc.getItem(preset, 'Cnt ');
      const bothAxes = desc.getItem(preset, 'bothAxes');
      const angleVr = desc.getItem(preset, 'angleDynamics');
      const scatterVr = desc.getItem(preset, 'scatterDynamics');
      const dual = desc.getItem(preset, 'dualBrush');
      const dualInfo = (function (d) {
        if (!d || !d.items) return null;
        const on = desc.getItem(d, 'useDualBrush') === true;
        const br = desc.getItem(d, 'Brsh');
        const bl = desc.getItem(d, 'BlnM');
        return {
          enabled: on,
          blend: bl && bl.value ? bl.value : (bl && bl.type === 'enum' ? bl.value : undefined),
          diameter: br ? desc.unitValue(desc.getItem(br, 'Dmtr')) : undefined,
          spacing: br ? desc.unitValue(desc.getItem(br, 'Spcn')) : undefined,
          name: br ? (desc.getItem(br, 'Nm  ') || '') : '',
          uuid: br ? (desc.getItem(br, 'sampledData') || '') : ''
        };
      })(dual);
      const useTexture = desc.getItem(preset, 'useTexture');
      const txtrRef = desc.getItem(preset, 'Txtr');
      const texDepth = desc.unitValue(desc.getItem(preset, 'textureDepth'));
      const texScale = desc.unitValue(desc.getItem(preset, 'textureScale'));
      const tiltVr = desc.getItem(preset, 'ttlVr');
      const roundVr = desc.getItem(preset, 'roundnessDynamics');
      const jitterOf = (v) => {
        const j = v && desc.getItem(v, 'jitter');
        return j && j.type === 'unit' ? j.value : 0;
      };
      let controlSize = null, controlOpacity = null;
      function readControl(v) {
        if (!v || v.type !== 'descriptor') return null;
        // 2 = Pen Pressure (Photoshop brVr control enum)
        let c = desc.getItem(v, 'bVTy');
        if (c === undefined) c = desc.getItem(v, 'control');
        if (typeof c === 'number') return c;
        if (c && c.type === 'enum') {
          if (c.value === 'Prs ' || c.value === 'Prs') return 2;
          return c.value;
        }
        return null;
      }
      if (useTipDynamics) {
        controlSize = readControl(szVr);
        controlOpacity = readControl(opVr);
      }
      const name = desc.getItem(preset, 'Nm  ') || '';
      if (!diameter && tip) diameter = Math.max(tip.w, tip.h);
      const pressureSize = !!(useTipDynamics && controlSize === 2);
      const pressureOpacity = !!(useTipDynamics && controlOpacity === 2);
      return {
        name: typeof name === 'string' ? name : '',
        uuid: tip && tip.uuid ? tip.uuid : undefined,
        tip: tip ? tip.tip : null,
        sizePx: diameter || (tip ? Math.max(tip.w, tip.h) : 100),
        spacingPct: spacing === undefined ? 25 : spacing,
        angle: angle || 0,
        roundness: roundness === undefined ? 100 : roundness,
        minSizeRatio: pressureSize ? Math.max(0.02, (minDiam === undefined ? 10 : minDiam) / 100) : 1,
        pressureSize,
        pressureOpacity,
        pressure: pressureSize || pressureOpacity,
        minOpacityRatio: pressureOpacity ? 0.25 : 1,
        flipX: !!(flipX === true || (inner && desc.getItem(inner, 'flipX') === true)),
        flipY: !!(flipY === true || (inner && desc.getItem(inner, 'flipY') === true)),
        hasTexture: useTexture === true,
        textureDepth: texDepth === undefined ? undefined : texDepth / 100,
        textureScale: texScale === undefined ? undefined : texScale / 100,
        textureName: txtrRef && desc.getItem(txtrRef, 'Nm  ') ? String(desc.getItem(txtrRef, 'Nm  ')).replace(/^.*=/, '') : undefined,
        dualBrush: dualInfo,
        scatterOn: useScatter === true,
        scatterCount: typeof cntRaw === 'number' ? cntRaw : 1,
        scatterBothAxes: bothAxes === true,
        scatterPct: jitterOf(scatterVr),
        angleJitterDeg: jitterOf(angleVr),
        sizeJitterPct: jitterOf(szVr),
        tiltJitterPct: jitterOf(tiltVr),
        roundnessJitterPct: jitterOf(roundVr),
        source: 'abr'
      };
    }

    if (presets.length) {
      for (let pi = 0; pi < presets.length; pi++) {
        const preset = presets[pi];
        const uuidVal = desc.getItem(preset, 'sampledData');
        const inner = desc.getItem(preset, 'Brsh');
        const uuid2 = desc.getItem(inner, 'sampledData');
        let uuid = typeof uuidVal === 'string' ? uuidVal :
          (uuid2 && typeof uuid2 === 'string' ? uuid2 : (uuidVal && uuidVal.items && uuidVal.items[0]) || null);
        // 多支预设可能共享同一个采样（源文件里 uuid 重复出现），按出现顺序消费
        let tipEntry = uuid ? tipByUuid.get(uuid.toLowerCase()) : null;
        if (!tipEntry) tipEntry = null;
        const tipUuid = (tipEntry && tipEntry.uuid) || uuid;
        if (!tipEntry) {
          // computed (parametric) brush: no sampled bitmap -> keep it and let the
          // converter synthesize a tip from the descriptor parameters.
          const innerInfo = desc.getItem(preset, 'Brsh');
          const cls = (innerInfo && (innerInfo.className || innerInfo.classname)) || '';
          const brush = toBrush(preset, null);
          brush.computed = true;
          brush.className = cls;
          brush.tipStyle = 'auto';
          computedCount++;
          brushes.push(brush);
          continue;
        }
        usedTips.add(tipUuid ? tipUuid.toLowerCase() : '');
        const brush = toBrush(preset, tipEntry);
        if (presetGroups[pi]) brush.group = presetGroups[pi];
        // 保留原始描述符/样本字节：部分导出（只选几支）时可以原样搬过去，
        // 从而完整保留 dualBrush / texture / scatter / dynamics / 分组等 PS 专属参数
        try {
          if (preset && preset._span && descBlockData) {
            brush._rawPreset = descBlockData.subarray(preset._span[0], preset._span[1]);
          }
          if (tipEntry && tipEntry.body) brush._rawSample = tipEntry.body;
        } catch (e) { /* 保留失败不影响正常转换 */ }
        if (pattBlockData) brush._pattBlock = pattBlockData;
        brushes.push(brush);
      }
      // presets missing but tips have names? synthesize
      if (!brushes.length) {
        warnings.push('ABR 中没有可直接转换的采样笔尖（可能是参数化笔刷）');
      }
    }
    // 供“部分导出”使用：保留源文件全部采样，避免 dualBrush 的第二个采样引用悬空
    const allRawSamples = sampEntries.map(function (en) { return en.body; }).filter(Boolean);
    brushes.forEach(function (b) { b._allRawSamples = allRawSamples; });
    if (!brushes.length) {
      for (const en of sampEntries) {
        if (!en.tip) continue;
        brushes.push({
          name: '',
          tip: en.tip,
          sizePx: Math.max(en.tip.w, en.tip.h),
          spacingPct: 25,
          angle: 0,
          roundness: 100,
          minSizeRatio: 0.1,
          pressureSize: true,
          pressureOpacity: false,
          pressure: true,
          minOpacityRatio: 1,
          source: 'abr'
        });
      }
    }
    // warn about unused tips
    let skippedTips = 0;
    for (const en of sampEntries) if (en.tip && (!en.uuid || !usedTips.has(en.uuid))) skippedTips++;
    if (skippedTips > 0 && brushes.length) warnings.push(skippedTips + ' 个未使用的笔尖已忽略');
    if (computedCount > 0) warnings.push(computedCount + ' 个参数化(computed)笔刷没有采样笔尖，已按参数生成程序化笔尖');
    if (!brushes.length) throw new Error('ABR 中未找到可用的笔刷');
    return { version, brushes, warnings };
  }

  /* ---------------- legacy ABR v2 writer ----------------
     Photoshop / GIMP / Krita / 画世界Pro 都支持的旧版 ABR (Version2):
       u16 version=2, u16 count
       per brush: u16 type=2, u32 bodyLen, body {
           u32 0, u16 0, u32 nameCharCount, UTF-16BE name (+NUL),
           u8 0, 4xi16 0,
           i32 top=0,left=0,bottom=h,right=w, u16 depth=8, u8 compression=0,
           raw 8-bit grayscale mask (w*h)
       } */
  function maskFromRGBA(rgba) {
    const out = new Uint8Array((rgba.length / 4) | 0);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j++) out[j] = rgba[i + 3];
    return out;
  }

  function utf16be(str) {
    const out = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      out[i * 2] = c >> 8;
      out[i * 2 + 1] = c & 0xff;
    }
    return out;
  }

  /** Write a legacy (v2) ABR containing every item: [{ name, w, h, gray }] */
  function writeAbr(items) {
    if (!items || !items.length) throw new Error('没有可写入 ABR 的笔刷');
    const parts = [];
    let count = 0;
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const w = it.w | 0, h = it.h | 0, gray = it.gray;
      if (!w || !h || !gray || gray.length !== w * h) continue;
      const name = String(it.name || '').slice(0, 200);
      const body = [];
      body.push(new Uint8Array(4)); // u32 0
      body.push(new Uint8Array(2)); // u16 0
      const chars = name.length + 1; // include NUL
      const cnt = new Uint8Array(4);
      new DataView(cnt.buffer).setUint32(0, chars, false);
      body.push(cnt);
      body.push(utf16be(name + String.fromCharCode(0)));
      body.push(new Uint8Array([0]));
      body.push(new Uint8Array(8)); // 4 x i16
      const rect = new Uint8Array(16);
      const rv = new DataView(rect.buffer);
      rv.setInt32(0, 0, false);
      rv.setInt32(4, 0, false);
      rv.setInt32(8, h, false);
      rv.setInt32(12, w, false);
      body.push(rect);
      body.push(new Uint8Array([0, 8, 0])); // depth=8, compression=0
      body.push(gray);
      const bodyBuf = util.concat(body);
      const head = new Uint8Array(6);
      const hv = new DataView(head.buffer);
      hv.setUint16(0, 2, false); // brush type 2 = sampled
      hv.setUint32(2, bodyBuf.length, false);
      parts.push(head, bodyBuf);
      count++;
    }
    if (!count) throw new Error('没有有效的笔尖像素');
    const fileHead = new Uint8Array(4);
    const fv = new DataView(fileHead.buffer);
    fv.setUint16(0, 2, false); // version 2
    fv.setUint16(2, count, false);
    return util.concat([fileHead].concat(parts));
  }

  /* ---------------- modern ABR v6 writer ----------------
     Layout (reverse-engineered from real files + Krita's reader):
       u16 major=6, u16 subversion=2
       '8BIM' 'samp' len  data: per brush { u32 bodyLen (padded to 4),
            body: '$' + uuid36 + 0x00 + 263 zero bytes,
                  rect(top,left,bottom,right) i32x4, depth u16=8, compression u8=0,
                  raw grayscale pixels }
       '8BIM' 'patt' len 0
       '8BIM' 'desc' len  data: Photoshop Action Descriptor with brush presets
           (name / diameter / spacing / angle / roundness / sampledData uuid)
     Only the tip bitmap + preset parameters are written; dynamics are not. */
  function _u32be(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, false);
    return b;
  }
  function _i32be(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n | 0, false);
    return b;
  }
  function _u16be(n) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n & 0xffff, false);
    return b;
  }
  function _f64be(n) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, n, false);
    return b;
  }
  function _ascii4(s) {
    const b = new Uint8Array(4);
    for (let i = 0; i < 4; i++) b[i] = s.charCodeAt(i) || 0x20;
    return b;
  }
  function _descUnicode(s) {
    s = String(s == null ? '' : s);
    const parts = [_u32be(s.length + 1)];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      parts.push(new Uint8Array([c >> 8, c & 0xff]));
    }
    parts.push(new Uint8Array(2));
    return util.concat(parts);
  }
  function _descId(s) {
    if (s.length === 4) return util.concat([_u32be(0), _ascii4(s)]);
    return util.concat([_u32be(s.length), util.utf8Encode(s)]);
  }
  function _descItem(key, tag, valueBytes) {
    return util.concat([_descId(key), _ascii4(tag), valueBytes]);
  }
  function _descUntF(unit, value) {
    return util.concat([_ascii4(unit), _f64be(value)]);
  }
  function _descObjc(className, classId, items) {
    const parts = [_descUnicode(className), _descId(classId), _u32be(items.length)];
    for (const it of items) parts.push(it);
    return util.concat(parts);
  }
  function _descBool(v) { return new Uint8Array([v ? 1 : 0]); }
  function _descText(s) { return _descUnicode(s); }
  function _doube(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, false);
    return b;
  }

  function _descEnum(typeId, valueId) {
    return util.concat([_descId(typeId), _descId(valueId)]);
  }

  let _uuidCounter = 0;

  function _makeUuid() {
    // 必须使用 PS 已知的 brush-id（实测随机 uuid / 递增 uuid 都会让 PS 忽略采样笔尖，
    // 预览退回计算画笔、画出来是方块）。池子取自 Photoshop 自己导出的 ABR。
    const list = uuidPool.list || [];
    if (!list.length) return 'ced5f69b-b7b9-11da-bd31-b69727a98ef7';
    const id = list[_uuidCounter % list.length];
    _uuidCounter++;
    return id;
  }

  /**
   * Write a modern (v6) ABR. items: [{name, w, h, gray, sizePx, spacingPct, angle, roundness}]
   */
  function packbitsEncode(bytes) {
    const out = [];
    let i = 0;
    while (i < bytes.length) {
      let run = 1;
      while (i + run < bytes.length && run < 128 && bytes[i + run] === bytes[i]) run++;
      if (run >= 3) {
        out.push(257 - run, bytes[i]);
        i += run;
      } else {
        let lit = 1;
        while (i + lit < bytes.length && lit < 128 &&
               !(i + lit + 2 < bytes.length && bytes[i + lit] === bytes[i + lit + 1] && bytes[i + lit] === bytes[i + lit + 2])) lit++;
        out.push(lit - 1);
        for (let k = 0; k < lit; k++) out.push(bytes[i + k]);
        i += lit;
      }
    }
    return out;
  }

  /* Photoshop RLE sample: h * u16be row byte counts, then PackBits rows */
  function rleEncode(gray, w, h) {
    const rows = [], counts = new Uint8Array(h * 2);
    for (let y = 0; y < h; y++) {
      const row = packbitsEncode(gray.subarray(y * w, (y + 1) * w));
      counts[y * 2] = (row.length >> 8) & 0xff;
      counts[y * 2 + 1] = row.length & 0xff;
      rows.push(row);
    }
    let total = counts.length;
    for (const r of rows) total += r.length;
    const out = new Uint8Array(total);
    out.set(counts, 0);
    let p = counts.length;
    for (const r of rows) { out.set(r, p); p += r.length; }
    return out;
  }

  /* 生成一张 256×256 的 RGB 颗粒图案记录（复用 PS 导出的记录前缀，只换像素） */
  function buildPatternRecord(seed) {
    if (!patternTpl) return null;
    const w = patternTpl.width, h = patternTpl.height;
    const prefix = patternTpl.prefix();
    const pixels = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = (x * 374761393 + y * 668265263 + seed * 2147483647) ^ 0x5bf03635;
        v = (v ^ (v >> 13)) * 1274126177; v = v ^ (v >> 16);
        const n0 = (v >>> 0) % 1000;
        let v2 = (x * 22695477 + y * 1013904223 + seed * 2654435761) ^ 0x27d4eb2d;
        v2 = (v2 ^ (v2 >> 15)) * 2246822519; v2 = v2 ^ (v2 >> 13);
        const n1 = (v2 >>> 0) % 1000;
        const v3 = (x * 1103515245 + y * 12345 + seed * 65539) >>> 0;
        const n2 = v3 % 1000;
        const o = (y * w + x) * 3;
        pixels[o] = 120 + Math.round(80 * (n0 / 999));
        pixels[o + 1] = 118 + Math.round(80 * (n1 / 999));
        pixels[o + 2] = 116 + Math.round(80 * (n2 / 999));
      }
    }
    const len = (prefix.length - 4) + pixels.length;
    const out = new Uint8Array(4 + len);
    out[0] = (len >>> 24) & 255; out[1] = (len >>> 16) & 255; out[2] = (len >>> 8) & 255; out[3] = len & 255;
    out.set(prefix.subarray(4), 4);
    out.set(pixels, prefix.length);
    return out;
  }

  function _block8(type, data) {
    const pad = data.length & 1;
    return util.concat([_ascii4('8BIM'), _ascii4(type), _u32be(data.length), data, new Uint8Array(pad)]);
  }

  function writeAbrV6(items, optsFromArgs) {
    if (!items || !items.length) throw new Error('没有可写入 ABR 的笔刷');
    _uuidCounter = 0;
    const valid = [];
    for (const it of items) {
      if (it.w && it.h && it.gray && it.gray.length === it.w * it.h) valid.push(it);
    }
    if (!valid.length) throw new Error('没有有效的笔尖像素');

    const sampParts = [];
    const presets = [];
    for (const it of valid) {
      const uuid = it.uuid || _makeUuid();
      // 原样样本：直接复用源 ABR 的采样条目字节（只重算长度派生字段），
      // 用于“部分导出也保留 PS 原版特性”
      if (it.rawSample && it.rawSample.length > 320) {
        const body = new Uint8Array(it.rawSample);
        const entryLenRaw = body.length;
        if (body.length >= 301) {
          body.set(_u32be(entryLenRaw - 49), 45);
          if (entryLenRaw >= 305) body.set(_u32be(entryLenRaw - 305), 293);
          if (uuid && body.length >= 37) {
            const ub2 = util.utf8Encode(uuid);
            body.set(ub2.subarray(0, 36), 1);
          }
        }
        const padRaw = ((entryLenRaw + 3) & ~3) - entryLenRaw;
        sampParts.push(util.concat([_u32be(entryLenRaw), body, new Uint8Array(padRaw)]));
        presets.push({ it, uuid });
        continue;
      }
      let gray = it.gray;
      if (it.flipY) {
        const gw = it.w, gh = it.h, tmp = new Uint8Array(gray.length);
        for (let y = 0; y < gh; y++) tmp.set(gray.subarray((gh - 1 - y) * gw, (gh - y) * gw), y * gw);
        gray = tmp;
      }
      const useRle = !!it.rle;
      const pixelData = useRle ? rleEncode(gray, it.w, it.h) : gray;
      const entryLen = 301 + 19 + pixelData.length; // unpadded body length
      // 301-byte sampled-brush header, byte-compatible with Photoshop's own exports.
      // Verified field layout (offsets inside the 301-byte header):
      //   0='$', 1..37=uuid, 38=0x01, 44=0x03,
      //   45=u32(len-49), 49/53/57/61=rect(top,left,bottom,right),
      //   65=u32(0x38), 289=u32(1), 293=u32(len-305), 300=0x08
      const head = new Uint8Array(301);
      head[0] = 0x24; // '$'
      const ub = util.utf8Encode(uuid);
      head.set(ub.subarray(0, 36), 1);
      head[38] = 0x01;
      head[44] = 0x03;
      head.set(_u32be(entryLen - 49), 45);
      head.set(_i32be(0), 49);      // top
      head.set(_i32be(0), 53);      // left
      head.set(_i32be(it.h), 57);   // bottom
      head.set(_i32be(it.w), 61);   // right
      head.set(_u32be(0x38), 65);
      head.set(_u32be(1), 289);
      head.set(_u32be(entryLen - 305), 293);
      head[300] = 0x08;
      const rect = util.concat([
        _i32be(0), _i32be(0), _i32be(it.h), _i32be(it.w),
        _u16be(8), new Uint8Array([useRle ? 1 : 0])
      ]);
      // Length field stays UNPADDED (like real PS files); the reader rounds up to 4.
      const body = util.concat([head, rect, pixelData]);
      const padLen = ((body.length + 3) & ~3) - body.length;
      sampParts.push(util.concat([_u32be(entryLen), body, new Uint8Array(padLen)]));
      presets.push({ it, uuid });
    }
    // 需要时补齐源文件里的其它采样（保证 dualBrush 等内部引用不悬空）
    const keepAll = valid.some(function (it) { return it.keepAllSamples && it.allRawSamples; });
    if (keepAll) {
      const seen = {};
      for (const it of valid) {
        const b = it.rawSample;
        if (b) { const u = String.fromCharCode.apply(null, b.subarray(1, 37)); seen[u] = true; }
      }
      const src = (valid.find(function (it) { return it.keepAllSamples && it.allRawSamples; }) || {}).allRawSamples || [];
      const extra = [];
      for (const body of src) {
        if (!body || body.length < 320) continue;
        const u = String.fromCharCode.apply(null, body.subarray(1, 37));
        if (seen[u]) continue;
        seen[u] = true;
        const copy = new Uint8Array(body);
        const pad2 = ((copy.length + 3) & ~3) - copy.length;
        extra.push(util.concat([_u32be(copy.length), copy, new Uint8Array(pad2)]));
      }
      if (extra.length) {
        for (const e of extra) sampParts.push(e);
      }
    }
    const sampData = util.concat(sampParts);
    const sampBlock = _block8('samp', sampData);

    // descriptor block
    const presetObjs = [];
    for (const p of presets) {
      const it = p.it;
      if (it.rawPreset) {
        presetObjs.push(util.concat([_ascii4('Objc'), new Uint8Array(it.rawPreset)]));
        continue;
      }
      const diameter = it.sizePx || Math.max(it.w, it.h);
      // sampledBrush + sampledData is what makes Photoshop use the actual
      // bitmap tip (a computedBrush preset paints a plain round dab instead).
      const inner = _descObjc('', 'sampledBrush', [
        _descItem('Dmtr', 'UntF', _descUntF('#Pxl', diameter)),
        _descItem('Angl', 'UntF', _descUntF('#Ang', it.angle || 0)),
        _descItem('Rndn', 'UntF', _descUntF('#Prc', it.roundness === undefined ? 100 : it.roundness)),
        _descItem('Nm  ', 'TEXT', _descText(it.name || '')),
        _descItem('Spcn', 'UntF', _descUntF('#Prc', it.spacingPct === undefined ? 25 : it.spacingPct)),
        _descItem('Intr', 'bool', _descBool(true)),
        _descItem('flipX', 'bool', _descBool(false)),
        _descItem('flipY', 'bool', _descBool(false)),
        _descItem('sampledData', 'TEXT', _descText(p.uuid))
      ].concat(it.hardness === undefined ? [] : [
        _descItem('Hrdn', 'UntF', _descUntF('#Prc', Math.round(Math.max(0, Math.min(1, it.hardness)) * 100)))
      ]));
      // Preset item set/order copied from real Photoshop exports: PS silently falls back
      // to a computed brush when dualBrush / brushGroup / useColorDynamics ... are missing.
      const presetItems = [
        _descItem('Nm  ', 'TEXT', _descText(it.name || '')),
        _descItem('Brsh', 'Objc', inner),
        _descItem('useTipDynamics', 'bool', _descBool(!!(it.pressureSize || it.pressureOpacity)))
      ];
      const brv = (bVTy, jitter, mnm) => _descObjc('', 'brVr', [
        _descItem('bVTy', 'long', new Uint8Array([0, 0, 0, bVTy])),
        _descItem('fStp', 'long', new Uint8Array([0, 0, 0, 25])),
        _descItem('jitter', 'UntF', _descUntF('#Prc', Math.round(jitter || 0))),
        _descItem('Mnm ', 'UntF', _descUntF('#Prc', Math.round(mnm || 0)))
      ]);
      const sizeJitter = Math.max(0, Math.min(100, it.sizeJitterPct || 0));
      if (it.pressureSize || sizeJitter > 0) {
        const minD = Math.round(Math.max(0, Math.min(100, (it.minSizeRatio === undefined ? 0.1 : it.minSizeRatio) * 100)));
        presetItems.push(_descItem('minimumDiameter', 'UntF', _descUntF('#Prc', minD)));
        presetItems.push(_descItem('minimumRoundness', 'UntF', _descUntF('#Prc', 25)));
        presetItems.push(_descItem('szVr', 'Objc', brv(it.pressureSize ? 2 : 0, sizeJitter, 0)));
      }
      if ((it.angleJitterDeg || 0) > 0) {
        presetItems.push(_descItem('angleDynamics', 'Objc', brv(0, it.angleJitterDeg, 0)));
      }
      if ((it.roundnessJitterPct || 0) > 0) {
        presetItems.push(_descItem('roundnessDynamics', 'Objc', brv(0, it.roundnessJitterPct, 0)));
      }
      if ((it.tiltJitterPct || 0) > 0) {
        presetItems.push(_descItem('ttlVr', 'Objc', brv(3, it.tiltJitterPct, 0)));
      }
      if (it.scatterOn || (it.scatterCount || 1) > 1) {
        presetItems.push(_descItem('useScatter', 'bool', _descBool(true)));
        presetItems.push(_descItem('Cnt ', 'doub', _doube(it.scatterCount || 1)));
        presetItems.push(_descItem('bothAxes', 'bool', _descBool(!!it.scatterBothAxes)));
        presetItems.push(_descItem('scatterDynamics', 'Objc', brv(0, it.scatterPct || 0, 0)));
      }
      if (it.pressureOpacity) {
        presetItems.push(_descItem('opVr', 'Objc', _descObjc('', 'brVr', [
          _descItem('bVTy', 'long', new Uint8Array([0, 0, 0, 2])),
          _descItem('fStp', 'long', new Uint8Array([0, 0, 0, 25])),
          _descItem('jitter', 'UntF', _descUntF('#Prc', 0)),
          _descItem('Mnm ', 'UntF', _descUntF('#Prc', Math.round((it.minOpacityRatio === undefined ? 0.25 : it.minOpacityRatio) * 100)))
        ])));
      }
      if (it.psTexture && patternTpl) {
        presetItems.push(_descItem('useTexture', 'bool', _descBool(true)));
        presetItems.push(_descItem('TxtC', 'bool', _descBool(true)));
        presetItems.push(_descItem('interpretation', 'bool', _descBool(true)));
        presetItems.push(_descItem('textureBlendMode', 'enum', _descEnum('BlnM', 'Nrml')));
        presetItems.push(_descItem('textureDepth', 'UntF', _descUntF('#Prc', Math.round(Math.max(0, Math.min(1, it.textureDepth === undefined ? 0.5 : it.textureDepth)) * 100))));
        presetItems.push(_descItem('minimumDepth', 'UntF', _descUntF('#Prc', 0)));
        presetItems.push(_descItem('Txtr', 'Objc', _descObjc('', 'Ptrn', [
          _descItem('Nm  ', 'TEXT', _descText('$$$/Presets/Patterns/' + patternTpl.name + '=' + patternTpl.name)),
          _descItem('Idnt', 'TEXT', _descText(patternTpl.id))
        ])));
        presetItems.push(_descItem('textureScale', 'UntF', _descUntF('#Prc', Math.round(Math.max(1, Math.min(1000, (it.textureScale === undefined ? 1 : it.textureScale) * 100))))));
      } else {
        presetItems.push(_descItem('useTexture', 'bool', _descBool(false)));
      }
      presetItems.push(
        _descItem('dualBrush', 'Objc', _descObjc('', 'dualBrush', [
          _descItem('useDualBrush', 'bool', _descBool(false))
        ])),
        _descItem('brushGroup', 'Objc', _descObjc('', 'brushGroup', [
          _descItem('useBrushGroup', 'bool', _descBool(false))
        ])),
        _descItem('usePaintDynamics', 'bool', _descBool(!!(it.pressureSize || it.pressureOpacity))),
        _descItem('useColorDynamics', 'bool', _descBool(false)),
        _descItem('Wtdg', 'bool', _descBool(false)),
        _descItem('Nose', 'bool', _descBool(false)),
        _descItem('Rpt ', 'bool', _descBool(false)),
        _descItem('useBrushSize', 'bool', _descBool(false)),
        _descItem('useBrushPose', 'bool', _descBool(false))
      );
      const flowPct100 = it.flowPct === undefined ? 100 : Math.max(1, Math.min(100, Math.round(it.flowPct * 100)));
      const opct100 = it.opacityPct === undefined ? 100 : Math.max(1, Math.min(100, Math.round(it.opacityPct * 100)));
      if (flowPct100 < 100 || opct100 < 100) {
        presetItems.push(_descItem('toolOptions', 'Objc', _descObjc('', 'PbTl', [
          _descItem('brushPreset', 'bool', _descBool(true)),
          _descItem('flow', 'long', new Uint8Array([0, 0, 0, flowPct100])),
          _descItem('Opct', 'long', new Uint8Array([0, 0, 0, opct100]))
        ])));
      }
      const preset = _descObjc('', 'brushPreset', presetItems);
      presetObjs.push(util.concat([_ascii4('Objc'), preset]));
    }
    const descItems = util.concat([
      _descItem('Brsh', 'VlLs', util.concat([_u32be(presetObjs.length)].concat(presetObjs)))
    ]);
    // root: format version 16, "1" header variant, empty class name, class id 'null'
    const descData = util.concat([
      _u32be(16),
      _u32be(1),
      _u16be(0),
      _u32be(0),
      _ascii4('null'),
      _u32be(1),
      descItems
    ]);
    const descBlock = _block8('desc', descData);
    // 源 ABR 有纹理图案时，原样带上 patt 块（否则描述符里的 Txtr 引用会悬空）
    const wantTex = valid.some(function (it) { return it.psTexture; });
    // 优先级：源文件自带的图案块（描述符里的 Txtr 引用能对得上）> 自己生成的 256×256 颗粒图案
    let pattData = null;
    const srcPatt = (optsFromArgs && optsFromArgs.patternBlock) ||
      (valid[0] && valid[0]._pattBlock) || null;
    if (srcPatt) pattData = new Uint8Array(srcPatt);
    if (!pattData && wantTex) {
      const rec = buildPatternRecord(11);
      if (rec) pattData = rec;
    }
    const pattBlock = _block8('patt', pattData || new Uint8Array(0));

    // phry(hierarchy)：分组 = Grup{Nm} + 若干 preset{} + groupEnd{} 扁平 token 流
    const groups = (optsFromArgs && optsFromArgs.groups) || [];
    let hierItems = null;
    if (groups.length) {
      const toks = [];
      for (const g of groups) {
        const cnt = Math.max(0, g.count | 0);
        if (g.name) {
          toks.push(_descObjc('', 'Grup', [_descItem('Nm  ', 'TEXT', _descText(g.name))]));
        }
        for (let i = 0; i < cnt; i++) toks.push(_descObjc('', 'preset', []));
        if (g.name) toks.push(_descObjc('', 'groupEnd', []));
      }
      if (toks.length) {
        hierItems = util.concat([_u32be(toks.length)].concat(toks.map(function (t) {
          return util.concat([_ascii4('Objc'), t]);
        })));
      }
    }
    const phryData = util.concat([
      _u32be(16), _u32be(1), _u16be(0), _u32be(0), _ascii4('null'), _u32be(1),
      _descItem('hierarchy', 'VlLs', hierItems || util.concat([_u32be(0)]))
    ]);
    const phryBlock = _block8('phry', phryData);
    return util.concat([_u16be(6), _u16be(2), sampBlock, pattBlock, descBlock, phryBlock]);
  }

  function buildPatternFile() {
    const rec = buildPatternRecord(11);
    if (!rec) return null;
    return new Uint8Array(rec);
  }

  const api = { isAbr, parse, parseAsync, writeAbr, writeAbrV6, buildPatternFile, maskFromRGBA };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { abr: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
