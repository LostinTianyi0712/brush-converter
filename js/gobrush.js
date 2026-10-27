/* Huawei 天生会画 / GoPaint brush files — reverse-engineered from real exports:

   .gobrush  = ZIP:
       info.json                  {"version":"3.2.9"}
       shape_<uuid>.png           brush shape (alpha = coverage)
       grain_<uuid>.png           grain texture
       snapshot_<uuid>.png        600x200 preview
       snapshot_light_<uuid>.png  light preview
       brush_<uuid>.info          binary: version header + embedded PNGs + TLV params
   .gobrushes = ZIP: many *.gobrush + brushgroup.info (group name string)

   brush_*.info layout: 3x u16 version (3,2,9) + PNG blobs + TLV records
   [tag u8][flag u8][u32le len][payload]; flag 0xB0 = parameter block,
   flag 0xC0 = property/localization block. The parameter->property mapping is not
   public, so this reader maps shape/grain/name and uses defaults for the rest. */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const zip = isNode ? require('./zip.js') : root.BC.zip;
  const png = isNode ? require('./png.js') : root.BC.png;

  function isGobrush(name) { return /\.gobrush(es)?$/i.test(name || ''); }
  function isGobrushSet(bytes) {
    if (!zip.isZip(bytes)) return false;
    try {
      const entries = zip.read(bytes);
      return entries.some(function (e) { return /\.gobrush$/i.test(e.name); });
    } catch (e) { return false; }
  }

  function le32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function infoBlock(info, flag) {
    // Skip image records by length: high-resolution PNGs can precede parameters
    // by many megabytes, and their compressed bytes are not TLV records.
    let pos = 10;
    while (pos + 6 <= info.length) {
      const len = le32(info, pos + 2), end = pos + 6 + len;
      if (end > info.length || ![0xb0, 0xc0, 0xd0].includes(info[pos + 1])) break;
      if (info[pos] === 0 && info[pos + 1] === flag) return info.subarray(pos, end);
      pos = end;
    }
    return info; // Retain compatibility with older unstructured samples.
  }

  function walkTlv(buf, start, end, sink) {
    let pos = start;
    while (pos + 6 <= end) {
      const tag = buf[pos];
      const flag = buf[pos + 1];
      if (flag !== 0xB0 && flag !== 0xC0) break;
      const len = le32(buf, pos + 2);
      if (pos + 6 + len > end) break;
      sink(tag, flag, buf.subarray(pos + 6, pos + 6 + len));
      pos += 6 + len;
    }
  }

  function readTlvString(payload) {
    try { return util.utf8Decode(payload).replace(/\u0000+$/, ''); } catch (e) { return ''; }
  }

  /* brush name lives in the flag 0xB0 parameter block, sub-record tag 2 */
  function nameFromInfo(info) {
    info = infoBlock(info, 0xb0);
    // scan for a sub-record [tag 0x02][flag 0xB0][u32 len][UTF-8 name]
    const limit = Math.min(info.length - 6, 2 * 1024 * 1024);
    for (let i = 0; i < limit; i++) {
      if (info[i] !== 0x02 || info[i + 1] !== 0xB0) continue;
      const len = le32(info, i + 2);
      if (!len || len > 256 || i + 6 + len > info.length) continue;
      const s = readTlvString(info.subarray(i + 6, i + 6 + len)).trim();
      if (s && !/^[0-9a-f\-]{20,}$/i.test(s)) return s;
    }
    return '';
  }

  /* parameter extraction.
     Calibrated on real samples + user tests:
       param tag5 = brush size (the size shown on the canvas size slider)
       param tag8 = max alpha (%) fallback
       property block records keep the real values in field 0x18:
         strokeSpacing -> spacing %, propertiesMaxAlpha -> opacity %,
         propertiesMaxSize -> size, shapeScatter -> scatter */
  function extractPropValues(info) {
    info = infoBlock(info, 0xc0);
    const out = {};
    const le = function (b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; };
    const limit = Math.min(info.length - 6, 4 * 1024 * 1024);
    for (let i = 0; i < limit; i++) {
      if (info[i] !== 0x00 || info[i + 1] !== 0xC0) continue;
      const len = le(info, i + 2);
      if (!len || len > 1024 * 1024 || i + 6 + len > info.length) continue;
      let p = i + 6, end = i + 6 + len;
      while (p + 6 <= end) {
        const tag = info[p];
        if (info[p + 1] !== 0xC0) break;
        const l = le(info, p + 2);
        if (p + 6 + l > end) break;
        if (tag === 0x10) {
          const body = info.subarray(p + 6, p + 6 + l);
          let q = 0, nm = '', v18 = null;
          while (q + 6 <= body.length) {
            const t2 = body[q], l2 = le(body, q + 2);
            if (q + 6 + l2 > body.length) break;
            if (t2 === 0x11) {
              try { nm = util.utf8Decode(body.subarray(q + 6, q + 6 + l2)); } catch (e) { nm = ''; }
            } else if (t2 === 0x15 && l2 === 4) {
              v18 = le(body, q + 6);
            }
            q += 6 + l2;
          }
          if (nm && v18 !== null) out[nm] = v18;
        }
        p += 6 + l;
      }
      if (Object.keys(out).length) break;
    }
    return out;
  }

  function extractParams(info) {
    const fullInfo = info;
    info = infoBlock(info, 0xb0);
    const out = { size: 0, spacing: 0, opacity: undefined, flow: undefined, scatter: 0 };
    const le = function (b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; };
    const limit = Math.min(info.length - 6, 2 * 1024 * 1024);
    for (let i = 0; i < limit; i++) {
      if (info[i] !== 0x00 || info[i + 1] !== 0xB0) continue;
      const len = le(info, i + 2);
      if (!len || len > 4096 || i + 6 + len > info.length) continue;
      let p = i + 6, end = i + 6 + len;
      const vals = {};
      while (p + 6 <= end) {
        const t = info[p], f = info[p + 1];
        if (f !== 0xB0) break;
        const l = le(info, p + 2);
        if (p + 6 + l > end) break;
        if (l === 4) vals[t] = le(info, p + 6);
        p += 6 + l;
      }
      if (!Object.keys(vals).length) continue;
      out.size = vals[5] || vals[6] || 0;
      out.opacity = vals[8];
      out.flow = vals[9];
      break;
    }
    const props = extractPropValues(fullInfo);
    if (props.strokeSpacing !== undefined) out.spacing = props.strokeSpacing;
    if (props.propertiesMaxAlpha !== undefined) out.opacity = props.propertiesMaxAlpha;
    // propertiesMaxSize 量纲与 tag5 不同（1600 vs 35），尺寸仍以 tag5 为准
    if (props.shapeScatter !== undefined) out.scatter = props.shapeScatter;
    if (props.grainDepth !== undefined) out.textureDepth = props.grainDepth / 100;
    if (props.renderingFlow !== undefined) out.flowPct = Math.max(0, Math.min(1, props.renderingFlow / 100));
    if (props.propertiesMaxSize > 0) {
      if (props.propertiesMinSize !== undefined) out.minSizeRatio = Math.max(0, Math.min(1, props.propertiesMinSize / props.propertiesMaxSize));
      if (props.propertiesMinAlpha !== undefined && props.propertiesMaxAlpha > 0) out.minOpacityRatio = Math.max(0, Math.min(1, props.propertiesMinAlpha / props.propertiesMaxAlpha));
    }
    return out;
  }

  /* 天生的压力曲线：属性块里 apply_preference_settings_pressure 的 tag 0x20 是 JSON 点集
     [{"x":0,"y":0},...,{"x":255,"y":255}]（x/y 0..255），全局压力响应曲线 */
  function extractPressureCurves(info) {
    info = infoBlock(info, 0xc0);
    const result = { global: null, parameters: {} };
    const le = function (b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; };
    for (let i = 0; i + 6 < info.length; i++) {
      if (info[i] !== 0x10 || info[i + 1] !== 0xC0) continue;
      const outerLen = le(info, i + 2);
      if (outerLen < 20 || i + 6 + outerLen > info.length) continue;
      let p = i + 6, end = i + 6 + outerLen, name = '', curve = null;
      while (p + 6 <= end) {
        const tag = info[p];
        if (info[p + 1] !== 0xC0) break;
        const len = le(info, p + 2);
        if (p + 6 + len > end) break;
        if (tag === 0x11) { try { name = util.utf8Decode(info.subarray(p + 6, p + 6 + len)); } catch (e) { name = ''; } }
        else if (tag === 0x20 && len > 1 && info[p + 6] === 0x5b) {
          try {
            const pts = JSON.parse(util.utf8Decode(info.subarray(p + 6, p + 6 + len)));
            if (Array.isArray(pts)) curve = pts;
          } catch (e) { /* ignore */ }
        }
        p += 6 + len;
      }
      if (curve && name === 'apply_preference_settings_pressure') result.global = curve;
      else if (curve && /_PressureCurve$/.test(name)) result.parameters[name] = curve;
    }
    return result;
  }

  function decodePng(bytes, mask) {
    try {
      if (!png.isPng(bytes)) return null;
      const img = png.decode(bytes);
      if (!img.width || !img.height) return null;
      return { w: img.width, h: img.height, rgba: mask === false ? img.rgba : png.toMaskRgba(img.rgba) };
    } catch (e) {
      return null;
    }
  }

  function parseOne(bytes, fileName) {
    const warnings = [];
    const entries = zip.read(bytes);
    let shape = null, grain = null, snapshot = null, infoFile = null, brushUuid = '';
    for (const e of entries) {
      if (e.dir) continue;
      const data = e.data();
      if (/^shape_.*\.png$/i.test(e.name)) shape = decodePng(data);
      else if (/^grain_.*\.png$/i.test(e.name)) grain = decodePng(data, false);
      else if (/^snapshot_light_.*\.png$/i.test(e.name)) snapshot = snapshot || decodePng(data);
      else if (/^snapshot_.*\.png$/i.test(e.name)) snapshot = snapshot || decodePng(data);
      else if (/^brush_.*\.info$/i.test(e.name)) {
        infoFile = data;
        brushUuid = e.name.replace(/^brush_/, '').replace(/\.info$/i, '');
      }
    }
    let name = infoFile ? nameFromInfo(infoFile) : '';
    if (!name) name = (fileName || 'gobrush').replace(/\.[^.]+$/, '');
    const params = infoFile ? extractParams(infoFile) : { size: 0, spacing: 0 };
    const pressureCurves = infoFile ? extractPressureCurves(infoFile) : {global:null,parameters:{}};
    if (!shape) warnings.push('该 .gobrush 没有 shape PNG，转换时会生成程序化笔尖');
    warnings.push('天生会画参数：间距已校准（tag5），尺寸/不透明度按参数块映射，笔尖形状图精确；可在界面用「整体尺寸倍数」微调');
    // Keep source pixels; logical brush diameter is independent of resolution.
    const tip = shape;
    let sizePx = params.size > 0 && params.size < 3000 ? params.size : 100;
    let spacingPct = params.spacing >= 1 && params.spacing <= 1000 ? params.spacing : 25;
    let opacity = params.opacity === undefined ? 1 : Math.max(0, Math.min(1, params.opacity / 100));
    return {
      brush: {
        name: name,
        gopaintUuid: brushUuid,
        tip: tip,
        grain: grain,
        sizePx: sizePx,
        spacingPct: spacingPct,
        opacity: opacity,
        hardness: 1,
        angle: 0,
        roundness: 100,
        pressure: false,
        pressureSize: false,
        minSizeRatio: (params.minSizeRatio !== undefined ? params.minSizeRatio : 1),
        minOpacityRatio: (params.minOpacityRatio !== undefined ? params.minOpacityRatio : 1),
        flowPct: (params.flowPct !== undefined ? params.flowPct : 1),
        scatterOn: (params.scatter || 0) > 0,
        scatterPct: params.scatter || 0,
        scatterCount: 1,
        scatterBothAxes: true,
        gopaintPressureCurve: pressureCurves.global || undefined,
        gopaintPressureCurves: pressureCurves.parameters,
        hasTexture: (params.textureDepth || 0) > 0,
        textureDepth: params.textureDepth || 0,
        source: 'gopaint'
      },
      snapshot: snapshot,
      warnings: warnings
    };
  }

  function parse(bytes, fileName, depth) {
    depth = depth || 0;
    if (depth > 16) throw new Error('GoPaint笔刷组嵌套过深');
    if (!zip.isZip(bytes)) throw new Error('.gobrush 不是 ZIP 容器（请提供样例以便适配）');
    const entries = zip.read(bytes);
    const inner = [];
    let groupName = '';
    for (const e of entries) {
      if (e.dir) continue;
      if (/\.gobrush(es)?$/i.test(e.name)) inner.push({ name: e.name, data: e.data() });
      else if (/^brushgroup\.info$/i.test(e.name)) {
        // real brushgroup.info = u16(3,2,9) + u32(restLen) + tag0 flag0xA0 payload {
        //   tag1 uuid string, tag2 group name (UTF-8), tag3 u32 }
        const raw = e.data();
        let parsed = '';
        try {
          if (raw.length > 10) {
            const rest = (raw[6] | (raw[7] << 8) | (raw[8] << 16) | (raw[9] << 24)) >>> 0;
            let i = 10;
            const end = Math.min(raw.length, 10 + rest);
            while (i + 6 <= end) {
              const tag = raw[i], flag = raw[i + 1];
              const len = (raw[i + 2] | (raw[i + 3] << 8) | (raw[i + 4] << 16) | (raw[i + 5] << 24)) >>> 0;
              if (i + 6 + len > end) break;
              const payload = raw.subarray(i + 6, i + 6 + len);
              if (flag === 0xa0 && tag === 0) {
                // outer record -> walk nested
                let j = 0;
                while (j + 6 <= payload.length) {
                  const t2 = payload[j], f2 = payload[j + 1];
                  const l2 = (payload[j + 2] | (payload[j + 3] << 8) | (payload[j + 4] << 16) | (payload[j + 5] << 24)) >>> 0;
                  if (j + 6 + l2 > payload.length) break;
                  if (f2 === 0xa0 && t2 === 2) parsed = util.utf8Decode(payload.subarray(j + 6, j + 6 + l2)).trim();
                  j += 6 + l2;
                }
              }
              i += 6 + len;
            }
          }
        } catch (err) { parsed = ''; }
        if (parsed) { groupName = parsed; continue; }
        const txt = util.utf8Decode(raw);
        const re = /[\u4e00-\u9fffA-Za-z0-9][\u4e00-\u9fffA-Za-z0-9 _\-]{0,39}/g;
        let mm, best = '';
        while ((mm = re.exec(txt))) {
          if (mm[0].trim().length > best.trim().length) best = mm[0].trim();
        }
        groupName = best || '';
      }
    }
    if (!inner.length) {
      const one = parseOne(bytes, fileName);
      one.brush._rawGobrush = bytes;
      one.brush._rawBrushState = util.brushFingerprint(one.brush);
      return { brushes: [one.brush], warnings: one.warnings, snapshot: one.snapshot, groupName: '' };
    }
    const brushes = [], warnings = [];
    let snapshot = null;
    for (const ib of inner) {
      try {
        const one = parse(ib.data, ib.name, depth + 1);
        if (!snapshot && one.snapshot) snapshot = one.snapshot;
        one.brushes.forEach(function (b) {
          if (!b.name) b.name = groupName;
          if (!b.group && groupName) b.group = groupName;
          brushes.push(b);
        });
        if (brushes.length === one.brushes.length) warnings.push.apply(warnings, one.warnings);
      } catch (err) {
        warnings.push(ib.name + ' 解析失败：' + err.message);
      }
    }
    if (!brushes.length) throw new Error('.gobrushes 中没有可解析的笔刷');
    if (groupName) warnings.push('笔刷集名称：' + groupName);
    const rawGroup = {bytes:bytes,count:brushes.length,name:groupName};
    brushes.forEach(function (b, index) {
      b._rawGoGroup = rawGroup; b._rawGoIndex = index;
      b._rawBrushState = util.brushFingerprint(b);
    });
    return { brushes: brushes, warnings: warnings, snapshot: snapshot, groupName: groupName };
  }

  const api = { isGobrush, isGobrushSet, parse };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { gobrush: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
