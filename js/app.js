/* BrushConv web UI */
(function () {
  'use strict';
  const BC = window.BC;
  const $ = sel => document.querySelector(sel);
  const filesEl = $('#files');
  const emptyEl = $('#empty');
  const dz = $('#dropzone');
  const fileInput = $('#fileInput');
  const btnConvert = $('#btnConvert');
  const btnClear = $('#btnClear');
  const progressEl = $('#progress');

  const state = { files: [], converting: false };

  /* ---------------- helpers ---------------- */
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function readFileBytes(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(new Uint8Array(fr.result));
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsArrayBuffer(file);
    });
  }

  /* ---------------- brush preview canvas ---------------- */
  function tipToCanvas(brush, cv, opts) {
    const tip = brush.tip;
    if (!tip) { cv.width = 1; cv.height = 1; return; }
    let rgba, w = tip.w, h = tip.h;
    if (tip.rgba) rgba = tip.rgba;
    else {
      const bpp = tip.bpp || 1;
      rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const a = bpp === 2 ? tip.data[i * 2] : tip.data[i];
        rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = a;
      }
    }
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(w, h);
    // paint dark on light background so shape is visible
    for (let i = 0; i < w * h; i++) {
      const a = rgba[i * 4 + 3] / 255;
      const v = Math.round(255 * (1 - a) * 0.85 + 30);
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function strokePreview(brush, cv) {
    const W = cv.width = 260, H = cv.height = 96;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    const tip = brush.tip;
    let tipCv = document.createElement('canvas');
    tipToCanvas(brush, tipCv, {});
    const tipW = tipCv.width || 1, tipH = tipCv.height || 1;
    const sizePx = Math.max(4, Math.min(70, (brush.sizePx || 60) * 0.55));
    const spacing = Math.max(0.02, Math.min(2, (brush.spacingPct || 10) / 100));
    const alpha = brush.opacity === undefined ? 1 : brush.opacity;
    const step = Math.max(1.5, sizePx * spacing);
    // 真实笔迹预览：按间距盖章，并模拟散布/大小随机/角度随机/压感（起笔细、中段粗、收笔细）
    const scatter = brush.scatterOn ? Math.max(0, Math.min(1, (brush.scatterPct || 0) / 100)) : 0;
    const count = brush.scatterOn ? Math.max(1, Math.min(12, brush.scatterCount || 1)) : 1;
    const sizeJit = Math.max(0, Math.min(1, (brush.sizeJitterPct || 0) / 100));
    const angleJit = Math.max(0, Math.min(90, brush.angleJitterDeg || 0));
    const minSize = brush.minSizeRatio === undefined ? 1 : Math.max(0.1, Math.min(1, brush.minSizeRatio));
    const pressure = !!brush.pressureSize || !!brush.pressure;
    ctx.save();
    ctx.globalAlpha = Math.max(0.15, Math.min(1, alpha));
    for (let x = 12; x < W - 12; x += step) {
      const t = (x - 12) / (W - 24);
      const y0 = H / 2 + Math.sin(t * Math.PI * 1.6) * 14;
      // 压感模拟：两端细中间粗
      const press = pressure ? (0.35 + 0.65 * Math.sin(t * Math.PI)) : 1;
      const baseScale = (sizePx / Math.max(tipW, tipH)) * (2.2 + 1.6 * (1 - minSize) * press);
      for (let c = 0; c < count; c++) {
        const jitter = (Math.sin(x * 12.9898 + c * 78.233) * 43758.5453) % 1;
        const jitter2 = (Math.sin(x * 39.425 + c * 11.135) * 24634.6345) % 1;
        const jSize = 1 - sizeJit * Math.abs(jitter);
        const ang = ((brush.angle || 0) + angleJit * (jitter2 - 0.5) * 2) * Math.PI / 180;
        const sx = x + (scatter ? (jitter - 0.5) * sizePx * scatter * 1.4 : 0);
        const sy = y0 + (scatter ? (jitter2 - 0.5) * sizePx * scatter * 1.4 : 0);
        const w = tipW * baseScale * press * jSize;
        const h = tipH * baseScale * press * jSize;
        ctx.save();
        ctx.translate(sx, sy);
        if (ang) ctx.rotate(ang);
        ctx.drawImage(tipCv, -w / 2, -h / 2, w, h);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  /* ---------------- rendering ---------------- */
  function render() {
    filesEl.innerHTML = '';
    const allBrushes = state.files.reduce((acc, f) => acc.concat(f.brushes || []), []);
    const total = allBrushes.filter(b => b.enabled !== false).length;
    emptyEl.style.display = state.files.length ? 'none' : 'block';
    const sel = $('#optTarget');
    const fmtLabel = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text : '';
    btnConvert.disabled = !total || state.converting;
    btnConvert.textContent = total
      ? '转换并下载 ZIP（已选 ' + total + ' 支 · ' + fmtLabel + '）'
      : (allBrushes.length ? '请至少勾选 1 支笔刷' : '转换并下载 ZIP');

    state.files.forEach((rec, fi) => {
      const card = document.createElement('div');
      card.className = 'file-card card';
      const head = document.createElement('div');
      head.className = 'file-head';
      head.innerHTML = `
        <div class="fname" title="${esc(rec.name)}">${esc(rec.name)}</div>
        <div class="badge ${rec.error ? 'err' : (rec.kind || 'parsing')}">${rec.error ? '无法识别' : (rec.kind ? (rec.kindLabel || rec.kind) : '解析中')}</div>
        <div class="fmeta">${rec.bytes ? fmtSize(rec.bytes.length) : ''}</div>
        <div class="fmeta">${rec.brushes ? rec.brushes.length + ' 支笔刷' : (rec.error ? '出错' : '解析中…')}${rec.parseMs ? ' · ' + (rec.parseMs >= 1000 ? (rec.parseMs / 1000).toFixed(1) + 's' : rec.parseMs + 'ms') : ''}</div>
        ${rec.brushes && rec.brushes.length ? '<button class="btn tiny ghost selall" title="全选本文件笔刷">全选</button><button class="btn tiny ghost selnone" title="取消本文件笔刷">清空</button>' : ''}
        <button class="btn tiny ghost remove" title="移除">✕</button>`;
      head.querySelector('.remove').onclick = () => {
        state.files.splice(fi, 1);
        render();
      };
      if (head.querySelector('.selall')) head.querySelector('.selall').onclick = () => {
        rec.brushes.forEach(b => { b.enabled = true; });
        render();
      };
      if (head.querySelector('.selnone')) head.querySelector('.selnone').onclick = () => {
        rec.brushes.forEach(b => { b.enabled = false; });
        render();
      };
      card.appendChild(head);

      if (rec.error) {
        const err = document.createElement('div');
        err.className = 'err';
        err.textContent = '无法转换：' + rec.error;
        card.appendChild(err);
      }
      if (rec.warnings && rec.warnings.length) {
        const wr = document.createElement('div');
        wr.className = 'warn';
        wr.innerHTML = '<b>提示：</b>' + rec.warnings.slice(0, 6).map(esc).join('；') +
          (rec.warnings.length > 6 ? ' …' : '');
        card.appendChild(wr);
      }
      if (rec.brushes && rec.brushes.length) {
        const grid = document.createElement('div');
        grid.className = 'grid';
        rec.brushes.forEach((b, bi) => {
          const item = document.createElement('div');
          item.className = 'brush-item' + (b.enabled === false ? ' off' : '');
          const tipCv = document.createElement('canvas');
          tipCv.className = 'tip';
          strokePreview(b, tipCv);
          const info = document.createElement('div');
          info.className = 'binfo';
          const tags = [];
          if (b.pressure) tags.push('<span class="tag">压感</span>');
          if (b.tipSource === 'synth') tags.push('<span class="tag gray">合成圆头</span>');
          if (b.hasGrain) tags.push('<span class="tag gray">纹理略</span>');
          info.innerHTML = `<div class="bname" title="${esc(b.name)}">${esc(b.name) || '未命名'}</div>
            <div class="bparams">尺寸 ${Math.round(b.sizePx || 0)}px · 间距 ${(b.spacingPct || 0).toFixed(1)}% · 不透明度 ${Math.round((b.opacity === undefined ? 1 : b.opacity) * 100)}% ${tags.join(' ')}</div>`;
          const toggle = document.createElement('label');
          toggle.className = 'tog';
          toggle.innerHTML = `<input type="checkbox" ${b.enabled === false ? '' : 'checked'}><span>转换</span>`;
          toggle.querySelector('input').onchange = e => {
            b.enabled = e.target.checked;
            item.classList.toggle('off', !e.target.checked);
          };
          item.appendChild(tipCv);
          item.appendChild(info);
          item.appendChild(toggle);
          grid.appendChild(item);
        });
        card.appendChild(grid);
      }
      filesEl.appendChild(card);
    });
    refreshSelAllLabel();
  }

  /* ---------------- loading ---------------- */
  function kindLabel(kind) {
    return { abr: 'Photoshop ABR', procreate: 'Procreate', bru: '画世界Pro BRU', zip: '压缩包' }[kind] || '未知';
  }

  function makeRecord(name, bytes) {
    const rec = { name: name, size: bytes ? bytes.length : 0, bytes: bytes, brushes: null, warnings: [], error: null };
    state.files.push(rec);
    return rec;
  }

  function adoptParsed(rec, bytes, parsed, displayName) {
    rec.pkgId = BC.util.uid();
    rec.baseName = (displayName || rec.name).replace(/\.[^.]+$/, '').split('/').pop();
    rec.kind = parsed.kind;
    rec.kindLabel = kindLabel(parsed.kind);
    rec.warnings = (rec.warnings || []).concat(parsed.warnings || []);
    rec.brushes = parsed.brushes.map(b => {
      const copy = Object.assign({}, b);
      copy.enabled = true;
      if (!b.tip) copy.tipSource = 'synth';
      return copy;
    });
    rec.origBrushes = parsed.brushes.length;
  }

  async function parseRecord(rec, displayName, bytes, opts) {
    try {
      const big = bytes && bytes.length > 8 * 1024 * 1024;
      if (big && BC.convert.parseFileAsync) {
        const parsed = await BC.convert.parseFileAsync(displayName, bytes, Object.assign({}, opts, {
          onProgress: function (p, text) { setProgress(p, text + '：' + displayName); }
        }));
        setProgress(null);
        adoptParsed(rec, bytes, parsed, displayName);
      } else {
        const parsed = BC.convert.parseFile(displayName, bytes, opts);
        adoptParsed(rec, bytes, parsed, displayName);
      }
    } catch (e) {
      setProgress(null);
      rec.error = e.message;
    }
  }

  /* Expand a zip into one record per brush file found inside. */
  async function addZip(name, bytes, depth) {
    depth = depth || 0;
    let res;
    try {
      res = BC.convert.expandArchive(name, bytes, depth);
    } catch (e) {
      const rec = makeRecord(name, bytes);
      rec.error = e.message;
      rec.kindLabel = '压缩包';
      render();
      return 0;
    }
    let added = 0;
    for (const inner of res.files) {
      const rec = makeRecord(name + ' / ' + inner.name, inner.bytes);
      const innerOpts = inner.decrypted ? { decrypted: inner.decrypted } : null;
      parseRecord(rec, inner.name, inner.bytes, innerOpts);
      rec.fromZip = name;
      added++;
      render();
      await sleep(0);
    }
    if (!added) {
      const rec = makeRecord(name, bytes);
      rec.kindLabel = '压缩包';
      rec.error = (res.warnings && res.warnings[0]) || '压缩包里没有可识别的笔刷文件';
      render();
    }
    return added;
  }

  async function addFiles(fileList) {
    const arr = Array.from(fileList || []);
    for (const f of arr) {
      const bytes = await readFileBytes(f).catch(() => null);
      if (!bytes) {
        const rec = makeRecord(f.name, null);
        rec.error = '读取文件失败';
        render();
        continue;
      }
      if (bytes.length > 150 * 1024 * 1024) {
        window.__brushLogs = window.__brushLogs || [];
        window.__brushLogs.push(new Date().toISOString() + ' 大文件 ' + f.name + ' ' + Math.round(bytes.length / 1048576) + 'MB');
        toast('文件较大（' + Math.round(bytes.length / 1048576) + 'MB），解析可能占用较多内存', 5000);
      }
      const kind = BC.convert.detect(f.name, bytes);
      let opts = null;
      if (kind === 'sut' && f.path && window.BrushDesktop && window.BrushDesktop.sutDecrypted) {
        try {
          const dec = await window.BrushDesktop.sutDecrypted(f.path);
          if (dec && dec.json) opts = { decrypted: dec };
        } catch (e) { /* fall back to plain .sut */ }
      }
      if (!kind && BC.zip.isZip(bytes)) {
        await addZip(f.name, bytes, 0);
        continue;
      }
      const rec = makeRecord(f.name, bytes);
      render();
      await sleep(0);
      if (!kind) {
        rec.error = '无法识别的文件格式（支持 .abr/.bru/.brush/.brushset，或包含笔刷的 ZIP）';
        render();
        continue;
      }
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      setProgress(null, '解析中：' + f.name);
      await sleep(0);
      await parseRecord(rec, f.name, bytes);
      rec.parseMs = Math.max(1, Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0));
      setProgress(null);
      render();
      await sleep(0);
    }
  }

  /* ---------------- convert ---------------- */
  function getOpts() {
    const tipSize = parseInt($('#optTipSize').value, 10) || 512;
    const sizeScale = Math.max(0.05, Math.min(10, parseFloat($('#optSizeScale').value) || 1));
    const spacingVal = parseFloat($('#optSpacing').value);
    const spacingOverride = isFinite(spacingVal) && spacingVal > 0 ? spacingVal : 0;
    const pressureMode = $('#optPressure').value;
    const prefix = $('#optPrefix').value || '';
    const groupBySource = $('#optGroup') ? $('#optGroup').value === '1' : false;
    const mode = $('#optMode') ? $('#optMode').value : 'pack';
    const target = $('#optTarget') ? $('#optTarget').value : 'bru';
    const packOut = $('#optPack') ? $('#optPack').value !== 'files' : true;
    const goScatter = $('#optGoScatter') ? $('#optGoScatter').value : 'auto';
    const grainBake = $('#optGrainBake') ? $('#optGrainBake').value !== 'off' : true;
    const fidelity = $('#optFidelity') ? $('#optFidelity').value !== 'off' : true;
    const textureMode = $('#optTextureMode') ? $('#optTextureMode').value : 'bake';
    return { tipSize, sizeScale, spacingOverride, pressureMode, prefix, groupBySource, mode, target, packOut, goScatter, grainBake, fidelity, textureMode };
  }

  function toast(msg, ms) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms || 3000);
  }

  function setOutputLocation(text) {
    const el = document.getElementById('outPathText');
    if (!el) return;
    el.textContent = text || '已取消保存';
  }

  function defaultOutputHint() {
    const ua = (navigator.userAgent || '').toLowerCase();
    const isIOS = /iphone|ipad|ipod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) return '「文件」App → 下载项（Safari 下载后可分享存到「文件」）';
    if (window.BrushNative) return '下载 / 画世界笔刷 /（安卓）';
    if (window.BrushDesktop) return '转换时选择文件夹（桌面版）';
    return '浏览器默认下载目录';
  }

  function setProgress(p, text) {
    if (p === null) { progressEl.classList.add('hidden'); return; }
    progressEl.classList.remove('hidden');
    progressEl.querySelector('.bar').style.width = Math.round(p * 100) + '%';
    progressEl.querySelector('.ptext').textContent = text || '';
  }

  async function convertAll() {
    if (state.converting) return;
    const opts = getOpts();
    const records = state.files.filter(r => r.brushes && r.brushes.some(b => b.enabled !== false));
    const totalBrushes = records.reduce((s, r) => s + r.brushes.filter(b => b.enabled !== false).length, 0);
    if (!records.length || !totalBrushes) { toast('没有可转换的笔刷'); return; }
    state.converting = true;
    render();
    const outFiles = [];
    const failed = [];
    const warnings = [];
    // ABR 目标：把源笔刷的真实纹理导出为 PNG，用户可在 PS「编辑→定义图案」后手动指定（可调纹理）
    if (opts.target === 'abr' || opts.target === 'all') {
      try {
        const seenTex = {};
        let texIndex = 0;
        for (const rec of records) {
          const list = rec.brushes || [];
          for (const b of list) {
            if (!b || !b.hasTexture) continue;
            const tex = BC.convert.makeTexturePng(b);
            if (!tex) continue;
            const key = tex.w + 'x' + tex.h + ':' + BC.util.md5(tex.bytes);
            if (seenTex[key]) continue;
            seenTex[key] = 1;
            texIndex++;
            outFiles.push({ name: '纹理_' + texIndex + '_' + tex.w + 'x' + tex.h + '.png', data: tex.bytes });
          }
        }
        if (texIndex) warnings.push('已导出 ' + texIndex + ' 张纹理 PNG：在 PS 里「编辑→定义图案」后可手动指定给画笔纹理（可调深度/缩放）');
      } catch (e) { warnings.push('纹理导出失败：' + e.message); }
    }
    let commonPat = null;
    // 图案文件模式：用第一支有真实纹理的笔刷生成一份 .pat，ABR 里写 Txtr 引用它
    if (opts.textureMode === 'pattern' && (opts.target === 'abr' || opts.target === 'all')) {
      try {
        let texBrush = null;
        for (const rec of records) {
          for (const b of rec.brushes) {
            if (b && b.enabled !== false && b.hasTexture && (b._patternPixels || b._grainRgba)) { texBrush = b; break; }
          }
          if (texBrush) break;
        }
        if (!texBrush) {
          warnings.push('本次没有带纹理的笔刷，未生成 .pat（普通笔刷只需 .abr）');
        } else {
          const pat = BC.convert.makePatternFile([texBrush], { size: 256 });
          commonPat = { id: pat.ref.id, name: pat.ref.name };
          outFiles.push({ name: '纹理图案_导入PS图案面板.pat', data: pat.bytes });
          warnings.push('已生成 纹理图案_导入PS图案面板.pat：先在 PS 图案面板导入它，再导入 ABR，纹理才可调');
        }
      } catch (e) { warnings.push('图案生成失败：' + e.message); }
    }
    const ALL_FORMATS = ['bru', 'abr', 'gopaint', 'gopaint_set', 'gopaint_abr', 'brushset', 'brush', 'gbr', 'gih',
      'myb', 'kbundle', 'sai2', 'png', 'painter', 'medibang'];
    const usedFileNames = new Set();
    let doneCount = 0;

    function uniqueFile(base, ext) {
      let name = base, k = 2;
      while (usedFileNames.has((name + ext).toLowerCase())) { name = base + ' (' + k + ')'; k++; }
      usedFileNames.add((name + ext).toLowerCase());
      return name + ext;
    }
    function pressureOpt() {
      return opts.pressureMode === 'on' ? true : opts.pressureMode === 'off' ? false : undefined;
    }
    function commonOpts(rec) {
      return {
        maxTipSize: opts.tipSize,
        sizeScale: opts.sizeScale,
        spacingOverride: opts.spacingOverride,
        pressure: pressureOpt(),
        pkgId: rec.pkgId,
        scatter: opts.goScatter === 'auto' ? undefined : Number(opts.goScatter),
        noTextureBake: opts.grainBake === false,
        patternRef: commonPat,
        fidelity: opts.fidelity === false ? false : undefined,
        textureMode: opts.textureMode === 'pattern' ? 'pattern' : undefined
      };
    }

    for (const rec of records) {
      const list = rec.brushes.filter(b => b.enabled !== false);
      if (!list.length) continue;
      const targets = opts.target === 'all' ? ALL_FORMATS : [opts.target || 'bru'];
      if (opts.target === 'all' && opts.mode === 'pack') {
        warnings.push('全部格式：会生成 ' + ALL_FORMATS.length + ' 种格式，文件较多，请耐心等待');
      }
      if (opts.mode === 'pack') {
        // whole set -> one file per target format
        setProgress(doneCount / totalBrushes, '正在打包 ' + (rec.baseName || rec.name) + '（' + list.length + ' 支）…');
        await sleep(0);
        const sourceName = rec.baseName || rec.name.replace(/\.[^.]+$/, '') || '笔刷集';
        const base = BC.convert.sanitizeName(opts.prefix + sourceName, 0);
        for (const fmt of targets) {
          try {
            if (fmt === 'brushset') {
              const made = BC.convert.makeProcreateBrushset(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base, '.brushset'), data: made.bytes });
            } else if (fmt === 'brush' || fmt === 'gbr' || fmt === 'myb') {
              for (const b of list) {
                const co = commonOpts(rec);
                const made = fmt === 'brush'
                  ? BC.convert.makeProcreateBrush(b, co)
                  : fmt === 'gbr' ? BC.convert.makeGbr(b, co)
                  : fmt === 'myb' ? BC.convert.makeMyb(b, co)
                  : BC.convert.makeIpcfg(b, co);
                const bname = BC.convert.sanitizeName(opts.prefix + (b.name || 'brush'), 0);
                outFiles.push({ name: uniqueFile(bname, '.' + fmt), data: made.bytes });
              }
            } else if (fmt === 'sai2') {
              const made = BC.convert.makeSai2Pack(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base + '_SAI2', '.zip'), data: made.bytes });
              if (made.warnings && made.warnings.length) warnings.push(...made.warnings);
            } else if (fmt === 'kbundle') {
              const made = BC.convert.makeKritaBundle(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base + '_krita', '.bundle'), data: made.bytes });
            } else if (fmt === 'gih') {
              const made = BC.convert.makeGih(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base, '.gih'), data: made.bytes });
            } else if (fmt === 'painter') {
              const made = BC.convert.makePainter(list, commonOpts(rec), sourceName);
              outFiles.push({ name: uniqueFile(base, '.brushcategory'), data: made.bytes });
            } else if (fmt === 'medibang') {
              for (const b of list) {
                const made = BC.convert.makeMediBangBrush(b, commonOpts(rec));
                const bname = BC.convert.sanitizeName(opts.prefix + (b.name || 'medibang'), 0);
                outFiles.push({ name: uniqueFile(bname + '_MediBang笔刷', '.zip'), data: made.bytes });
              }
            } else if (fmt === 'png') {
              const made = BC.convert.makeTipPngPack(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base + '_笔尖', '.zip'), data: made.bytes });
            } else if (fmt === 'gopaint_set') {
              const made = BC.convert.makeGoPaintGroup(list, Object.assign({}, commonOpts(rec), { groupName: (opts.prefix || '') + base }));
              outFiles.push({ name: uniqueFile(base + '_天生会画笔刷组', '.gobrushes'), data: made.bytes });
            } else if (fmt === 'gopaint') {
              for (const b of list) {
                const made = BC.convert.makeGoPaintBrush(b, commonOpts(rec));
                outFiles.push({ name: uniqueFile(BC.convert.sanitizeName(opts.prefix + (b.name || 'gopaint'), 0), '.gobrush'), data: made.bytes });
              }
            } else if (fmt === 'gopaint_abr') {
              const made = BC.convert.makeGoPaintAbr(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base + '_天生会画_ABR', '.abr'), data: made.bytes });
            } else if (fmt === 'abr') {
              // 源就是 .abr 且整包导出时：原样透传，100% 保留文件夹分组 / 动态 / 计算画笔
              const isAbrSource = /^abr$/i.test(rec.kind || '') || /\.abr$/i.test(rec.name || '');
              const allSelected = rec.brushes && list.length === rec.brushes.length;
              if (isAbrSource && allSelected) {
                // 整包 ABR→ABR 等于复制文件，没必要产出；只有筛选子集/合并才需要重新打包
                warnings.push((rec.name || 'ABR') + '：源文件已经是 .abr 且整包导出，跳过（如需筛选/拆分，请只勾选部分笔刷）');
              } else {
                const made = BC.convert.makeAbrPack(list, commonOpts(rec));
                outFiles.push({ name: uniqueFile(base, '.abr'), data: made.bytes });
              }
            } else {
              const made = BC.convert.makeBruPack(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base, '.bru'), data: made.bytes });
            }
          } catch (e) {
            list.forEach(b => failed.push((b.name || '未命名') + '（.' + fmt + '）：' + e.message));
          }
          await sleep(0);
        }
        doneCount += list.length;
        setProgress(doneCount / totalBrushes, '已完成 ' + doneCount + '/' + totalBrushes);
        await sleep(0);
        continue;
      }
      // per-brush mode
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        setProgress((doneCount + 0.5) / totalBrushes, '正在转换 ' + (doneCount + 1) + '/' + totalBrushes + '：' + (b.name || ''));
        const order = String(i + 1).padStart(2, '0');
        const srcTag = rec.baseName ? rec.baseName.trim() : '';
        const brushTag = (b.name || '').trim();
        const composed = opts.prefix + (srcTag ? srcTag + (brushTag ? ' - ' : ' ') : '') + (brushTag || ('笔刷 ' + order));
        const base = BC.convert.sanitizeName(composed, doneCount);
        const folder = opts.groupBySource && rec.baseName ? BC.convert.sanitizeName(rec.baseName, 0) + '/' : '';
        for (const fmt of targets) {
          try {
            if (fmt === 'brushset') continue;
            const co = commonOpts(rec);
            const made = fmt === 'abr'
              ? BC.convert.makeAbrPack([b], co)
              : fmt === 'gopaint' ? BC.convert.makeGoPaintBrush(b, co)
              : fmt === 'gopaint_abr' ? BC.convert.makeGoPaintAbr([b], co)
              : fmt === 'brush' ? BC.convert.makeProcreateBrush(b, co)
              : fmt === 'gbr' ? BC.convert.makeGbr(b, co)
              : fmt === 'myb' ? BC.convert.makeMyb(b, co)
              : fmt === 'sai2' ? BC.convert.makeSai2Pack([b], co)
              : fmt === 'kbundle' ? BC.convert.makeKritaBundle([b], co)
              : fmt === 'gih' ? BC.convert.makeGih([b], co)
              : fmt === 'painter' ? BC.convert.makePainter([b], co, b.name)
              : fmt === 'medibang' ? BC.convert.makeMediBangBrush(b, co)
              : fmt === 'png' ? BC.convert.makeTipPng(b, co)
              : BC.convert.makeBru(b, co);
            const extOut = { painter: '.brushcategory', kbundle: '.bundle', sai2: '.zip', medibang: '.zip', gopaint_set: '.gobrushes' }[fmt] || ('.' + fmt);
            outFiles.push({ name: folder + uniqueFile(base, extOut), data: made.bytes });
            if (fmt === 'png') {
              // PNG 笔尖旁边同时输出该笔刷的参数，方便在目标软件里手动还原设置
              outFiles.push({
                name: folder + uniqueFile(base + '_参数', '.txt'),
                data: BC.util.utf8Encode(BC.convert.brushParamText([b]))
              });
            }
          } catch (e) {
            failed.push((b.name || '未命名') + '（.' + fmt + '）：' + e.message);
          }
        }
        doneCount++;
        if (i % 3 === 2) await sleep(0);
      }
      setProgress(doneCount / totalBrushes, '已完成 ' + doneCount + '/' + totalBrushes);
      await sleep(0);
    }

    setProgress(0.99, opts.packOut === false ? '正在保存文件…' : '正在打包 ZIP…');
    await sleep(10);
    if (!outFiles.length) {
      // 附带：一键安装说明 + 转换差异报告
    try {
      const allTargets = opts.target === 'all' ? ALL_FORMATS : [opts.target || 'bru'];
      for (const t of allTargets) {
        for (const f of BC.convert.makeInstallScripts(t)) {
          outFiles.push({ name: '安装/' + t + '/' + f.name, data: f.data });
        }
      }
      const reportBrushes = records.reduce(function (acc, r) { return acc.concat(r.brushes.filter(function (b) { return b.enabled !== false; })); }, []);
      outFiles.push({ name: '转换报告.txt', data: BC.util.utf8Encode(BC.convert.brushLossReport(reportBrushes, allTargets)) });
    } catch (e) { warnings.push('安装说明/报告生成失败：' + e.message); }

    state.converting = false;
      setProgress(null);
      render();
      toast('转换失败：' + (failed[0] || '未知错误'), 6000);
      return;
    }
    // prepare output payload: zip mode -> one zip; files mode -> individual files
    let payload;
    if (opts.packOut === false) {
      payload = outFiles;
    } else {
      const zipBytes = BC.zip.write(outFiles);
      const ts = new Date();
      const pad = n => String(n).padStart(2, '0');
      const stamp = ts.getFullYear() + pad(ts.getMonth() + 1) + pad(ts.getDate()) + '_' + pad(ts.getHours()) + pad(ts.getMinutes());
      payload = [{ name: '画世界笔刷_' + stamp + '.zip', data: zipBytes }];
    }
    setProgress(0.995, opts.packOut === false ? '正在保存文件…' : '正在打包 ZIP…');
    let savedMsg = '';
    try {
      savedMsg = await saveOutputs(payload, { packOut: opts.packOut !== false });
    } catch (e) {
      toast('保存失败：' + (e && e.message ? e.message : e), 7000);
      state.converting = false;
      setProgress(null);
      render();
      return;
    }
    state.converting = false;
    setProgress(null);
    render();
    if (savedMsg === null) return; // user cancelled
    if (savedMsg && String(savedMsg).indexOf('ERROR') === 0) {
      toast('保存失败：' + String(savedMsg).slice(6), 7000);
      return;
    }
    let msg = '完成：' + outFiles.length + ' 个文件（共 ' + doneCount + ' 支笔刷）';
    if (failed.length) msg += '，' + failed.length + ' 支失败';
    if (warnings.length) msg += '｜' + warnings[0] + (warnings.length > 1 ? ' 等 ' + warnings.length + ' 条提示' : '');
    toast(msg + (savedMsg ? '｜' + savedMsg : ''), 9000);
    setOutputLocation(savedMsg);
  }

  /* Output saving is delegated to the environment adapter (window.BCSaver):
     - web / desktop / android builds load save-legacy.js
     - the minitool build loads save-minitool.js (container file system API) */
  async function saveOutputs(files, saveOpts) {
    const saver = window.BCSaver;
    if (!saver || typeof saver.save !== 'function') {
      toast('当前环境不支持保存文件', 7000);
      return '';
    }
    return await saver.save(files, saveOpts || {}, {
      progress: function (p, text) { setProgress(0.99 + 0.009 * p, text); }
    });
  }
  /* ---------------- built-in sample brushes ---------------- */
  /* The minitool container can only pick images/videos, so the packaged
     minitool build offers these runtime-generated sample brushes. */
  window.BCDemo = {
    loadSample: function () {
      if (state.converting) return;
      const demos = [
        { name: '圆头硬笔', sizePx: 40, spacingPct: 5, opacity: 1, pressure: true, minSizeRatio: 0.25, hardness: 0.95, roundness: 1 },
        { name: '软毛刷', sizePx: 120, spacingPct: 12, opacity: 0.75, pressure: true, minSizeRatio: 0.1, hardness: 0.35, roundness: 1 },
        { name: '扁笔', sizePx: 90, spacingPct: 8, opacity: 0.9, pressure: true, minSizeRatio: 0.4, hardness: 0.8, roundness: 0.55 },
        { name: '纹理笔', sizePx: 130, spacingPct: 20, opacity: 0.85, pressure: false, minSizeRatio: 1, hardness: 0.6, roundness: 0.9 }
      ];
      const rec = {
        name: '内置示例笔刷', baseName: '内置示例笔刷', kind: 'demo', kindLabel: '示例',
        pkgId: BC.util.uid(), bytes: null, size: 0, brushes: [],
        warnings: ['内置示例笔刷：不依赖文件选择，用来直接体验转换；真实笔刷文件请在桌面版 / 安卓版导入。']
      };
      demos.forEach(function (d) {
        rec.brushes.push(Object.assign({ source: 'demo', enabled: true }, d));
      });
      state.files.push(rec);
      render();
      toast('已载入内置示例笔刷（4 支），可直接选择目标格式转换', 5000);
    }
  };

  /* ---------------- 全选 / 取消全选 ---------------- */
  const btnSelAll = document.getElementById('btnSelectAll');
  function refreshSelAllLabel() {
    if (!btnSelAll) return;
    const all = state.files.flatMap(r => r.brushes || []);
    const anyOff = all.some(b => b.enabled === false);
    btnSelAll.textContent = all.length && !anyOff ? '取消全选' : '全选笔刷';
  }
  if (btnSelAll) {
    btnSelAll.onclick = () => {
      const all = state.files.flatMap(r => r.brushes || []);
      if (!all.length) { toast('还没有可选的笔刷'); return; }
      const anyOff = all.some(b => b.enabled === false);
      all.forEach(b => { b.enabled = anyOff ? true : false; });
      render();
      toast(anyOff ? ('已全选 ' + all.length + ' 支笔刷') : '已取消全选');
    };
  }

  /* ---------------- 首次打开公告弹窗 ---------------- */
  const NOTICE_KEY = 'brushconv_notice_20261022_seen';
  function noticeHtml() {
    return '<h2>公告</h2>' +
      '<div class="modal-body">本工具<b>免费发布</b>，获取地址：<br>' +
      '<a href="https://xhslink.cn/o/3oISiVWckx3" target="_blank" rel="noopener">https://xhslink.cn/o/3oISiVWckx3</a><br>' +
      'QQ：<b>941034827</b><br>' +
      '如付费获取，请联系商家退款。</div>' +
      '<div class="modal-thanks">特别感谢：<a href="https://github.com/tohsakarat/Brush-Converter" target="_blank" rel="noopener">tohsakarat / Brush-Converter</a>（提供了 PS6 文件格式规范与 ABR 参数解析参考，本项目仅参考其公开规范与思路，未使用其代码）</div>' +
      '<div class="modal-note">此公告仅在第一次打开时显示，之后可在页面底部点「公告」再次查看。</div>' +
      '<div class="modal-actions"><button type="button" data-close>我知道了</button></div>';
  }
  function showNoticeModal() {
    const old = document.querySelector('.modal-backdrop');
    if (old) old.remove();
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    const card = document.createElement('div');
    card.className = 'modal-card';
    card.innerHTML = noticeHtml();
    back.appendChild(card);
    document.body.appendChild(back);
    back.addEventListener('click', function (e) {
      if (e.target === back || (e.target && e.target.hasAttribute('data-close'))) {
        try { localStorage.setItem(NOTICE_KEY, '1'); } catch (err) { /* ignore */ }
        back.remove();
      }
    });
  }
  function initNotice() {
    let seen = '';
    try { seen = localStorage.getItem(NOTICE_KEY) || ''; } catch (e) { seen = ''; }
    if (!seen) showNoticeModal();
    const footer = document.querySelector('.footer');
    if (footer && !document.getElementById('showNotice')) {
      const a = document.createElement('a');
      a.id = 'showNotice';
      a.href = 'javascript:void(0)';
      a.textContent = '公告';
      a.style.cssText = 'margin-left:10px;color:#2563eb;text-decoration:underline;cursor:pointer;font-size:12px';
      a.addEventListener('click', showNoticeModal);
      footer.appendChild(a);
    }
  }

  /* 初始化输出位置提示 */
  setOutputLocation(defaultOutputHint());
  initNotice();

  /* ---------------- events ---------------- */
  dz.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => {
    addFiles(e.target.files);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach(ev => {
    dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dz.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(ev => {
    dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('over'); });
  });
  dz.addEventListener('drop', e => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) addFiles(dt.files);
  });
  // 本地日志（不联网）：记录错误/警告，便于反馈
  window.__brushLogs = window.__brushLogs || [];
  function pushLog(line) { window.__brushLogs.push(new Date().toISOString() + ' ' + line); }
  window.addEventListener('error', function (e) { pushLog('ERROR ' + (e.message || e.type)); });
  window.addEventListener('unhandledrejection', function (e) { pushLog('REJECT ' + (e.reason && e.reason.message ? e.reason.message : e.reason)); });
  const btnLog = $('#btnLog');
  if (btnLog) btnLog.addEventListener('click', function () {
    const NL = String.fromCharCode(10);
    const head = '笔刷转换器 ' + ($('#ver') ? $('#ver').textContent : '') + NL + 'UA: ' + navigator.userAgent + NL + '时间: ' + new Date().toISOString() + NL;
    const body = (window.__brushLogs || []).join(NL) || '(无日志)';
    const data = BC.util.utf8Encode(head + body);
    const saver = window.BCSaver;
    if (saver && saver.save) saver.save([{ name: '运行日志.txt', data: data }], {});
    else toast('当前环境不支持保存日志');
  });
  btnConvert.addEventListener('click', convertAll);
  if ($('#optTarget')) $('#optTarget').addEventListener('change', function () { render(); });
  const btnDemo = $('#btnDemo');
  if (btnDemo) btnDemo.addEventListener('click', function (e) { e.stopPropagation(); window.BCDemo.loadSample(); });
  btnClear.addEventListener('click', () => {
    state.files = [];
    render();
  });

  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => e.preventDefault());

  $('#ver').textContent = 'v2.5.14 · 修复 Krita 预设（KPP 用 Krita 5 规范 + 新增 .bundle 含笔尖资源）· 纯本地';
  render();
})();
