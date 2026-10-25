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
    const m = attrs.match(new RegExp(name + '="([^"]*)"'));
    return m ? m[1] : undefined;
  }
  function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }

  function nibAlpha(bytes) {
    let img;
    try { img = jpeg.decode(bytes); } catch (e) { return null; }
    const w = img.width, h = img.height, n = w * h;
    const rgba = new Uint8Array(n * 4);
    // 背景色取左上角，dab 是比背景更暗的像素
    const bg = (img.rgba[0] + img.rgba[1] + img.rgba[2]) / 3;
    const scale = bg > 8 ? 255 / bg : 1;
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
      opacity: Math.max(0.01, Math.min(1, opacity)),
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
      brushes.push(Object.assign({
        name: base,
        category: category,
        tip: tip,
        source: 'painter',
        _painterPath: path,
        _painterRaw: { xml: files[path], nib: files[nibPath] || null, category: category }
      }, params, { name: base, category: category, tip: tip }));
    }
    return {
      brushes: brushes,
      warnings: brushes.length ? [] : ['Painter 库里没有读到笔刷 XML']
    };
  }

  /* 生成 Painter 真实结构的笔刷 XML（subset；nib 无法凭空生成，写入时附 PNG 素材） */
  function brushXml(brush) {
    const radius = Math.max(1, (brush.sizePx || 40) / 2);
    const minFrac = brush.minSizeRatio === undefined ? 1 : brush.minSizeRatio;
    const advance = Math.max(0.01, (brush.spacingPct || 25) / 100);
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
    const readme = ['Corel Painter 笔刷分类（brushconv 生成）', '', '把整个 zip 改名为 .brushcategory 后拖进 Painter 窗口导入。', '注意：Painter 的笔尖必须是 .nib(JPEG)，这里无法生成 nib，所以每支笔刷附带了 PNG 笔尖素材；', '如果导入后笔尖是默认圆点，请用对应 PNG 在 Painter 里手动替换笔尖。', ''].join(String.fromCharCode(13, 10));
    files.push({ name: '说明.txt', data: util.utf8Encode(readme) });
    brushes.forEach(function (b, i) {
      const nm = String(b.name || ('brush' + (i + 1))).replace(/[\/:*?"<>|]/g, '_');
      const dir = (i + 1) + ' ' + cat;
      const raw = b._painterRaw;
      if (raw && raw.xml && raw.nib) {
        // 来自 Painter 库：直接复用原 XML + nib，往返无损
        files.push({ name: dir + '/' + nm + '.xml', data: raw.xml });
        files.push({ name: dir + '/' + nm + '.nib', data: raw.nib });
      } else {
        files.push({ name: dir + '/' + nm + '.xml', data: util.utf8Encode(brushXml(b)) });
        const nib = nibFromTip(b.tip, 30);
        if (nib) files.push({ name: dir + '/' + nm + '.nib', data: nib.bytes });
        else if (b.tip && b.tip.rgba) {
          const img = { w: b.tip.w, h: b.tip.h, rgba: b.tip.rgba };
          files.push({ name: dir + '/' + nm + '_tip.png', data: pngMod.encode(img.w, img.h, img.rgba) });
        }
      }
    });
    return zipMod.write(files);
  }

  const api = { isLibraryZip, parseLibrary, parseXml, nibAlpha, writeLibrary, brushXml, nibFromTip };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { painterlib: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
