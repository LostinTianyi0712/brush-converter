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
    const side=Math.max(g.w,g.h);
    const left=Math.floor((side-g.w)/2),top=Math.floor((side-g.h)/2);
    const n=Math.max(8,Math.min(500,Math.round(target||64)));
    const out=new Uint8Array(n*n);
    for(let y=0;y<n;y++)for(let x=0;x<n;x++){
      const sx=Math.floor(x*side/n)-left,sy=Math.floor(y*side/n)-top;
      if(sx>=0&&sy>=0&&sx<g.w&&sy<g.h)out[y*n+x]=g.data[sy*g.w+sx];
    }
    return {w:n,h:n,data:out};
  }

  function buildIni(brush) {
    const raw = brush._sai2ini || {};
    const nativeValue = function (key, fallback) { return raw[key] === undefined ? fallback : raw[key]; };
    const patternSize = Number(raw.AbsoluteSize) === 1 && Number.isFinite(Number(raw.ShapeSize))
      ? Number(raw.ShapeSize) * (brush._sai2SourceSize > 0 ? brush.sizePx / brush._sai2SourceSize : 1) : brush.sizePx;
    const size = Math.max(1, Math.min(5000, Math.round(patternSize || 40)));
    const spacing = Math.max(1, Math.min(1000, Math.round(brush.spacingPct === undefined ? 10 : brush.spacingPct)));
    const angle = ((Math.round(isFinite(brush.angle) ? brush.angle : 0) + 180) % 360 + 360) % 360 - 180;
    const ratio = Math.max(1, Math.min(100, Math.round(brush.roundness === undefined ? 100 : brush.roundness)));
    const nativeRatio = raw.WxHRatio && brush.roundness === brush._sai2SourceRoundness ? raw.WxHRatio : ratio + ':100';
    const opacity = Math.max(0, Math.min(100, Math.round((brush.opacity === undefined ? 1 : brush.opacity) * 100)));
    const density = brush.flowPct !== undefined && Number.isFinite(Number(brush.flowPct))
      ? Math.max(0, Math.min(100, Math.round(Number(brush.flowPct) * 100)))
      : (raw.Density !== undefined && brush.opacity === brush._sai2SourceOpacity ? Math.max(0, Math.min(100, Math.round(Number(raw.Density)))) : opacity);
    const angleControl = (brush.bruRotationMode === 1 || brush.dynamicsControlAngle === 6) ? 1
      : ((brush.dynamicsControlAngle === 3 || brush.dynamicsControlAngle === 4 || (brush.tiltAngleDyn || 0) > 0) ? 2
      : ((brush.bruRotationMode === 0 || brush.dynamicsControlAngle === 0) ? 0 : nativeValue('AngleControl', 0)));
    const angleJitter = Math.max(0, Math.min(100, Math.round(brush.source === 'abr' ? (brush.angleJitterDeg || 0) : ((brush.angleJitterDeg || 0) * 100 / 360))));
    const sizeJitter = Math.max(0, Math.min(100, Math.round(brush.sizeJitterPct || 0)));
    const scattering = brush.scatterOn ? Math.max(0, Math.min(1000, Math.round(brush.scatterPct || 0))) : 0;
    const wxhJitter = Math.max(0, Math.min(100, Math.round(brush.roundnessJitterPct || 0)));
    const count = brush.scatterOn === false ? 1 : Math.max(1, Math.min(20, Math.round(brush.scatterCount || 1)));
    const countJitter = brush.scatterOn === false ? 0 : Math.max(0, Math.min(100, Math.round(brush.countJitterPct || 0)));
    const allDir = brush.scatterBothAxes === false ? 0 : 1;
    const fgBgVal = brush.colorJitterFgBg !== undefined ? brush.colorJitterFgBg
      : (brush.jitterSecondary !== undefined ? brush.jitterSecondary : brush.jitterStrokeSecondary);
    const colJitter = brush.colorDynamicsOn ? (fgBgVal !== undefined && Number.isFinite(Number(fgBgVal))
      ? Math.max(0, Math.min(100, Math.round(Number(fgBgVal) * 100))) : nativeValue('ColJitter', 0)) : 0;
    const hueJitter = brush.colorDynamicsOn ? Math.max(0, Math.min(100, Math.round((brush.colorJitterHue || 0) * 100))) : 0;
    const satJitter = brush.colorDynamicsOn ? Math.max(0, Math.min(100, Math.round((brush.colorJitterSat || 0) * 100))) : 0;
    const briJitter = brush.colorDynamicsOn ? Math.max(0, Math.min(100, Math.round((brush.colorJitterVal || 0) * 100))) : 0;
    const applyPerTip = brush.colorPerTip !== undefined ? (brush.colorPerTip ? 1 : 0)
      : ((brush.dynamicsJitterStrokeHue > 0 || brush.dynamicsJitterStrokeSaturation > 0 || brush.dynamicsJitterStrokeLightness > 0 || brush.jitterStrokeSecondary > 0) &&
         !(brush.colorJitterHue > 0 && !brush.dynamicsJitterStrokeHue) ? 0
      : nativeValue('ApplyToEachShape', (colJitter > 0 || hueJitter > 0 || satJitter > 0 || briJitter > 0) && !brush._sai2ini ? 1 : 0));
    const scaling = brush.sai2Scaling !== undefined && Number.isFinite(Number(brush.sai2Scaling))
      ? Math.max(1, Math.min(200, Math.round(Number(brush.sai2Scaling)))) : nativeValue('Scaling', 100);
    const lines = [
      '; Converted by BrushConverter',
      '[Parameters]',
      'Density = ' + density,
      'AngleControl = ' + angleControl,
      'Angle = ' + (angle >= 0 ? '+' : '') + angle,
      'AngleJitter = ' + angleJitter,
      'Scaling = ' + scaling,
      'ShapeSize = ' + size,
      'SizeJitter = ' + sizeJitter,
      'Spacing = ' + spacing,
      'Scattering = ' + scattering,
      'WxHRatio = ' + nativeRatio,
      'WxHJitter = ' + wxhJitter,
      'Count = ' + count,
      'CountJitter = ' + countJitter,
      'AllDirScattering = ' + allDir,
      'GaussianDistribution = ' + nativeValue('GaussianDistribution', 0),
      'AbsoluteSize = ' + nativeValue('AbsoluteSize', 0),
      'IntegerPosition = ' + nativeValue('IntegerPosition', 0),
      'HighQualitySampling = ' + nativeValue('HighQualitySampling', brush._sai2ini ? 0 : 1),
      'ColJitter = ' + colJitter,
      'HueJitter = ' + hueJitter,
      'SaturationJitter = ' + satJitter,
      'BrightnessJitter = ' + briJitter,
      'ApplyToEachShape = ' + applyPerTip,
      'Opacity = ' + opacity,
      ''
    ];
    return util.utf8Encode(lines.join('\r\n'));
  }

  function sanitize(name) {
    return String(name || 'brush').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'brush';
  }

  function makeSai2Brush(brush, opts) {
    opts = opts || {};
    const restoreAspect = brush._sai2AspectOriginalTip && brush.roundness === brush._sai2SourceRoundness &&
      brush._sai2AspectTipState === util.brushFingerprint({tip:brush.tip});
    const tip = tipGray(restoreAspect ? brush._sai2AspectOriginalTip : brush.tip);
    if (!tip) throw new Error('该笔刷没有笔尖形状，无法写成 SAI2 笔刷形状 BMP');
    const target = Math.max(8, Math.min(500, Math.max(tip.w, tip.h), opts.maxTipSize || 500));
    const g = squareAndSize(tip, target);
    const bmp = encodeBmp8(g.w, g.h, g.data);
    const iniBrush = brush._sai2AspectOriginalTip && !restoreAspect ? Object.assign({},brush,{
      _sai2ini:Object.assign({},brush._sai2ini,{WxHRatio:(brush.roundness===undefined?100:brush.roundness)+':100'})
    }) : brush;
    const ini = buildIni(iniBrush);
    const name = sanitize(brush.name);
    const files = [{name: name + '.bmp', data: bmp}, {name: name + '.ini', data: ini}];
    if (brush._sai2Texture) {
      const t = brush._sai2Texture;
      files.push({name: 'brushtex/' + name + '_纹理.bmp', data: encodeBmp8(t.w, t.h, t.gray)});
    }
    return {
      files: files,
      name: name
    };
  }

  function makeSai2Pack(brushList, opts) {
    const zip = isNode ? require('./zip.js') : root.BC.zip;
    const files = [];
    const used = new Set();
    const completed = [];
    const warnings = [];
    let madeCount = 0;
    for (const brush of brushList || []) {
      let made;
      try { made = makeSai2Brush(brush, opts); }
      catch (e) { warnings.push((brush.name || '未命名') + '：' + e.message); continue; }
      let base = made.name, i = 2;
      while (used.has(base.toLowerCase())) { base = made.name + '_' + i; i++; }
      used.add(base.toLowerCase());
      completed.push(Object.assign({}, brush, {sai2ShapeName:base,sai2TextureName:brush._sai2Texture?base+'_纹理':''}));
      madeCount++;
      for (const f of made.files) {
        const ext = f.name.slice(f.name.lastIndexOf('.'));
        files.push({ name: f.name.indexOf('brushtex/') === 0 ? 'brushtex/' + base + '_纹理.bmp' : base + ext, data: f.data });
      }
    }
    // 笔刷预设 INI（toolnrm）：保留 SAI2 的尺寸/浓度/最小直径/压感开关
    try { files.push({ name: 'toolnrm', data: writeToolnrm(completed) }); } catch (e) { warnings.push('toolnrm 兼容参数生成失败：' + e.message); }
    files.push({
      name: '说明.txt',
      data: util.utf8Encode(
        'SAI2 笔刷（scatter brush）导入说明\r\n' +
        '==============================\r\n' +
        '1. 新版 SAI2 通常使用「文档\\SYSTEMAX Software Development\\SAIv2\\settings\\scatter」。\r\n' +
        '   文档可能位于 OneDrive；旧版才使用安装目录中的 scatter。\r\n' +
        '2. 把本包里的每个 <名字>.bmp 和对应 <名字>.ini 一起放进该文件夹。\r\n' +
        '3. 重启 SAI2，在笔刷设置里选择 scatter brush（散布笔刷）即可看到新增笔刷。\r\n' +
        '4. 如有 brushtex 子目录，把其中纹理 BMP 放入上述 settings\\brushtex，再在工具中手动选择纹理。\r\n' +
        '5. toolnrm 是兼容参数记录，供查阅尺寸/浓度/压感；不要拿它覆盖 SAI2 用户设置。\r\n' +
        '   新版原生工具是 custool\\nrm\\*.saitdat，另需组登记；本包没有自动安装或替换这些预设。\r\n' +
        '说明：BMP/INI 是形状素材，不会自动创建完整工具。工具当前尺寸、浓度和压感需按参数记录设置。\r\n'
      )
    });
    return { bytes: zip.write(files), count: madeCount, warnings: warnings };
  }

  /* 生成 SAI2 toolnrm（笔刷预设 INI） */
  function writeToolnrm(brushes) {
    const NL = String.fromCharCode(10);
    const out = ['; SAI2 brush presets (toolnrm) - generated by brushconv', ''];
    (brushes || []).forEach(function (b, i) {
      const rawTool = b._sai2tool || {};
      const size = Math.max(1, Math.min(5000, Math.round(b.sizePx || 30)));
      const depth = Math.max(0, Math.min(100, Math.round((b.opacity === undefined ? 1 : b.opacity) * 100)));
      const szmin = Math.max(0, Math.min(100, Math.round((b.minSizeRatio === undefined ? 0 : b.minSizeRatio) * 100)));
      const bfval = b.flowPct !== undefined && Number.isFinite(Number(b.flowPct))
        ? Math.max(0, Math.min(100, Math.round(Number(b.flowPct) * 100)))
        : (rawTool.bfval !== undefined ? Number(rawTool.bfval) : 50);
      const stretch = b.colorStretch !== undefined && Number.isFinite(Number(b.colorStretch))
        ? Math.max(0, Math.min(100, Math.round(Number(b.colorStretch) * 100)))
        : (rawTool.stretch !== undefined ? Number(rawTool.stretch) : 90);
      const prs2bl = b.pressureSmudge !== undefined ? (b.pressureSmudge ? 1 : 0)
        : (rawTool.f_prs2bl !== undefined ? (Number(rawTool.f_prs2bl) ? 1 : 0) : 0);
      const keepopac = b.keepOpacity !== undefined ? (b.keepOpacity ? 1 : 0)
        : (rawTool.f_keepopac !== undefined ? (Number(rawTool.f_keepopac) ? 1 : 0) : 0);
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
      out.push('f_prs2bl=' + prs2bl);
      out.push('prsfeel=' + Math.round((b.hardness === undefined ? 1 : b.hardness) * 100));
      out.push('szmin=' + szmin);
      out.push('dpmin=' + Math.round((b.minOpacityRatio === undefined ? 0 : b.minOpacityRatio) * 100));
      out.push('dpmax=0');
      out.push('quality=4');
      out.push('blend=' + Math.round((b.smudgeAmount === undefined ? 0 : b.smudgeAmount) * 100));
      out.push('water=' + Math.round((b.wetEdgesAmount === undefined ? 0 : b.wetEdgesAmount) * 100));
      out.push('stretch=' + stretch);
      out.push('bfval=' + bfval);
      out.push('txval=' + Math.max(0,Math.min(100,Math.round((b.textureDepth===undefined?1:b.textureDepth)*100))));
      if (b.textureScale !== undefined && Number.isFinite(Number(b.textureScale))) {
        out.push('texscl=' + Math.max(1, Math.min(1000, Math.round(Number(b.textureScale) * 100))));
      } else if (rawTool.texscl !== undefined) {
        out.push('texscl=' + rawTool.texscl);
      }
      if (b.textureInverted !== undefined) {
        out.push('texinvf=' + (b.textureInverted ? 1 : 0));
      } else if (rawTool.texinvf !== undefined) {
        out.push('texinvf=' + rawTool.texinvf);
      }
      out.push('brfnam=' + (b.sai2ShapeName || ''));
      out.push('texnam=' + (b.sai2TextureName || ''));
      out.push('smooth=' + Math.round((b.smoothingStrength === undefined ? 0 : b.smoothingStrength) * 100));
      out.push('edgehdns=' + Math.round((b.hardness === undefined ? 1 : b.hardness) * 100));
      out.push('f_keepopac=' + keepopac);
      out.push('');
    });
    return util.utf8Encode(out.join(NL));
  }

  const api = { makeSai2Brush: makeSai2Brush, makeSai2Pack: makeSai2Pack, encodeBmp8: encodeBmp8, writeToolnrm: writeToolnrm };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { sai2: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
