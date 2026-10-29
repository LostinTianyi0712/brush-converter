/* Easy Paint Tool SAI 2 scatter brush writer.
   SAI2 brushes live in one folder: "<name>.bmp" (8-bit indexed brush shape)
   + "<name>.ini" (scatter-brush parameters).  There is no single bundled
   container, so a converted set is emitted as flat files (optionally zipped).
   INI keys reverse-engineered from the SAI2 scatter-brush INI format. */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;

  /* ---------- BMP (8-bit indexed, grayscale palette) ---------- */
  function u16(n) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]); }
  function u32le(n) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]); }

  function encodeBmp8(w, h, gray) {
    const rowSize = ((w + 3) >> 2) << 2;
    const pixelBytes = rowSize * h;
    const paletteBytes = 256 * 4;
    const offBits = 14 + 40 + paletteBytes;
    const total = offBits + pixelBytes;
    const out = new Uint8Array(total);
    // BITMAPFILEHEADER
    out[0] = 0x42; out[1] = 0x4d; // 'BM'
    out.set(u32le(total), 2);
    out.set(u32le(0), 6);
    out.set(u32le(offBits), 10);
    // BITMAPINFOHEADER
    out.set(u32le(40), 14);
    out.set(u32le(w), 18);
    out.set(u32le(h), 22);
    out.set(u16(1), 26);   // planes
    out.set(u16(8), 28);   // bpp
    out.set(u32le(0), 30); // compression BI_RGB
    out.set(u32le(pixelBytes), 34);
    out.set(u32le(2835), 38); // 72 DPI
    out.set(u32le(2835), 42);
    out.set(u32le(256), 46); // colors used
    out.set(u32le(256), 50);
    // palette: grayscale
    for (let i = 0; i < 256; i++) {
      const o = 54 + i * 4;
      out[o] = i; out[o + 1] = i; out[o + 2] = i; out[o + 3] = 0;
    }
    // pixels: bottom-up rows
    for (let y = 0; y < h; y++) {
      const srcRow = h - 1 - y;
      const dst = offBits + y * rowSize;
      for (let x = 0; x < w; x++) out[dst + x] = gray[srcRow * w + x];
    }
    return out;
  }

  /* Brush shape BMP: SAI uses luminance as opacity (white = paint). */
  function tipGray(tip) {
    if (!tip) return null;
    if (tip.data) return { w: tip.w, h: tip.h, data: tip.data };
    if (!tip.rgba) return null;
    const w = tip.w, h = tip.h, g = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = tip.rgba[i * 4 + 3];
    return { w: w, h: h, data: g };
  }

  // SAI2 uses square shapes. Pad the original canvas instead of cropping it
  // or deleting disconnected components that may be deliberate brush fibres.
  function squareAndSize(g, target) {
    const side=Math.max(g.w,g.h), padded=new Uint8Array(side*side);
    const left=Math.floor((side-g.w)/2),top=Math.floor((side-g.h)/2);
    for(let y=0;y<g.h;y++)padded.set(g.data.subarray(y*g.w,(y+1)*g.w),(top+y)*side+left);
    const n=Math.max(8,Math.min(500,Math.round(target||64)));
    if(n===side)return {w:n,h:n,data:padded};
    const out=new Uint8Array(n*n);
    for(let y=0;y<n;y++)for(let x=0;x<n;x++){
      const sx=Math.min(side-1,Math.floor(x*side/n)),sy=Math.min(side-1,Math.floor(y*side/n));
      out[y*n+x]=padded[sy*side+sx];
    }
    return {w:n,h:n,data:out};
  }

  function buildIni(brush) {
    const size = Math.max(1, Math.min(5000, Math.round(brush.sizePx || 40)));
    const spacing = Math.max(1, Math.min(1000, Math.round((brush.spacingPct || 10))));
    const angle = Math.round((isFinite(brush.angle) ? brush.angle : 0));
    const ratio = Math.max(10, Math.min(100, Math.round(brush.roundness === undefined ? 100 : brush.roundness)));
    const opacity = Math.max(1, Math.min(100, Math.round((brush.opacity === undefined ? 1 : brush.opacity) * 100)));
    const lines = [
      '; Converted by BrushConverter',
      '[Parameters]',
      'AngleControl = 0',
      'Angle = ' + (angle >= 0 ? '+' : '') + angle,
      'AngleJitter = 0',
      'Scaling = 100',
      'ShapeSize = ' + size,
      'SizeJitter = 0',
      'Spacing = ' + spacing,
      'Scattering = 0',
      'WxHRatio = ' + ratio + ':100',
      'WxHJitter = 0',
      'Count = 1',
      'CountJitter = 0',
      'AllDirScattering = 0',
      'GaussianDistribution = 0',
      'AbsoluteSize = 0',
      'IntegerPosition = 0',
      'HighQualitySampling = 1',
      'ColJitter = 0',
      'HueJitter = 0',
      'SaturationJitter = 0',
      'BrightnessJitter = 0',
      'ApplyToEachShape = 0',
      'Opacity = ' + opacity,
      ''
    ];
    return util.utf8Encode(lines.join('\r\n'));
  }

  function sanitize(name) {
    return String(name || 'brush').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'brush';
  }

  function makeSai2Brush(brush) {
    const tip = tipGray(brush.tip);
    if (!tip) throw new Error('该笔刷没有笔尖形状，无法写成 SAI2 笔刷形状 BMP');
    const target = Math.max(8, Math.min(500, Math.round(brush.sizePx || 40)));
    const g = squareAndSize(tip, target);
    const bmp = encodeBmp8(g.w, g.h, g.data);
    const ini = buildIni(brush);
    const name = sanitize(brush.name);
    return {
      files: [
        { name: name + '.bmp', data: bmp },
        { name: name + '.ini', data: ini }
      ],
      name: name
    };
  }

  function makeSai2Pack(brushList) {
    const zip = isNode ? require('./zip.js') : root.BC.zip;
    const files = [];
    const used = {};
    const warnings = [];
    let madeCount = 0;
    for (const brush of brushList || []) {
      let made;
      try { made = makeSai2Brush(brush); }
      catch (e) { warnings.push((brush.name || '未命名') + '：' + e.message); continue; }
      let base = made.name, i = 2;
      while (used[base.toLowerCase()]) { base = made.name + '_' + i; i++; }
      used[base.toLowerCase()] = true;
      madeCount++;
      for (const f of made.files) {
        const ext = f.name.slice(f.name.lastIndexOf('.'));
        files.push({ name: base + ext, data: f.data });
      }
    }
    // 笔刷预设 INI（toolnrm）：保留 SAI2 的尺寸/浓度/最小直径/压感开关
    try { files.push({ name: 'toolnrm', data: writeToolnrm(brushList) }); } catch (e) { warnings.push('toolnrm 生成失败：' + e.message); }
    files.push({
      name: '说明.txt',
      data: util.utf8Encode(
        'SAI2 笔刷（scatter brush）导入说明\r\n' +
        '==============================\r\n' +
        '1. 找到 SAI2 的 scatter brush 文件夹（通常在 SAI2 安装目录或用户目录下，\r\n' +
        '   名字类似 tool\\scatterbrush / scatterbrush）。\r\n' +
        '2. 把本包里的每个 <名字>.bmp 和对应 <名字>.ini 一起放进该文件夹。\r\n' +
        '3. 重启 SAI2，在笔刷设置里选择 scatter brush（散布笔刷）即可看到新增笔刷。\r\n' +
        '说明：SAI2 没有单文件笔刷格式，必须 bmp + ini 成对放入同一文件夹。\r\n'
      )
    });
    return { bytes: zip.write(files), count: madeCount, warnings: warnings };
  }

  /* 生成 SAI2 toolnrm（笔刷预设 INI） */
  function writeToolnrm(brushes) {
    const NL = String.fromCharCode(10);
    const out = ['; SAI2 brush presets (toolnrm) - generated by brushconv', ''];
    (brushes || []).forEach(function (b, i) {
      const size = Math.max(1, Math.min(5000, Math.round(b.sizePx || 30)));
      const depth = Math.max(1, Math.min(100, Math.round((b.opacity === undefined ? 1 : b.opacity) * 100)));
      const szmin = Math.max(0, Math.min(100, Math.round((b.minSizeRatio === undefined ? 0 : b.minSizeRatio) * 100)));
      out.push('[' + (i + 1) + ']');
      out.push('id=' + (i + 1));
      const safeName = String(b.name || ('brush ' + (i + 1))).split(String.fromCharCode(13)).join(' ').split(String.fromCharCode(10)).join(' ');
      out.push('name=' + safeName);
      out.push('desc=brushconv');
      out.push('brpat_vsbpos=0');
      out.push('brwav=3');
      out.push('drawmode=1');
      out.push('brsize=' + size);
      out.push('brsizesc=' + size);
      out.push('depth=' + depth);
      out.push('f_prs2sz=' + (b.pressureSize ? 1 : 0));
      out.push('f_prs2dp=' + (b.pressureOpacity ? 1 : 0));
      out.push('f_prs2bl=0');
      out.push('prsfeel=' + Math.round((b.hardness === undefined ? 1 : b.hardness) * 100));
      out.push('szmin=' + szmin);
      out.push('dpmin=' + Math.round((b.minOpacityRatio === undefined ? 0 : b.minOpacityRatio) * 100));
      out.push('dpmax=0');
      out.push('quality=4');
      out.push('blend=' + Math.round((b.smudgeAmount === undefined ? 0 : b.smudgeAmount) * 100));
      out.push('water=' + Math.round((b.wetEdgesAmount === undefined ? 0 : b.wetEdgesAmount) * 100));
      out.push('stretch=90');
      out.push('bfval=50');
      out.push('txval=50');
      out.push('brfnam=' + (b.textureName || ''));
      out.push('texnam=' + (b.textureName || ''));
      out.push('smooth=' + Math.round((b.smoothingStrength === undefined ? 0 : b.smoothingStrength) * 100));
      out.push('edgehdns=' + Math.round((b.hardness === undefined ? 1 : b.hardness) * 100));
      out.push('f_keepopac=0');
      out.push('');
    });
    return util.utf8Encode(out.join(NL));
  }

  const api = { makeSai2Brush: makeSai2Brush, makeSai2Pack: makeSai2Pack, encodeBmp8: encodeBmp8, writeToolnrm: writeToolnrm };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { sai2: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
