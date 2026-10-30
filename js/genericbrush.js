/* Generic / heuristic brush readers for proprietary formats:
     - Corel Painter  .brushcategory / .brushlibrary (XML)
     - MediBang Paint .mdp (zip material; heuristic)
     - .ipcfg config (JSON / key=value; heuristic)
   These formats have no public spec, so the mapping is best-effort and every
   parse reports a warning asking for a sample to refine. */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const zip = isNode ? require('./zip.js') : root.BC.zip;
  const png = isNode ? require('./png.js') : root.BC.png;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function textOf(bytes) {
    return util.utf8Decode(bytes.subarray(0, Math.min(bytes.length, 4 * 1024 * 1024)));
  }

  function numFromString(s) {
    const m = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(String(s === undefined || s === null ? '' : s));
    return m ? parseFloat(m[0]) : NaN;
  }

  function makeBrush(name, sizePx, spacingPct, opacity, hardness, source) {
    return {
      name: name,
      tip: null,
      sizePx: clamp(sizePx || 40, 1, 4000),
      spacingPct: clamp(spacingPct || 25, 1, 1000),
      opacity: clamp(opacity === undefined ? 1 : opacity, 0, 1),
      hardness: clamp(hardness === undefined ? 0.8 : hardness, 0, 1),
      angle: 0,
      roundness: 100,
      pressure: false,
      pressureSize: false,
      minSizeRatio: 1,
      source: source
    };
  }

  /* ---------- Corel Painter brush category / library (XML) ---------- */
  function isPainterXml(bytes) {
    if (!bytes || bytes.length < 32) return false;
    const head = textOf(bytes.subarray(0, Math.min(bytes.length, 8192))).trim();
    if (head.charAt(0) !== '<') return false;
    if (!/brushcategory|brushlibrary|<Brush|<brush\b/i.test(head)) return false;
    return /Corel|painter|brushcategory|brushlibrary/i.test(head);
  }

  function parsePainter(bytes, fileName) {
    const warnings = ['Corel Painter 笔刷格式没有公开规范，本工具按 XML 启发式解析；如字段不准，请提供样例文件以精确映射'];
    const xml = textOf(bytes);
    const base = (fileName || 'painter').replace(/\.[^.]+$/, '');
    const brushes = [];
    // try to find per-brush blocks
    const blockRe = /<(brush|brushvariant|variant)\b[^>]*>[\s\S]*?<\/\1>|<(brush|brushvariant|variant)\b[^>]*\/>/gi;
    let m;
    while ((m = blockRe.exec(xml))) {
      const block = m[0];
      if (brushes.length >= 500) break;
      const nameM = /name="([^"]*)"/i.exec(block) || /<name>([^<]*)<\/name>/i.exec(block);
      const name = nameM ? nameM[1] : (base + '-' + (brushes.length + 1));
      const sizeM = /(?:size|diameter|width)="?(-?\d+(?:\.\d+)?)/i.exec(block) || /<(?:size|diameter)>(-?\d+(?:\.\d+)?)</i.exec(block);
      const spaceM = /spacing="?(-?\d+(?:\.\d+)?)/i.exec(block);
      const opM = /opacity="?(-?\d+(?:\.\d+)?)/i.exec(block);
      const hardM = /(?:hardness|grain)="?(-?\d+(?:\.\d+)?)/i.exec(block);
      const brush = makeBrush(name, sizeM ? numFromString(sizeM[1]) : 40, spaceM ? numFromString(spaceM[1]) : 25,
        opM ? numFromString(opM[1]) / 100 : 1, hardM ? numFromString(hardM[1]) / 100 : 0.8, 'painter');
      brushes.push(brush);
    }
    if (!brushes.length) {
      const sizeM = /(?:size|diameter|width)="?(-?\d+(?:\.\d+)?)/i.exec(xml);
      const spaceM = /spacing="?(-?\d+(?:\.\d+)?)/i.exec(xml);
      const opM = /opacity="?(-?\d+(?:\.\d+)?)/i.exec(xml);
      brushes.push(makeBrush(base, sizeM ? numFromString(sizeM[1]) : 40, spaceM ? numFromString(spaceM[1]) : 25,
        opM ? numFromString(opM[1]) / 100 : 1, 0.8, 'painter'));
      warnings.push('未找到单独的笔刷节点，已把整个文件当作 1 支笔刷处理');
    }
    return { brushes: brushes, warnings: warnings };
  }

  /* ---------- MediBang Paint material (.mdp, heuristic) ---------- */
  function isMdp(bytes, fileName) {
    if (!bytes || !zip.isZip(bytes)) return false;
    try {
      const entries = zip.read(bytes);
      if (!entries.length) return false;
      if (entries.some(e => /(^|\/)Brush\.archive$/i.test(e.name))) return false; // Procreate
      if (entries.some(e => /^paintoppresets\/[^/]+\.kpp$/i.test(e.name))) return false; // Krita bundle
      const hasTip = entries.some(e => /\.(png|webp|jpg|jpeg)$/i.test(e.name) && !e.dir);
      const hasCfg = entries.some(e => /\.(json|xml|plist|ini|txt)$/i.test(e.name) && !e.dir);
      const hasMdp = entries.some(e => /\.mdp$/i.test(e.name) && !e.dir);
      if (hasMdp) return true;
      // require an explicit .mdp name or brush-ish entry names to avoid eating generic zips
      const named = /\.mdp$/i.test(fileName || '') ||
        entries.some(e => !e.dir && /brush|pen|material|setting/i.test(e.name));
      return hasTip && hasCfg && named;
    } catch (e) {
      return false;
    }
  }

  function parseMdp(bytes, fileName) {
    const warnings = ['MediBang/MDP 材质没有公开规范，本工具按 zip 内容启发式解析；请提供样例以精确映射'];
    const entries = zip.read(bytes);
    const base = (fileName || 'medibang').replace(/\.[^.]+$/, '');
    const tips = [];
    for (const e of entries) {
      if (e.dir) continue;
      if (!/\.(png|webp|jpg|jpeg)$/i.test(e.name)) continue;
      if (/thumb|preview|icon/i.test(e.name)) continue;
      const data = e.data();
      if (data.length < 64) continue;
      try {
        if (!png.isPng(data)) continue; // keep to PNG tips for now
        const img = png.decode(data);
        tips.push({ name: e.name.split('/').pop().replace(/\.[^.]+$/, ''), tip: { w: img.width, h: img.height, rgba: png.toMaskRgba(img.rgba) } });
      } catch (err) { /* skip */ }
      if (tips.length >= 64) break;
    }
    if (!tips.length) {
      warnings.push('压缩包内没有找到 PNG 笔尖，无法导入');
      return { brushes: [], warnings: warnings };
    }
    const brushes = tips.map((t, i) => {
      const b = makeBrush(tips.length === 1 ? base : t.name, Math.max(t.tip.w, t.tip.h), 25, 1, 0.8, 'medibang');
      b.tip = t.tip;
      return b;
    });
    return { brushes: brushes, warnings: warnings };
  }

  /* ---------- .ipcfg (heuristic: JSON or key=value config) ---------- */
  function isIpcfg(bytes, fileName) {
    if (fileName && /\.ipcfg$/i.test(fileName)) return true;
    if (!bytes || bytes.length < 8) return false;
    const head = textOf(bytes.subarray(0, Math.min(bytes.length, 4096))).trim();
    if (!head) return false;
    if (head.charAt(0) === '{') {
      return /"(name|size|width|spacing|opacity|hardness|brush|tip)/i.test(head);
    }
    return /^[\w.\- ]+\s*=/m.test(head) && /(size|spacing|opacity|hardness|brush)/i.test(head);
  }

  function parseIpcfg(bytes, fileName) {
    const warnings = ['.ipcfg 没有公开规范，本工具按 JSON / key=value 启发式解析；请提供样例以精确映射'];
    const text = util.utf8Decode(bytes);
    const base = (fileName || 'ipcfg').replace(/\.[^.]+$/, '');
    const map = {};
    const trimmed = text.trim();
    if (trimmed.charAt(0) === '{') {
      let doc;
      try { doc = JSON.parse(text); } catch (e) { throw new Error('.ipcfg JSON 解析失败：' + e.message); }
      const walk = (obj, prefix) => {
        if (!obj || typeof obj !== 'object') return;
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v, prefix + k + '/'); continue; }
          map[prefix + k] = v;
        }
      };
      walk(doc, '');
    } else {
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*([^=:#]+)\s*[=:]\s*(.+?)\s*$/.exec(line);
        if (m) map[m[1].trim()] = m[2].trim();
      }
    }
    const find = (patterns) => {
      for (const key of Object.keys(map)) {
        for (const pat of patterns) if (pat.test(key)) return map[key];
      }
      return undefined;
    };
    const nameVal = find([/^name$/i, /brush.*name/i, /^title$/i]);
    const size = numFromString(find([/size/i, /diameter/i, /radius/i, /width/i]));
    const spacing = numFromString(find([/spacing/i, /interval/i]));
    const opacity = numFromString(find([/opacity/i, /alpha/i]));
    const hardness = numFromString(find([/hardness/i, /softness/i]));
    const roundness = numFromString(find([/roundness/i, /ratio/i]));
    const angle = numFromString(find([/angle/i, /rotation/i]));
    const b = makeBrush(typeof nameVal === 'string' ? nameVal : base,
      isFinite(size) ? size : 40,
      isFinite(spacing) ? spacing : 25,
      isFinite(opacity) ? (opacity > 1.5 ? opacity / 100 : opacity) : 1,
      isFinite(hardness) ? (hardness > 1.5 ? hardness / 100 : hardness) : 0.8, 'ipcfg');
    if (isFinite(roundness)) b.roundness = map.format === 'brushconv.ipcfg'
      ? clamp(roundness, 0, 100)
      : clamp(roundness > 1.5 ? roundness / 100 : roundness, 0.05, 1) * 100;
    if (isFinite(angle)) b.angle = angle;
    warnings.push('已识别字段：' + Object.keys(map).slice(0, 12).join(', '));
    return { brushes: [b], warnings: warnings };
  }

  /* ---------- heuristic writers ---------- */
  function esc(s) { return String(s || '').replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); }

  function writePainter(brushes, categoryName) {
    const parts = ['<?xml version="1.0"?>', '<brushcategory name="' + esc(categoryName || 'BrushConv') + '" version="1">'];
    for (const b of brushes) {
      parts.push('  <brush name="' + esc(b.name) + '" size="' + Math.round(b.sizePx || 40) + '" spacing="' + Math.round(b.spacingPct || 25)
        + '" opacity="' + Math.round((b.opacity === undefined ? 1 : b.opacity) * 100) + '" hardness="' + Math.round((b.hardness === undefined ? 0.8 : b.hardness) * 100) + '"/>');
    }
    parts.push('</brushcategory>');
    return util.utf8Encode(parts.join('\n'));
  }

  function writeMdp(brushes, packName) {
    const z = isNode ? require('./zip.js') : root.BC.zip;
    const files = [];
    const json = { name: packName || 'BrushConv', type: 'brushconv.medibang', brushes: brushes.map(function (b) {
      return { name: b.name, size: Math.round(b.sizePx || 40), spacing: Math.round(b.spacingPct || 25),
        opacity: b.opacity === undefined ? 1 : b.opacity, hardness: b.hardness === undefined ? 0.8 : b.hardness };
    }) };
    files.push({ name: 'brushes/setting.json', data: util.utf8Encode(JSON.stringify(json, null, 2)) });
    let tipCount = 0;
    brushes.forEach(function (b, i) {
      if (!b.tip || !b.tip.rgba) return;
      tipCount++;
      files.push({ name: 'brushes/tip_' + i + '.png', data: png.encode(b.tip.w, b.tip.h, b.tip.rgba) });
      if (i === 0) files.push({ name: 'brushes/thumb.png', data: png.encode(b.tip.w, b.tip.h, b.tip.rgba) });
    });
    // setting.json 总会入列，不能用 files.length 判断；没有任何笔尖时应当报错而不是产出空 .mdp
    if (!tipCount) throw new Error('没有可写入 MDP 的笔尖图像数据');
    return z.write(files);
  }

  function writeIpcfg(brush) {
    const doc = {
      format: 'brushconv.ipcfg',
      name: brush.name || 'brush',
      size: Math.round(brush.sizePx || 40),
      spacing: Math.round(brush.spacingPct || 25),
      opacity: brush.opacity === undefined ? 1 : Number(brush.opacity.toFixed(3)),
      hardness: brush.hardness === undefined ? 0.8 : Number(brush.hardness.toFixed(3)),
      roundness: brush.roundness === undefined ? 100 : Math.round(brush.roundness),
      angle: brush.angle || 0,
      pressure: !!brush.pressure
    };
    return util.utf8Encode(JSON.stringify(doc, null, 2));
  }

  const api = { isPainterXml, parsePainter, isMdp, parseMdp, isIpcfg, parseIpcfg, writePainter, writeMdp, writeIpcfg };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { genericBrush: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
