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

  /* Brush shape BMP: SAI uses luminance as opacity (white = paint).
     覆盖度通常放在 alpha 里，但部分来源（不透明灰度 PNG、某些解析器）把图案
     放在 RGB 通道、alpha 恒为 255。若仍只读 alpha，整张 BMP 会变成纯白实心
     方块。与 sai2read.decodeImage 对无 alpha 掩码 PNG 的处理保持一致。 */
  function tipGray(tip) {
    if (!tip) return null;
    if (tip.data) return { w: tip.w, h: tip.h, data: tip.data };
    if (!tip.rgba) return null;
    const w = tip.w, h = tip.h, n = w * h, rgba = tip.rgba, g = new Uint8Array(n);
    let aMin = 255, aMax = 0, rMin = 255, rMax = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4, a = rgba[o + 3];
      const v = (rgba[o] + rgba[o + 1] + rgba[o + 2]) / 3 | 0;
      if (a < aMin) aMin = a;
      if (a > aMax) aMax = a;
      if (v < rMin) rMin = v;
      if (v > rMax) rMax = v;
    }
    const useRgb = aMin === 255 && aMax === 255 && (rMax - rMin) > 2;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      g[i] = useRgb ? Math.round((rgba[o] + rgba[o + 1] + rgba[o + 2]) / 3) : rgba[o + 3];
    }
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

  /* ---------- 写侧「回声」纪律（第 248 轮） ----------
     源 INI 里原样出现的键，只要它对应的参数没被改动过，就**逐字回写源文本**；
     源 INI 里没有的键，参数也没被改动过，就**不写**。
     这两条对应 _probe/field-matrix/report.md 里的两类毛病：
       ① 「字段有值 ≠ 源里有这个 wire 字段」—— 用 `if (b.x)` 把「源没有」写成「显式默认值」；
       ② 「写侧恒用常量把源值砸掉」—— 源写 +180 被规范化成 -180、源写 96:50 被改写成 96:100。
     判据是 brush 属性有没有被改过（`_sai2SourceAttrs` 是解析那一刻的快照），
     不是「算出来的值恰好等于源值」—— 后者对 `Count=0`（读侧夹成 1）这种就失效了。 */
  const INI_KEYS = ['Density', 'AngleControl', 'Angle', 'AngleJitter', 'Scaling', 'ShapeSize',
    'SizeJitter', 'Spacing', 'Scattering', 'WxHRatio', 'WxHJitter', 'Count', 'CountJitter',
    'AllDirScattering', 'GaussianDistribution', 'AbsoluteSize', 'IntegerPosition',
    'HighQualitySampling', 'ColJitter', 'HueJitter', 'SaturationJitter', 'BrightnessJitter',
    'ApplyToEachShape', 'Opacity', 'EdgeHardness'];

  function sameVal(a, b) {
    return a === b || (typeof a === 'number' && typeof b === 'number' && a !== a && b !== b);
  }

  /* 一组依赖属性都没动过 → 该键的源文本仍然是「用户当初说的值」 */
  function untouched(brush, snap, deps) {
    if (!snap) return false;
    for (let i = 0; i < deps.length; i++) if (!sameVal(brush[deps[i]], snap[deps[i]])) return false;
    return true;
  }

  function buildIni(brush) {
    const raw = brush._sai2ini || {};
    const rawText = brush._sai2iniText || null;
    const nativeSource = !!brush._sai2ini;
    const snap = brush._sai2SourceAttrs || null;
    const had = function (k) { return Object.prototype.hasOwnProperty.call(raw, k); };
    const moved = function (deps) { return !untouched(brush, snap, deps || []); };
    const nativeValue = function (key, fallback) { return raw[key] === undefined ? fallback : raw[key]; };
    const patternSize = Number(raw.AbsoluteSize) === 1 && Number.isFinite(Number(raw.ShapeSize))
      ? Number(raw.ShapeSize) * (brush._sai2SourceSize > 0 ? brush.sizePx / brush._sai2SourceSize : 1) : brush.sizePx;
    const size = Math.max(1, Math.min(5000, Math.round(patternSize || 40)));
    const spacing = Math.max(1, Math.min(1000, Math.round(brush.spacingPct === undefined ? 10 : brush.spacingPct)));
    const angle = ((Math.round(isFinite(brush.angle) ? brush.angle : 0) + 180) % 360 + 360) % 360 - 180;
    const ratio = Math.max(1, Math.min(100, Math.round(brush.roundness === undefined ? 100 : brush.roundness)));
    const nativeRatio = raw.WxHRatio && brush.roundness === brush._sai2SourceRoundness ? raw.WxHRatio : ratio + ':100';
    const opacity = Math.max(0, Math.min(100, Math.round((brush.opacity === undefined ? 1 : brush.opacity) * 100)));
    /* Density 不是 SAI2 官方 [Parameters] 键，只是本项目承载流量的兼容字段。
       没有明确流量时不要拿不透明度顶替写出 —— 否则自己的包再导入会凭空多出
       flowPct = opacity，再跨格式导出就把「未定义流量」固化成错误数值。
       原生包本来就带 Density 且未改动不透明度时，仍按原值保留。 */
    const hasFlow = brush.flowPct !== undefined && Number.isFinite(Number(brush.flowPct));
    const keepRawDensity = !hasFlow && raw.Density !== undefined && brush.opacity === brush._sai2SourceOpacity;
    const density = hasFlow
      ? Math.max(0, Math.min(100, Math.round(Number(brush.flowPct) * 100)))
      : (keepRawDensity ? Math.max(0, Math.min(100, Math.round(Number(raw.Density)))) : null);
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
      ? Math.max(0, Math.min(200, Math.round(Number(brush.sai2Scaling)))) : nativeValue('Scaling', 100);
    const lines = [
      '; Converted by BrushConverter',
      '[Parameters]'
    ];
    /* 一个键怎么落地：源里有原文且参数没动 → 回写原文；源里没有且参数没动 → 不写；
       其余（参数被改过 / 外格式来源没有源 INI）→ 写算出来的值。 */
    const put = function (key, value, deps, mode) {
      const has = had(key);
      if (!has && !nativeSource) { lines.push(key + ' = ' + value); return; }
      if (mode !== 'force' && !moved(deps)) {
        if (has && rawText && rawText[key] !== undefined) { lines.push(key + ' = ' + rawText[key]); return; }
        if (!has && mode !== 'always') return;
      }
      lines.push(key + ' = ' + value);
    };
    /* 原生 INI 只有 Density 一个键承载「浓度」。用户在界面只改不透明度时，
       必须把这次变化折进 Density —— 否则 SAI2 读的是旧流量，改完等于没改。 */
    let densityOut = density;
    let densityForce = false;
    if (had('Density') && !had('Opacity') && snap &&
        !sameVal(brush.opacity, snap.opacity) && sameVal(brush.flowPct, snap.flowPct) &&
        Number.isFinite(Number(brush.opacity))) {
      densityOut = Math.max(0, Math.min(100, Math.round(Number(brush.opacity) * 100)));
      densityForce = true;
    }
    if (densityOut !== null) put('Density', densityOut, ['flowPct'], densityForce ? 'force' : null);
    put('AngleControl', angleControl, ['bruRotationMode','dynamicsControlAngle','tiltAngleDyn']);
    put('Angle', (angle >= 0 ? '+' : '') + angle, ['angle']);
    put('AngleJitter', angleJitter, ['angleJitterDeg','source']);
    put('Scaling', scaling, ['sai2Scaling']);
    put('ShapeSize', size, ['sizePx']);
    put('SizeJitter', sizeJitter, ['sizeJitterPct']);
    put('Spacing', spacing, ['spacingPct']);
    put('Scattering', scattering, ['scatterOn','scatterPct']);
    put('WxHRatio', nativeRatio, ['roundness']);
    put('WxHJitter', wxhJitter, ['roundnessJitterPct']);
    put('Count', count, ['scatterOn','scatterCount']);
    put('CountJitter', countJitter, ['scatterOn','countJitterPct']);
    put('AllDirScattering', allDir, ['scatterBothAxes']);
    put('GaussianDistribution', nativeValue('GaussianDistribution', 0), []);
    put('AbsoluteSize', nativeValue('AbsoluteSize', 0), []);
    put('IntegerPosition', nativeValue('IntegerPosition', 0), []);
    /* 高清采样是 SAI2 的采样质量开关，回归用例 152 明确要求「源里省了也要显式写 0」，
       避免回读端拿不到这个开关的确定值 —— 这里按 always 处理，不参与「省缺省键」的省略。 */
    put('HighQualitySampling', nativeValue('HighQualitySampling', brush._sai2ini ? 0 : 1), [], 'always');
    put('ColJitter', colJitter, ['colorDynamicsOn','colorJitterFgBg','jitterSecondary','jitterStrokeSecondary']);
    put('HueJitter', hueJitter, ['colorDynamicsOn','colorJitterHue']);
    put('SaturationJitter', satJitter, ['colorDynamicsOn','colorJitterSat']);
    put('BrightnessJitter', briJitter, ['colorDynamicsOn','colorJitterVal']);
    put('ApplyToEachShape', applyPerTip, ['colorPerTip','colorJitterHue','dynamicsJitterStrokeHue',
      'dynamicsJitterStrokeSaturation','dynamicsJitterStrokeLightness','jitterStrokeSecondary']);
    put('Opacity', opacity, ['opacity']);
    /* 边缘硬度：读侧认 EdgeHardness（没有才退回 prsfeel），写侧过去从没写过 —— 裸 INI
       往返里「硬度」整项丢失，只有走 toolnrm 的 edgehdns 才留下。源里有就按源写；源里没有
       但用户改过硬度的 SAI2 原生笔刷，也必须补一个键出来，否则改硬度对 SAI2 完全无效。
       外格式来源维持原样（不加新键），保持既有导出字节不变。 */
    /* _sai2SynthTip：占位图合成路径（convert.js blankSai2Tip）的硬度是合成输入，
       必须和回读后的 SAI2 原生笔刷走同一条写出口径，否则第二轮会多出这个键，
       导出→导入→再导出无法逐字节收敛。 */
    if (had('EdgeHardness') || (nativeSource && moved(['hardness'])) || brush._sai2SynthTip === true) {
      put('EdgeHardness', Math.max(0, Math.min(100, Math.round((brush.hardness === undefined ? 1 : brush.hardness) * 100))), ['hardness']);
    }
    /* 本工具不认识的键原样透传（Blur / 自定义键 …）：
       「不知道含义」不等于「可以丢」，这与 BRU 侧未知字段透传是同一条纪律。 */
    if (nativeSource) {
      for (const k of Object.keys(raw)) {
        if (INI_KEYS.indexOf(k) >= 0) continue;
        lines.push(k + ' = ' + (rawText && rawText[k] !== undefined ? rawText[k] : raw[k]));
      }
    }
    lines.push('');
    return util.utf8Encode(lines.join('\r\n'));
  }

  /* SAI2 的 <name>.bmp / <name>.ini 直接落盘，必须是合法文件名。
     第189轮 P2-#22：原来只替换了 \/:*?"<>| 并截 60 字符，CON/COM1/CONIN$ 这类
     Windows 保留名、尾随点空格、控制字符、双向隔离字符都会原样写到磁盘。
     规则统一收在 util.fileBase（替换字符保持历史上的下划线，别改已产出的名字口径）。 */
  function sanitize(name) {
    return util.fileBase(name, { illegal: '_', collapse: false, maxLen: 60, fallback: 'brush' });
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

  /* SAI2 用户数据目录里的相对位置（新版把素材放在 文档\SYSTEMAX Software Development\SAIv2\settings）：
       scatter/<名字>.bmp + <名字>.ini   散布笔刷
       brushtex/<名字>_纹理.bmp          笔刷纹理
     这里只产出「拖进去就生效」的目录结构，不生成任何 exe/自解压包。 */
  const DROP_IN_ROOT = 'SAIv2/settings/';

  function makeSai2Files(brushList, opts) {
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
        files.push({
          rel: f.name.indexOf('brushtex/') === 0
            ? DROP_IN_ROOT + 'brushtex/' + base + '_纹理.bmp'
            : DROP_IN_ROOT + 'scatter/' + base + ext,
          data: f.data
        });
      }
    }
    let record = null;
    try { record = writeToolnrm(completed); } catch (e) { warnings.push('兼容参数记录生成失败：' + e.message); }
    return { files: files, count: madeCount, warnings: warnings, record: record };
  }

  function sai2Readme(files) {
    const shapes = files.filter(f => /\/scatter\/.+\.bmp$/i.test(f.rel)).length;
    const textures = files.filter(f => /\/brushtex\//i.test(f.rel)).length;
    return util.utf8Encode(
      'SAI2 笔刷素材包（散布笔刷）\r\n' +
      '========================================\r\n' +
      '本包共 ' + shapes + ' 支笔刷（每支形状 BMP + 参数 INI 各一份），纹理 ' + textures + ' 个。\r\n' +
      '不需要安装程序，也没有 exe —— 直接把里面的 SAIv2 文件夹拖进去就行。\r\n\r\n' +
      '安装步骤\r\n' +
      '1. 打开「文档」里的 SYSTEMAX Software Development 文件夹\r\n' +
      '   常见路径：C:\\Users\\<你的用户名>\\Documents\\SYSTEMAX Software Development\r\n' +
      '   如果文档被 OneDrive 接管：C:\\Users\\<你的用户名>\\OneDrive\\文档\\SYSTEMAX Software Development\r\n' +
      '   找不到就先启动一次 SAI2，它会自动生成 SAIv2\\settings。\r\n' +
      '2. 把本包的 SAIv2 文件夹整个拖进上面那个文件夹，提示「合并/替换」时选合并。\r\n' +
      '   （本包只往 settings\\scatter 和 settings\\brushtex 里加文件，不会动 settings2.ssd。）\r\n' +
      '3. **完全退出 SAI2 再重新打开**（它只在启动时扫一次素材目录，切窗口/刷新不算），\r\n' +
      '   然后打开笔刷设置，把笔刷类型选成「散布笔刷 / scatter」，\r\n' +
      '   在形状列表里就能看到这些名字。\r\n' +
      '4. 有纹理的笔刷，还要在工具里手动选 settings\\brushtex 里对应的那张图。\r\n\r\n' +
      '说明\r\n' +
      '- BMP 是形状/纹理素材，不会自动创建完整工具；尺寸、浓度、压感这些请参照包内《SAI2参数记录.txt》。\r\n' +
      '- 新版原生工具预设是 settings\\custool\\<组>\\*.saitdat，需要组登记，本包不写这些，避免弄坏你已经有的工具组。\r\n' +
      '- 想删掉这批笔刷：按上面的文件名去 settings\\scatter 里删同名 bmp/ini 即可。\r\n'
    );
  }

  function makeSai2Pack(brushList, opts) {
    const zip = isNode ? require('./zip.js') : root.BC.zip;
    const made = makeSai2Files(brushList, opts);
    const files = made.files.slice();
    if (made.record) files.push({ rel: 'SAI2参数记录.txt', data: made.record });
    files.push({ rel: '导入说明.txt', data: sai2Readme(made.files) });
    return {
      bytes: zip.write(files.map(f => ({ name: f.rel, data: f.data }))),
      /* 注意：字段名叫 dropInFiles 而不是 files —— 转换流水线里 `made.files` 的约定是
         「一个个独立的输出文件」，SAI2 这里给的是包内相对路径清单，混用会让矩阵测试
         把单个 bmp 当产物去解析。 */
      dropInFiles: made.files,
      count: made.count,
      warnings: made.warnings
    };
  }

  /* 生成 SAI2 toolnrm（笔刷预设 INI）
     与 buildIni 同一套回声纪律：源 toolnrm 里有的键、参数没动过 → 回写原文；
     源里没有、参数也没动过 → 不写。写死的结构性常量（desc/brpat_vsbpos/brwav/
     drawmode/dpmax/quality）必须始终写，它们是记录的一部分，缺了 SAI2 不认这条工具。 */
  function writeToolnrm(brushes) {
    const NL = String.fromCharCode(10);
    const out = ['; SAI2 brush presets (toolnrm) - generated by brushconv', ''];
    (brushes || []).forEach(function (b, i) {
      const rawTool = b._sai2tool || {};
      const rawText = b._sai2ToolText || null;
      const nativeSource = !!b._sai2tool;
      const snap = b._sai2ToolAttrs || null;
      const had = function (k) { return Object.prototype.hasOwnProperty.call(rawTool, k); };
      const put = function (key, value, deps, mode) {
        const has = had(key);
        if (!has && !nativeSource) { out.push(key + '=' + value); return; }
        if (mode !== 'force' && untouched(b, snap, deps || [])) {
          if (has && rawText && rawText[key] !== undefined) { out.push(key + '=' + rawText[key]); return; }
          if (!has && mode !== 'always') return;
        }
        out.push(key + '=' + value);
      };
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
      /* 段号与 id 必须自洽，这是记录序号不是源值，不参与回声 */
      out.push('id=' + (i + 1));
      const safeName = String(b.name || ('brush ' + (i + 1))).split(String.fromCharCode(13)).join(' ').split(String.fromCharCode(10)).join(' ');
      put('name', safeName, ['name']);
      put('desc', 'brushconv', [], 'always');
      put('brpat_vsbpos', 0, [], 'always');
      put('brwav', 3, [], 'always');
      put('drawmode', 1, [], 'always');
      put('brsize', size, ['sizePx']);
      put('brsizesc', size, ['sizePx']);
      put('depth', depth, ['opacity']);
      put('f_prs2sz', (b.pressureSize ? 1 : 0), ['pressureSize']);
      put('f_prs2dp', (b.pressureOpacity ? 1 : 0), ['pressureOpacity']);
      put('f_prs2bl', prs2bl, ['pressureSmudge']);
      put('prsfeel', Math.round((b.hardness === undefined ? 1 : b.hardness) * 100), ['hardness']);
      put('szmin', szmin, ['minSizeRatio']);
      put('dpmin', Math.round((b.minOpacityRatio === undefined ? 0 : b.minOpacityRatio) * 100), ['minOpacityRatio']);
      put('dpmax', 0, [], 'always');
      put('quality', 4, [], 'always');
      put('blend', Math.round((b.smudgeAmount === undefined ? 0 : b.smudgeAmount) * 100), ['smudgeAmount']);
      put('water', Math.round((b.wetEdgesAmount === undefined ? 0 : b.wetEdgesAmount) * 100), ['wetEdgesAmount']);
      put('stretch', stretch, ['colorStretch']);
      put('bfval', bfval, ['flowPct']);
      put('txval', Math.max(0, Math.min(100, Math.round((b.textureDepth === undefined ? 1 : b.textureDepth) * 100))), ['textureDepth']);
      if (b.textureScale !== undefined && Number.isFinite(Number(b.textureScale))) {
        put('texscl', Math.max(1, Math.min(1000, Math.round(Number(b.textureScale) * 100))), ['textureScale']);
      } else if (rawTool.texscl !== undefined) {
        put('texscl', rawTool.texscl, ['textureScale']);
      }
      if (b.textureInverted !== undefined) {
        put('texinvf', (b.textureInverted ? 1 : 0), ['textureInverted']);
      } else if (rawTool.texinvf !== undefined) {
        put('texinvf', rawTool.texinvf, ['textureInverted']);
      }
      put('brfnam', (b.sai2ShapeName || ''), ['sai2ShapeName']);
      put('texnam', (b.sai2TextureName || ''), ['sai2TextureName']);
      put('smooth', Math.round((b.smoothingStrength === undefined ? 0 : b.smoothingStrength) * 100), ['smoothingStrength']);
      put('edgehdns', Math.round((b.hardness === undefined ? 1 : b.hardness) * 100), ['hardness']);
      put('f_keepopac', keepopac, ['keepOpacity']);
      out.push('');
    });
    return util.utf8Encode(out.join(NL));
  }

  const api = { makeSai2Brush: makeSai2Brush, makeSai2Files: makeSai2Files, makeSai2Pack: makeSai2Pack, DROP_IN_ROOT: DROP_IN_ROOT, encodeBmp8: encodeBmp8, writeToolnrm: writeToolnrm };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { sai2: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
