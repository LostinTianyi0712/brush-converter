/* Corel Painter 笔刷库（.brushlibrary / .brushcategory）读取
 *  - 本质是 ZIP：<序号 分类>/<笔刷>.{xml,nib,stk}
 *  - .xml 是完整参数（radius / min-radius-fraction / advance / opacity / flow / base-angle / thinness / random-size …）
 *  - .nib 是小尺寸 JPEG（暗色 dab 画在浅灰底），反相取 alpha 得到笔尖
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const zip = isNode ? require('./zip.js') : root.BC.zip;
  const jpeg = isNode ? require('./jpeg.js') : root.BC.jpeg;

  function isLibraryZip(bytes) {
    if (!zip.isZip(bytes)) return false;
    let entries;
    try { entries = zip.read(bytes); } catch (e) { return false; }
    const hasInner = entries.some(function (e) { return /\.(brushlibrary|brushcategory)$/i.test(e.name); });
    const hasXml = entries.some(function (e) { return /\.xml$/i.test(e.name); });
    const hasNib = entries.some(function (e) { return /\.nib$/i.test(e.name); });
    return hasInner || hasXml || hasNib;
  }

  function attr(attrs, name) {
    const m = attrs.match(new RegExp('(?:^|\\s)' + name + '="([^"]*)"'));
    return m ? m[1] : undefined;
  }
  function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }

  function nibAlpha(bytes) {
    let img;
    try { img = jpeg.decode(bytes); } catch (e) { return null; }
    const w = img.width, h = img.height, n = w * h;
    const rgba = new Uint8Array(n * 4);
    // 背景色取全图最大亮度：某些 nib 的角落就是深色 dab（实心/满覆盖纹理），
    // 取 (0,0) 会把整张笔尖清零。全图最大值对绝大多数 nib 与原行为一致
    // （David Gell 573 支实测平均差 0.9/255，仅 2 支从全零恢复动态范围）。
    let bg = 0;
    for (let i = 0; i < n; i++) {
      const lum = (img.rgba[i * 4] + img.rgba[i * 4 + 1] + img.rgba[i * 4 + 2]) / 3;
      if (lum > bg) bg = lum;
    }
    // A fully opaque black dab may cover every pixel: there is no background
    // sample in that NIB. The generated NIB convention uses a 220-gray backing.
    if (bg <= 8) bg = 220;
    const scale = 255 / bg;
    for (let i = 0; i < n; i++) {
      const lum = (img.rgba[i * 4] + img.rgba[i * 4 + 1] + img.rgba[i * 4 + 2]) / 3;
      const a = Math.max(0, Math.min(255, Math.round((bg - lum) * scale)));
      rgba[i * 4] = 0; rgba[i * 4 + 1] = 0; rgba[i * 4 + 2] = 0; rgba[i * 4 + 3] = a;
    }
    return { w: w, h: h, rgba: rgba };
  }

  function parseXml(xml, categories) {
    const x = String(xml);
    const cat = attr(x, 'variant-name') || '';
    const radius = num(attr(x, 'radius'), 8);
    const minFrac = num(attr(x, 'min-radius-fraction'), 1);
    const advance = num(attr(x, 'advance'), 0.1);
    const opacity = num(attr(x, 'opacity'), 1);
    const flow = num(attr(x, 'flow'), 100);
    const angle = num(attr(x, 'base-angle'), 0);
    const thinness = num(attr(x, 'thinness'), 1);
    const spread = num(attr(x, 'spread'), 1);
    const jitter = num(attr(x, 'jitter'), 0);
    const randomSize = num(attr(x, 'random-size'), 0);
    const hardness = num(attr(x, 'hardness'), 1);
    const smoothing = num(attr(x, 'smoothing'), 1);
    const grain = num(attr(x, 'grain'), 0);
    const wetness = num(attr(x, 'wetness'), 0);
    const sizePx = Math.max(2, Math.min(3000, radius * 2));
    return {
      sizePx: Math.round(sizePx),
      spacingPct: Math.max(1, Math.min(1000, Math.round(advance * 100 * 10) / 10)),
      opacity: Math.max(0, Math.min(1, opacity)),
      flowPct: Math.max(0.01, Math.min(1, flow > 1 ? flow / 400 : flow)),
      minSizeRatio: Math.max(0, Math.min(1, minFrac)),
      minOpacityRatio: 0,
      angle: angle,
      roundness: Math.max(1, Math.min(100, Math.round(thinness * 100))),
      hardness: Math.max(0, Math.min(1, hardness)),
      sizeJitterPct: Math.max(0, Math.min(200, Math.round(randomSize * 100))),
      scatterPct: Math.max(0, Math.min(1000, Math.round(jitter * 100))),
      scatterOn: jitter > 0.01,
      smoothingStrength: Math.max(0, Math.min(1, smoothing / 2)),
      hasTexture: grain > 0.01,
      textureDepth: Math.max(0, Math.min(1, grain)),
      wetEdgesOn: wetness > 0.5,
      pressureSize: minFrac < 0.99,
      spread: spread,
      _painterVariant: cat
    };
  }

  function parseLibrary(bytes, fileName) {
    let z = bytes;
    let entries = zip.read(z);
    // 外层 ZIP 里套 .brushlibrary
    const innerEntry = entries.find(function (e) { return /\.(brushlibrary|brushcategory)$/i.test(e.name); });
    if (innerEntry) {
      z = innerEntry.data();
      entries = zip.read(z);
    }
    const files = {};
    for (const e of entries) if (!e.dir) files[e.name] = e.data();
    const brushes = [];
    const names = Object.keys(files).filter(function (n) { return /\.xml$/i.test(n); });
    for (const path of names) {
      const base = path.replace(/^.*\//, '').replace(/\.xml$/i, '');
      const dir = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';
      const category = dir.replace(/^\d+\s*/, '') || 'Painter';
      let params;
      try { params = parseXml(util.utf8Decode(files[path]), null); } catch (e) { continue; }
      const nibPath = path.replace(/\.xml$/i, '.nib');
      let tip = null;
      if (files[nibPath]) tip = nibAlpha(files[nibPath]);
      const one = Object.assign({
        name: base,
        category: category,
        tip: tip,
        source: 'painter',
        _painterPath: path,
        _painterRaw: { xml: files[path], nib: files[nibPath] || null, category: category }
      }, params, { name: base, category: category, tip: tip });
      /* 【minor-fix】convert.makePainter 在「参数被改过」时会显式清掉 _painterRaw
         （否则原 XML 会把编辑吞掉），于是写侧只能退回 brushXml 骨架——
         除本工具映射的 12 个属性外，delta-angle / spread / bristle-fraction /
         min-grain / max-grain / wet / merge-mode / stroke-opacity / damping
         以及引擎私有子元素全部被写常量砸掉（实测改一项参数 17/40 失真）。
         这里把「原始 XML 文本 + NIB 字节」另存一份下划线字段（fingerprint 不计入），
         写侧就能在原 XML 上做属性级 patch，而不是整块重建。 */
      one._painterXml = files[path];
      one._painterNib = files[nibPath] || null;
      one._painterNibTipState = tip ? util.brushFingerprint({ tip: tip }) : null;
      brushes.push(one);
    }
    brushes.forEach(function (b) { b._rawBrushState = util.brushFingerprint(b); });
    return {
      brushes: brushes,
      warnings: brushes.length ? [] : ['Painter 库里没有读到笔刷 XML']
    };
  }

  /* 生成 Painter 真实结构的笔刷 XML（subset；nib 无法凭空生成，写入时附 PNG 素材） */
  function brushXml(brush) {
    const radius = Math.max(1, (brush.sizePx || 40) / 2);
    const minFrac = brush.minSizeRatio === undefined ? 1 : brush.minSizeRatio;
    const advance = Math.max(0.01, (brush.spacingPct === undefined ? 25 : brush.spacingPct) / 100);
    const opacity = brush.opacity === undefined ? 1 : brush.opacity;
    const flow = (brush.flowPct === undefined ? 1 : brush.flowPct) * 400;
    const angle = brush.angle || 0;
    const thin = (brush.roundness === undefined ? 100 : brush.roundness) / 100;
    const hardness = brush.hardness === undefined ? 1 : brush.hardness;
    const grain = brush.textureDepth === undefined ? 0 : brush.textureDepth;
    const randSize = (brush.sizeJitterPct || 0) / 100;
    const jitter = (brush.scatterPct || 0) / 100;
    const NL = String.fromCharCode(10);
    const a = function (k, v) { return '		' + k + '="' + v + '"'; };
    return [
      '<?xml version="1.0"?>',
      '<!-- Painter Brush Definition (generated by brushconv) -->',
      '<painter-brush-definition>',
      '	<format-control-parameters substitution-table="-1" substitution-index="-1" version-number="10.0" variant-name="' + esc(brush.name || 'brush') + '">',
      '	</format-control-parameters>',
      '	<brush-type-parameters dab-type="Circular" dab-flags="NewFormat" brush-source="Color" stroke-type="Single" pen-type="Drop" behavior-flags="' + (grain > 0 ? 'Grain' : '') + '" pen-control-flags="">',
      '	</brush-type-parameters>',
      '	<physical-brush-parameters',
      a('radius', radius.toFixed(2)),
      a('min-radius-fraction', minFrac.toFixed(3)),
      a('radius-log', '1.05'),
      a('base-angle', angle.toFixed(1)),
      a('delta-angle', '0.0'),
      a('thinness', thin.toFixed(2)),
      a('spread', '1.0'),
      a('bristle-fraction', '0.5'),
      a('random-size', randSize.toFixed(2)),
      a('hardness', hardness.toFixed(2)),
      '		dab-opacity="' + opacity.toFixed(2) + '">',
      '	</physical-brush-parameters>',
      '	<dab-application-parameters',
      '		opacity="' + opacity.toFixed(2) + '"',
      '		grain="' + grain.toFixed(2) + '"',
      '		min-grain="0.0" max-grain="1.0"',
      '		smoothing="1.0"',
      '		wet="False"',
      '		merge-mode="0" stroke-opacity="1.0">',
      '	</dab-application-parameters>',
      '	<stroke-path-parameters',
      '		advance="' + advance.toFixed(3) + '"',
      '		flow="' + flow.toFixed(1) + '"',
      '		jitter="' + jitter.toFixed(2) + '"',
      '		damping="0.5">',
      '	</stroke-path-parameters>',
      '</painter-brush-definition>'
    ].join(NL);
  }

  function esc(x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

  /* 在指定元素的开始标签内改一个属性。value 未变（数值在 1e-9 相对误差内相等）
     时保持原文本一字不动——这样「没改参数的往返」仍然是逐字节一致的。 */
  function patchAttr(xml, element, attrName, current, encoded) {
    const re = new RegExp('<' + element + '\\b([^>]*)>');
    const m = re.exec(xml);
    if (!m) return xml;
    let attrs = m[1];
    const ar = new RegExp('(^|[\\s])' + attrName + '="([^"]*)"');
    const am = ar.exec(attrs);
    if (am) {
      const was = current === null ? null : Number(am[2]);
      const same = current === null
        ? am[2] === encoded
        : (isFinite(was) && Math.abs(was - current) <= Math.max(1e-9, Math.abs(current) * 1e-9));
      if (same) return xml;
      attrs = attrs.slice(0, am.index) + am[1] + attrName + '="' + encoded + '"' + attrs.slice(am.index + am[0].length);
    } else {
      attrs = attrs + ' ' + attrName + '="' + encoded + '"';
    }
    return xml.slice(0, m.index) + '<' + element + attrs + '>' + xml.slice(m.index + m[0].length);
  }

  /* 把通用笔刷模型「回写」进原始 Painter XML：
     只动本工具真正映射的属性，控件/引擎私有属性与子元素原样保留；
     某个属性在源 XML 里不存在时补在对应元素上，不新建元素。 */
  function patchPainterXml(xmlText, brush) {
    let xml = String(xmlText);
    const radius = Math.max(0.5, (brush.sizePx || 40) / 2);
    const minFrac = brush.minSizeRatio === undefined ? 1 : brush.minSizeRatio;
    const angle = brush.angle || 0;
    const thin = (brush.roundness === undefined ? 100 : brush.roundness) / 100;
    const hardness = brush.hardness === undefined ? 1 : brush.hardness;
    const grain = brush.textureDepth === undefined ? 0 : brush.textureDepth;
    const randSize = (brush.sizeJitterPct || 0) / 100;
    const jitter = (brush.scatterPct || 0) / 100;
    const opacity = brush.opacity === undefined ? 1 : brush.opacity;
    const advance = Math.max(0.01, (brush.spacingPct === undefined ? 25 : brush.spacingPct) / 100);
    const flow = (brush.flowPct === undefined ? 1 : brush.flowPct) * 400;
    /* variant-name 是 Painter 的「变体/分类名」，不是笔刷名（笔刷名就是文件名）。
       原 XML 里它多半是 Airbrushes 这类分类值，patch 它会平白改掉源语义，
       所以这里不动它；画笔改名的落点是文件名（writeLibrary 的 dir/nm）。 */
    xml = patchAttr(xml, 'physical-brush-parameters', 'radius', radius, radius.toFixed(2));
    xml = patchAttr(xml, 'physical-brush-parameters', 'min-radius-fraction', minFrac, minFrac.toFixed(3));
    xml = patchAttr(xml, 'physical-brush-parameters', 'base-angle', angle, angle.toFixed(1));
    xml = patchAttr(xml, 'physical-brush-parameters', 'thinness', thin, thin.toFixed(2));
    xml = patchAttr(xml, 'physical-brush-parameters', 'random-size', randSize, randSize.toFixed(2));
    xml = patchAttr(xml, 'physical-brush-parameters', 'hardness', hardness, hardness.toFixed(2));
    xml = patchAttr(xml, 'dab-application-parameters', 'opacity', opacity, opacity.toFixed(2));
    xml = patchAttr(xml, 'dab-application-parameters', 'grain', grain, grain.toFixed(2));
    xml = patchAttr(xml, 'stroke-path-parameters', 'advance', advance, advance.toFixed(3));
    xml = patchAttr(xml, 'stroke-path-parameters', 'flow', brush.flowPct === undefined ? null : flow / 400, flow.toFixed(1));
    xml = patchAttr(xml, 'stroke-path-parameters', 'jitter', jitter, jitter.toFixed(2));
    return xml;
  }

  /* 把笔尖 alpha 画成 Painter nib 约定：浅灰底 + 深色 dab，再编码成 JPEG */
  function nibFromTip(tip, size) {
    let jpegEncode;
    try { jpegEncode = isNode ? require('./jpegEncode.js') : root.BC.jpegEncode; } catch (e) { return null; }
    if (!jpegEncode || !tip || !tip.rgba) return null;
    const n = size || 30;
    const rgba = new Uint8Array(n * n * 4);
    const src = tip.rgba, sw = tip.w, sh = tip.h;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const sx = Math.min(sw - 1, Math.floor(x * sw / n));
        const sy = Math.min(sh - 1, Math.floor(y * sh / n));
        const a = src[(sy * sw + sx) * 4 + 3] / 255;
        const v = Math.round(220 - 220 * a);
        const o = (y * n + x) * 4;
        rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
      }
    }
    try { return { w: n, h: n, bytes: jpegEncode.encode(n, n, rgba, 60) }; } catch (e) { return null; }
  }

  function writeLibrary(brushes, categoryName) {
    const zipMod = isNode ? require('./zip.js') : root.BC.zip;
    const pngMod = isNode ? require('./png.js') : root.BC.png;
    const cat = String(categoryName || 'BrushConv').replace(/[\/:*?"<>|]/g, '_');
    const files = [];
    const readme = ['Corel Painter 笔刷分类（brushconv 生成）', '', '把整个 zip 改名为 .brushcategory 后拖进 Painter 窗口导入。', '说明：本包内每支笔刷都带 .xml 和 .nib（JPEG 笔尖），来自 Painter 的笔刷会原样复用原始 nib（无损）。', ''].join(String.fromCharCode(13, 10));
    files.push({ name: '说明.txt', data: util.utf8Encode(readme) });
    brushes.forEach(function (b, i) {
      const nm = String(b.name || ('brush' + (i + 1))).replace(/[\/:*?"<>|]/g, '_');
      const dir = (i + 1) + ' ' + cat;
      const raw = b._painterRaw;
      /* 源 XML 有三个来源，优先级从高到低：
         ① _painterRaw（未改参数，convert 保留）→ 原样复用；
         ② _painterXml（改过参数，convert 会清掉 ①）→ 在原 XML 上做属性级 patch；
         ③ 无源（外来笔刷）→ brushXml 骨架。 */
      const srcXml = (raw && raw.xml) || b._painterXml || null;
      if (srcXml) {
        const xmlOut = (raw && raw.xml && raw.nib)
          ? raw.xml                                   // ① 逐字节原样
          : util.utf8Encode(patchPainterXml(util.utf8Decode(srcXml), b));
        files.push({ name: dir + '/' + nm + '.xml', data: xmlOut });
        /* NIB 也尽量保原字节：笔尖像素没变（指纹一致）时没必要重新 JPEG 压一遍。 */
        const tipState = b.tip ? util.brushFingerprint({ tip: b.tip }) : null;
        const keepNib = (raw && raw.nib) ||
          (b._painterNib && b._painterNibTipState && tipState === b._painterNibTipState ? b._painterNib : null);
        if (keepNib) { files.push({ name: dir + '/' + nm + '.nib', data: keepNib }); return; }
        const tn0 = b.tip ? Math.max(b.tip.w || 0, b.tip.h || 0) : 0;
        const nib0 = nibFromTip(b.tip, tn0 >= 96 ? 50 : 30);
        if (nib0) files.push({ name: dir + '/' + nm + '.nib', data: nib0.bytes });
        else if (b.tip && b.tip.rgba) {
          const img = { w: b.tip.w, h: b.tip.h, rgba: b.tip.rgba };
          files.push({ name: dir + '/' + nm + '_tip.png', data: pngMod.encode(img.w, img.h, img.rgba) });
        }
        return;
      }
      files.push({ name: dir + '/' + nm + '.xml', data: util.utf8Encode(brushXml(b)) });
      const tn = b.tip ? Math.max(b.tip.w || 0, b.tip.h || 0) : 0;
      const nib = nibFromTip(b.tip, tn >= 96 ? 50 : 30);
      if (nib) files.push({ name: dir + '/' + nm + '.nib', data: nib.bytes });
      else if (b.tip && b.tip.rgba) {
        const img = { w: b.tip.w, h: b.tip.h, rgba: b.tip.rgba };
        files.push({ name: dir + '/' + nm + '_tip.png', data: pngMod.encode(img.w, img.h, img.rgba) });
      }
    });
    return zipMod.write(files);
  }

  const api = { isLibraryZip, parseLibrary, parseXml, nibAlpha, writeLibrary, brushXml, nibFromTip, patchPainterXml };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { painterlib: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
