/* MediBang 云笔刷（Brush2.ini + brush_bitmap + brush_script）读写
 * 真实格式来自本机云笔刷缓存：Brush2.ini 是 INI 文本，[0]、[1]… 每节一支笔；
 * bitmap 类型用 bitmapFile=xxx.png（放在 brush_bitmap/），program 类型用 script=xxx.bs。
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const zip = isNode ? require('./zip.js') : root.BC.zip;
  const png = isNode ? require('./png.js') : root.BC.png;

  function isIni(bytes) {
    if (!bytes || bytes.length < 32) return false;
    const head = util.utf8Decode(bytes.subarray(0, 64));
    return /^\s*\[General\]/i.test(head) && /activeIndex/i.test(util.utf8Decode(bytes.subarray(0, 512)));
  }

  function iniLines(text) {
    return String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  }

  /* 解析 Brush2.ini -> 原始条目（含 bitmapFile/script） */
  function parseIniEntries(text) {
    const lines = iniLines(text);
    const entries = [];
    let cur = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.charAt(0) === ';') continue;
      const m = line.match(/^\[([^\]]+)\]$/);
      if (m) {
        const key = m[1];
        if (/^\d+$/.test(key)) {
          cur = { index: Number(key) };
          entries.push(cur);
        } else {
          cur = null;
        }
        continue;
      }
      if (!cur) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      cur[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return entries;
  }

  function decodeBitmap(files, name) {
    if (!files || !name) return null;
    const cand = files[name] || files['brush_bitmap/' + name] || files['brush_bitmap\\' + name];
    if (!cand) return null;
    try {
      if (png.isPng(cand)) {
        const img = png.decode(cand);
        return { w: img.width, h: img.height, rgba: png.toMaskRgba(img.rgba) };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }

  /* Brush2.ini -> 笔刷列表（files: 文件名->Uint8Array，用于 bitmap 类型） */
  function parseIni(text, files, fileName) {
    const entries = parseIniEntries(text);
    const brushes = [];
    for (const e of entries) {
      const width = Math.max(1, Math.min(5000, num(e.width, 10)));
      const minW = Math.max(0, Math.min(width, num(e.min, 0)));
      const opacity = Math.max(0.01, Math.min(1, num(e.opacity, 1)));
      const type = (e.type || 'program').toLowerCase();
      const isBitmap = type.indexOf('bitmap') === 0;
      let tip = null;
      if (isBitmap && e.bitmapFile) tip = decodeBitmap(files, e.bitmapFile);
      const minRatio = width > 0 ? Math.max(0, Math.min(1, minW / width)) : 0;
      brushes.push({
        name: e.name || ('MediBang ' + (e.index + 1)),
        tip: tip,
        sizePx: Math.round(width),
        spacingPct: isBitmap ? 100 : 15,
        opacity: opacity,
        minSizeRatio: minRatio,
        minOpacityRatio: 0,
        pressureSize: String(e.pSize).toLowerCase() !== 'false',
        pressureOpacity: String(e.pAlpha).toLowerCase() === 'true',
        hardness: 1,
        angle: 0,
        roundness: 100,
        hasTexture: !!tip,
        _medibang: {
          index: e.index, type: e.type || 'program', script: e.script || null,
          option: e.option, option2: e.option2, option3: e.option3, option4: e.option4, option5: e.option5,
          bitmapFile: e.bitmapFile || null, iriNuki: String(e.iriNuki).toLowerCase() === 'true'
        },
        source: 'medibang'
      });
    }
    return { brushes: brushes, warnings: brushes.length ? [] : ['Brush2.ini 里没有读到笔刷条目'] };
  }

  function sanitize(name) {
    return String(name || 'brush').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 40) || 'brush';
  }

  /* 笔刷列表 -> MediBang 云笔刷包（Brush2.ini + brush_bitmap/*.png）
     解压后把内容复制到 %LOCALAPPDATA%\Medibang\CloudAlpaca 即可被识别 */
  function writeIniPack(brushList, opts) {
    opts = opts || {};
    const lines = ['[General]', 'activeIndex=0', 'version=1', ''];
    const images = [];
    let idx = 0;
    for (const b of (brushList || [])) {
      const name = sanitize(b.name || ('brush ' + (idx + 1)));
      const size = Math.max(1, Math.min(5000, Math.round(b.sizePx || 30)));
      const min = Math.max(0, Math.min(size, Math.round(size * (b.minSizeRatio === undefined ? 0 : b.minSizeRatio))));
      const opacity = Math.max(0.01, Math.min(1, b.opacity === undefined ? 1 : b.opacity));
      const tip = b.tip;
      const isBitmap = !!(tip && tip.rgba);
      const sec = [String(idx)];
      const push = function (k, v) { sec.push(k + '=' + v); };
      lines.push('[' + idx + ']');
      push('name', name);
      push('type', isBitmap ? 'bitmap' : 'program');
      push('group', '-1');
      push('width', String(size));
      push('min', String(min));
      push('opacity', String(Math.round(opacity * 100) / 100));
      push('pSize', 'true');
      push('pAlpha', b.pressureOpacity ? 'true' : 'false');
      push('cloudId', String(-1 - idx));
      push('cloudUuid', '');
      if (isBitmap) {
        const file = 'brushconv_' + (idx + 1) + '.png';
        push('bitmapFile', file);
        push('option', '5');
        push('option2', '0');
        push('option3', '50');
        push('option4', '0');
        push('option5', '1');
        images.push({ name: 'brush_bitmap/' + file, data: png.encode(tip.w, tip.h, tip.rgba) });
      } else {
        push('script', 'brushconv_' + (idx + 1) + '.bs');
        push('option', '0');
        push('option2', '3');
      }
      lines.push(sec.slice(1).join('\n'));
      lines.push('');
      idx++;
    }
    const ini = util.utf8Encode(lines.join('\n'));
    const files = [{ name: 'Brush2.ini', data: ini }].concat(images);
    const bytes = zip.write(files);
    return { bytes: bytes, count: idx, fileName: ((opts.name && sanitize(opts.name)) || 'MediBang笔刷') + '_云笔刷包.zip' };
  }

  const api = { isIni, parseIni, writeIniPack, parseIniEntries };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { medibangIni: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
