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

  /* 第206轮 R204-01：天生会画 grainScale → 纹理平铺边长（画布像素）的实测系数，见 parseOne 注释。
     与 gobrushWrite.js 同名常量保持一致（test/halftone_texture206_test.js 锁定）。 */
  const GOPAINT_TILE_K = 0.576;
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

  /* 属性块 / 参数块的载荷（外层 [tag 0][flag 0xC0|0xB0][u32 len] 之后的记录流）。
     属性块的记录头是 [tag 0x10][flag 0xC0][u32 len]，gobrushWrite.setPropField 直接在
     这段记录流上按 0x11 名字找 0x18 当前值——所以这一段必须原样交给写侧。

     ⚠ 必须先按外层记录流走（pos=10 起、按 flag 0xd0/0xb0/0xc0 逐条跳），不能用字节扫描：
     资源块里塞着几百 KB 的 PNG，里面出现 00 C0 的概率极高，扫到就是一段假属性块
     （「草书-2-副」那类 1.3 MB 样本会被切前 75 条，读侧写侧一起错位）。 */
  function recordWalkPayload(info, flag) {
    let pos = 10;
    while (pos + 6 <= info.length) {
      const tag = info[pos], f = info[pos + 1], len = le32(info, pos + 2), end = pos + 6 + len;
      if (end > info.length || [0xb0, 0xc0, 0xd0].indexOf(f) < 0) break;
      if (tag === 0 && f === flag) return info.subarray(pos + 6, end);
      pos = end;
    }
    return null;
  }
  function countPropRecords(block) {
    let p = 0, n = 0;
    while (p + 6 <= block.length) {
      const tag = block[p];
      if (tag !== 0x10 || block[p + 1] !== 0xc0) break;
      const len = le32(block, p + 2), end = p + 6 + len;
      if (end > block.length) break;
      const body = block.subarray(p + 6, end);
      let q = 0, hasName = false, hasValue = false;
      while (q + 6 <= body.length) {
        const t2 = body[q], l2 = le32(body, q + 2);
        if (q + 6 + l2 > body.length) break;
        if (t2 === 0x11 && l2 > 0) hasName = true;
        else if (t2 === 0x18 && l2 === 4) hasValue = true;
        q += 6 + l2;
      }
      if (hasName && hasValue) n++;
      p = end;
    }
    return n;
  }
  function propBlockPayload(info) {
    const direct = recordWalkPayload(info, 0xc0);
    if (direct) return direct;
    // 老样本没有规范外层记录流时才退回字节扫描，且必须扫出一段真的能解出属性记录的块
    const limit = Math.min(info.length - 6, 4 * 1024 * 1024);
    for (let i = 0; i < limit; i++) {
      if (info[i] !== 0x00 || info[i + 1] !== 0xc0) continue;
      const len = le32(info, i + 2);
      if (!len || len > 1024 * 1024 || i + 6 + len > info.length) continue;
      const block = info.subarray(i + 6, i + 6 + len);
      if (countPropRecords(block) > 0) return block;
    }
    return null;
  }
  function countParamTags(block) {
    let p = 0, n = 0;
    while (p + 6 <= block.length) {
      if (block[p + 1] !== 0xb0) break;
      const end = p + 6 + le32(block, p + 2);
      if (end > block.length) break;
      n++;
      p = end;
    }
    return n;
  }
  function paramBlockPayload(info) {
    const direct = recordWalkPayload(info, 0xb0);
    if (direct) return direct;
    const limit = Math.min(info.length - 6, 2 * 1024 * 1024);
    for (let i = 0; i < limit; i++) {
      if (info[i] !== 0x00 || info[i + 1] !== 0xb0) continue;
      const len = le32(info, i + 2);
      if (!len || len > 4096 || i + 6 + len > info.length) continue;
      const block = info.subarray(i + 6, i + 6 + len);
      if (countParamTags(block) >= 3) return block;
    }
    return null;
  }

  /* 属性块全量快照。每条属性记录是自描述的——
       [0x11] key（程序用的英文名） [0x12] 中文显示名 [0x13] 控件类型 [0x14] 属性组
       [0x15] 上限 [0x16] 下限 [0x17] 疑似默认值 [0x18] 当前值 [0x19] 附加负载
       [0x20] 压力曲线 JSON [0x21] 记录结束
     返回 {values, meta, curves, block}：
       values = {key: 0x18 当前值}；meta = {key: {type, group, min, max}}；
       curves = {key: 0x20 JSON 文本}；block = 原始记录流（写侧追加记录时要用）。
     写侧只能透传它没有专门映射的属性，缺了这份快照整块 119 条都会被模板值覆盖。 */
  function textAt(buf, start, end) {
    try { return util.utf8Decode(buf.subarray(start, end)); } catch (e) { return ''; }
  }
  function extractProps(info) {
    const block = propBlockPayload(info);
    const out = { values: {}, meta: {}, curves: {}, block: block };
    if (!block) return out;
    let p = 0;
    while (p + 6 <= block.length) {
      const tag = block[p];
      if (block[p + 1] !== 0xc0) break;
      const len = le32(block, p + 2), end = p + 6 + len;
      if (end > block.length) break;
      if (tag === 0x10) {
        const body = block.subarray(p + 6, end);
        let q = 0, name = '', type = '', group = '', max = null, min = null, value = null, curve = null;
        while (q + 6 <= body.length) {
          const t2 = body[q], l2 = le32(body, q + 2), at = q + 6, to = q + 6 + l2;
          if (to > body.length) break;
          if (t2 === 0x11) name = textAt(body, at, to);
          else if (t2 === 0x13) type = textAt(body, at, to);
          else if (t2 === 0x14) group = textAt(body, at, to);
          else if (t2 === 0x15 && l2 === 4) max = le32(body, at) | 0;
          else if (t2 === 0x16 && l2 === 4) min = le32(body, at) | 0;
          else if (t2 === 0x18 && l2 === 4) value = le32(body, at) | 0;
          else if (t2 === 0x20 && l2 > 1) curve = textAt(body, at, to);
          q = to;
        }
        if (name && value !== null) {
          out.values[name] = value;
          out.meta[name] = { type: type, group: group, min: min, max: max };
          if (curve) out.curves[name] = curve;
        }
      }
      p = end;
    }
    return out;
  }

  /* 参数块原始 tag 表（tag → payload）。写侧只有 uuid / 名字 / 尺寸 / 不透明度几个 tag 有映射，
     其余（t3 app 名、t32、t33 时间戳、t35…）原生样本各不相同，留着给写侧照抄源值。 */
  function extractParamTags(info) {
    const block = paramBlockPayload(info);
    const out = {};
    if (!block) return out;
    let p = 0;
    while (p + 6 <= block.length) {
      const tag = block[p];
      if (block[p + 1] !== 0xb0) break;
      const len = le32(block, p + 2), end = p + 6 + len;
      if (end > block.length) break;
      out[tag] = block.subarray(p + 6, end);
      p = end;
    }
    return out;
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
    // 与 extractProps 同一套解析（见上）；保留这个薄包装给 extractParams 用。
    return extractProps(info).values;
  }

  function extractParams(info) {
    const fullInfo = info;
    info = infoBlock(info, 0xb0);
    const out = { size: 0, spacing: 0, opacity: undefined, flow: undefined, scatter: 0 };
    const le = function (b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; };
    const block = paramBlockPayload(fullInfo);
    if (block) {
      let p = 0, end = block.length;
      const vals = {};
      while (p + 6 <= end) {
        const t = block[p], f = block[p + 1];
        if (f !== 0xB0) break;
        const l = le(block, p + 2);
        if (p + 6 + l > end) break;
        if (l === 4) vals[t] = le(block, p + 6);
        p += 6 + l;
      }
      if (Object.keys(vals).length) {
        out.size = vals[5] || vals[6] || 0;
        out.opacity = vals[8];
        out.flow = vals[9];
      }
    }
    const props = extractPropValues(fullInfo);
    if (props.strokeSpacing !== undefined) out.spacing = props.strokeSpacing;
    if (props.propertiesMaxAlpha !== undefined) out.opacity = props.propertiesMaxAlpha;
    // tag5 is a percentage between the current minimum and maximum bounds.
    if (props.shapeScatter !== undefined) out.scatter = props.shapeScatter;
    // 线条→抖动 / 掉落：原生样本（楷书）分别是 64%/19%，之前完全没读，重建时会丢成 0
    if (props.strokeJitter !== undefined) out.jitter = Math.max(0, Math.min(200, props.strokeJitter));
    if (props.strokeFallOff !== undefined) out.falloff = Math.max(0, Math.min(100, props.strokeFallOff));
    if (props.grainDepth !== undefined) out.textureDepth = props.grainDepth / 100;
    // 第206轮 R204-01：纹理「比例」当前值（原生 0x18）。楷书样本 15、模板 25；MatePad 实测 5/25/50 三档。
    if (props.grainScale !== undefined && props.grainScale > 0 && props.grainScale <= 1000) out.grainScale = props.grainScale;
    if (props.renderingFlow !== undefined) out.flowPct = Math.max(0, Math.min(1, props.renderingFlow / 100));
    if (props.propertiesMaxSize > 0) out.maxSizePct = props.propertiesMaxSize;
    out.minSizePct = props.propertiesMinSize === undefined ? 0 : props.propertiesMinSize;
    // Native A/B exports: tag5 is the interpolation position between these
    // bounds. A 14% slider within 70..100 means 74.2%, not 14 units.
    const maxSize = out.maxSizePct || 262;
    const effectiveSize = out.minSizePct + (maxSize - out.minSizePct) * out.size / 100;
    if (effectiveSize > 0) out.minSizeRatio = Math.max(0, Math.min(1, out.minSizePct / effectiveSize));
    // 最小不透明度是独立属性，不能被无关的 propertiesMaxSize 门控吞掉
    if (props.propertiesMinAlpha !== undefined && props.propertiesMaxAlpha > 0) out.minOpacityRatio = Math.max(0, Math.min(1, props.propertiesMinAlpha / props.propertiesMaxAlpha));
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
    let shapeUuid = '', grainUuid = '';
    const infoFiles = [];
    for (const e of entries) {
      if (e.dir) continue;
      const data = e.data();
      if (/^shape_.*\.png$/i.test(e.name)) {
        shape = decodePng(data);
        shapeUuid = e.name.replace(/^shape_/i, '').replace(/\.png$/i, '');
      } else if (/^grain_.*\.png$/i.test(e.name)) {
        grain = decodePng(data, false);
        grainUuid = e.name.replace(/^grain_/i, '').replace(/\.png$/i, '');
      } else if (/^snapshot_light_.*\.png$/i.test(e.name)) snapshot = snapshot || decodePng(data);
      else if (/^snapshot_.*\.png$/i.test(e.name)) snapshot = snapshot || decodePng(data);
      else if (/^brush_.*\.info$/i.test(e.name)) {
        infoFiles.push({ uuid: e.name.replace(/^brush_/, '').replace(/\.info$/i, ''), data: data });
      }
    }
    /* 双笔刷的 .gobrush 里有两条 brush_*.info：主笔刷一条、副笔刷「<名>-副」一条，
       而 shape/grain 资源只属于主笔刷。以前是「后出现的覆盖前面的」——读出来的是副笔刷的
       属性块（75 条，主笔刷 119 条），连笔刷名都变成「-副」。
       现在按 shape（其次 grain）的 uuid 配对，配不上才退回第一条。 */
    const picked = infoFiles.filter(function (x) { return x.uuid === shapeUuid; })[0] ||
      infoFiles.filter(function (x) { return x.uuid === grainUuid; })[0] ||
      infoFiles[0] || null;
    if (picked) { infoFile = picked.data; brushUuid = picked.uuid; }
    let name = infoFile ? nameFromInfo(infoFile) : '';
    if (!name) name = (fileName || 'gobrush').replace(/\.[^.]+$/, '');
    const params = infoFile ? extractParams(infoFile) : { size: 0, spacing: 0 };
    const pressureCurves = infoFile ? extractPressureCurves(infoFile) : {global:null,parameters:{}};
    /* 属性/参数块的原始快照：写侧只能「透传它没有专门映射的属性」，没有这份快照就只能
       整块用模板（真实导出「调色刀」）的值覆盖掉源笔刷（原生样本 22~34/119 项被改）。 */
    const props = infoFile ? extractProps(infoFile) : { values: {}, meta: {}, curves: {}, block: null };
    const paramTags = infoFile ? extractParamTags(infoFile) : {};
    if (!shape) warnings.push('该 .gobrush 没有 shape PNG，转换时会生成程序化笔尖');
    warnings.push('天生会画尺寸按300dpi真机近似标定换算为像素（尺寸百分比会取整）；其他DPI、画布缩放和真实压感笔迹仍待核对，可用「整体尺寸倍数」微调');
    // Keep source pixels; logical brush diameter is independent of resolution.
    const tip = shape;
    // Empirical 300dpi calibration on MatePad MRDI-W10 / GoPaint 16.0.0.250:
    // 8/35/70 maximum at a 100% toolbar produced 20/82/162px solid strokes.
    // 2.3px per bound unit excludes the roughly 1-2px raster edge; this is
    // an approximation, not a documented cross-device physical unit.
    const maxSizePct = params.maxSizePct > 0 ? params.maxSizePct : 262;
    const minSizePct = params.minSizePct || 0;
    const sizePx = params.size >= 0 && params.size <= 100
      ? (minSizePct + (maxSizePct - minSizePct) * params.size / 100) * 2.3 : 100;
    let spacingPct = params.spacing >= 1 && params.spacing <= 1000 ? params.spacing : 25;
    let opacity = params.opacity === undefined ? 1 : Math.max(0, Math.min(1, params.opacity / 100));
    const brush = {
      name: name,
      gopaintUuid: brushUuid,
      tip: tip,
      grain: grain,
      sizePx: sizePx,
      gopaintMaxSizePct: params.maxSizePct,
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
      jitterPct: params.jitter === undefined ? 0 : params.jitter,
      falloffPct: params.falloff === undefined ? 0 : params.falloff,
      scatterCount: 1,
      scatterBothAxes: true,
      gopaintPressureCurve: pressureCurves.global || undefined,
      gopaintPressureCurves: pressureCurves.parameters,
      hasTexture: (params.textureDepth || 0) > 0,
      textureDepth: params.textureDepth || 0,
      gopaintGrainScale: params.grainScale,
      /* 第206轮 R204-01（作者：Claude）：天生会画纹理整张平铺的画布尺寸与 grain 图分辨率无关（32/64/128 px 三张
         同周期），只由 grainScale 决定：MatePad Pro 12.2 实测平铺边长 ≈ 0.576 × grainScale² 像素
         （5/25/50 → 周期 7/180/720 px，图内 2 个周期）。通用模型的 textureScale = 平铺画布像素 / 纹理像素宽
         （PS、画世界口径），据此反推；仅在有 grain 图与 grainScale 时给出。 */
      textureScale: (grain && grain.w > 0 && params.grainScale > 0)
        ? Math.round(GOPAINT_TILE_K * params.grainScale * params.grainScale / grain.w * 10000) / 10000 : undefined,
      /* 属性块全量（119 条自描述记录）。写侧 gobrushWrite 用它做「只透传未知、不覆盖已知」：
         gopaintProps   = {属性 key: 0x18 当前值}
         gopaintPropMeta= {属性 key: {type, group, min, max}}
         gopaintPropBlock = 原始记录流（模板里没有的属性要追加记录时用）
         gopaintParams  = {参数 tag: payload}
         gopaintPropBase= 写侧显式映射依赖的那几个字段在「刚解析完」时的值——写的时候拿它和
                          当前值比，就知道用户到底动没动这一项（不动就照抄源值，动了才按映射写）。 */
      gopaintProps: props.values,
      gopaintPropMeta: props.meta,
      gopaintPropCurves: props.curves,
      gopaintPropBlock: props.block || undefined,
      gopaintParams: paramTags,
      gopaintPropBase: {
        sizePx: sizePx,
        gopaintMaxSizePct: params.maxSizePct,
        minSizeRatio: (params.minSizeRatio !== undefined ? params.minSizeRatio : 1),
        minOpacityRatio: (params.minOpacityRatio !== undefined ? params.minOpacityRatio : 1),
        spacingPct: spacingPct,
        opacity: opacity,
        flowPct: (params.flowPct !== undefined ? params.flowPct : 1),
        scatterOn: (params.scatter || 0) > 0,
        scatterPct: params.scatter || 0,
        jitterPct: params.jitter === undefined ? 0 : params.jitter,
        falloffPct: params.falloff === undefined ? 0 : params.falloff,
        hasTexture: (params.textureDepth || 0) > 0,
        textureDepth: params.textureDepth || 0,
        gopaintGrainScale: params.grainScale,
        pressureCurve: pressureCurves.global ? JSON.stringify(pressureCurves.global) : null
      },
      source: 'gopaint'
    };
    /* 第2/3 步接线（压感组 / 锥度组 / 朝向组 / 混色湿边组）依赖的通用模型字段：
       一律照抄「刚解析完」的值——原生解析出来是常量（pressureSize=false、angle=0、
       roundness=100，taperOn / taperSize / smudgeOn / wetEdgesOn 这些根本没有），
       所以照抄 = 没动过；之后谁真改了这些字段（用户调面板 / 从别的格式转进来），
       写侧就按映射写。 */
    ['pressure', 'pressureSize', 'pressureOpacity', 'angle', 'roundness',
      'taperOn', 'taperSize', 'taperOpacity', 'taperStartLength', 'taperEndLength',
      'smudgeOn', 'smudgeAmount', 'smudgeSize', 'smudgeOpacity',
      'wetEdgesOn', 'wetEdgesAmount', 'burntEdgesAmount', 'smoothingStrength'
    ].forEach(function (k) { brush.gopaintPropBase[k] = brush[k]; });
    // 第303轮：记录原始笔尖/纹理指纹，供写侧判断参数改动时是否可原位改写 .info（保住 0xd0 原生资源与 UUID）
    brush._rawTipState = util.brushFingerprint({ tip: brush.tip });
    brush._rawGrainState = util.brushFingerprint({ grain: brush.grain });
    return { brush: brush, snapshot: snapshot, warnings: warnings };
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

  const api = { isGobrush, isGobrushSet, parse, extractProps, extractParamTags };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { gobrush: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
