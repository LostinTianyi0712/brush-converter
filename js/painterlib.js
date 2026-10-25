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
    return hasInner || (hasXml && hasNib);
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
        _painterPath: path
      }, params, { name: base, category: category, tip: tip }));
    }
    return {
      brushes: brushes,
      warnings: brushes.length ? [] : ['Painter 库里没有读到笔刷 XML']
    };
  }

  const api = { isLibraryZip, parseLibrary, parseXml, nibAlpha };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { painterlib: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
