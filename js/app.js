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

  const state = { files: [], converting: false, activeJob: false, saving: false, cancelRequested: false,
    // #262 导入中也能「清空」：用 token 让正在跑的导入循环立即停手，不再把卡片塞回来
    importToken: 0, importing: 0, lastWarnings: [], searchQuery: '', filterKind: 'all' };
  function isBusy() { return state.converting || state.activeJob || state.saving; }
  function isImporting() { return state.importing > 0; }

  const directoryControls = $('#saveDirectoryControls');
  const directoryButton = $('#btnSaveDirectory');
  const directoryText = $('#saveDirectoryText');
  async function refreshDirectory() {
    try {
      const dir = await window.BCSaver.getDirectory();
      directoryText.textContent = dir ? '保存目录：' + dir : '选择一次，后续保存复用该目录';
      directoryButton.textContent = dir ? '更改保存目录' : '选择保存目录';
    } catch (e) { directoryText.textContent = '读取保存目录失败：' + e.message; }
  }
  if (directoryControls && window.BCSaver && window.BCSaver.supportsDirectory && window.BCSaver.supportsDirectory()) {
    directoryControls.hidden = false;
    var exportRow = document.getElementById('exportRow');
    if (exportRow) exportRow.hidden = false;
    refreshDirectory();
    directoryButton.addEventListener('click', async function () {
      if (isBusy()) return;
      state.saving = true;
      updateConvertButton();
      try { await window.BCSaver.chooseDirectory(); await refreshDirectory(); }
      catch (e) { toast('选择保存目录失败：' + e.message, 7000); }
      finally { state.saving = false; updateConvertButton(); }
    });
  }

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
    // 大文件分块读取：避免一次性分配两份内存，并显示进度
    if (!file || file.size <= 32 * 1024 * 1024 || typeof file.slice !== 'function') {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(new Uint8Array(fr.result));
        fr.onerror = () => reject(new Error('读取文件失败'));
        fr.readAsArrayBuffer(file);
      });
    }
    const CHUNK = 8 * 1024 * 1024;
    return new Promise(function (resolve, reject) {
      const parts = [];
      let offset = 0;
      function next() {
        if (offset >= file.size) {
          const total = parts.reduce(function (n, p) { return n + p.length; }, 0);
          const out = new Uint8Array(total);
          let p = 0;
          parts.forEach(function (b) { out.set(b, p); p += b.length; });
          setProgress(null);
          resolve(out);
          return;
        }
        const blob = file.slice(offset, Math.min(file.size, offset + CHUNK));
        const fr = new FileReader();
        fr.onload = function () {
          parts.push(new Uint8Array(fr.result));
          offset += blob.size;
          setProgress(Math.min(0.99, offset / file.size), '读取中：' + file.name);
          next();
        };
        fr.onerror = function () { setProgress(null); reject(new Error('读取文件失败')); };
        fr.readAsArrayBuffer(blob);
      }
      next();
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
    /* 【第182轮】预览降采样：以前按原始尺寸建 canvas 并跑 w*h 次循环，
       一支 2048² 的笔尖就是 419 万次 + 16MB 像素；解析 53 支（黄土笔刷那种 brushset）
       等于 2.2 亿次循环、数百 MB 内存，主线程被占满，界面点两下就没响应。
       预览只需要 260×96 的画布，笔尖按 256 上限抽样即可，视觉上无差别。 */
    const MAXP = (opts && opts.maxPreviewPx) || 256;
    const scale = Math.max(1, Math.ceil(Math.max(w, h) / MAXP));
    const dw = Math.max(1, Math.floor(w / scale)), dh = Math.max(1, Math.floor(h / scale));
    cv.width = dw; cv.height = dh;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(dw, dh);
    // paint dark on light background so shape is visible（最邻近抽样，保留 alpha 对比）
    for (let y = 0; y < dh; y++) {
      const sy = y * scale;
      for (let x = 0; x < dw; x++) {
        const si = ((sy * w) + (x * scale)) * 4 + 3;
        const a = rgba[si] / 255;
        const v = Math.round(255 * (1 - a) * 0.85 + 30);
        const di = (y * dw + x) * 4;
        img.data[di] = v; img.data[di + 1] = v; img.data[di + 2] = v; img.data[di + 3] = 255;
      }
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
    // 离屏层画笔迹；有纹理时用纹理做遮罩（近似真实颗粒）
    const layer = document.createElement('canvas');
    layer.width = W; layer.height = H;
    const lctx = layer.getContext('2d');
    lctx.save();
    lctx.globalAlpha = Math.max(0.15, Math.min(1, alpha));
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
        lctx.save();
        lctx.translate(sx, sy);
        if (ang) lctx.rotate(ang);
        lctx.drawImage(tipCv, -w / 2, -h / 2, w, h);
        lctx.restore();
      }
    }
    lctx.restore();
    const tex = textureCanvas(brush);
    if (tex) {
      lctx.globalCompositeOperation = 'destination-in';
      lctx.fillStyle = lctx.createPattern(tex, 'repeat');
      lctx.fillRect(0, 0, W, H);
      lctx.globalCompositeOperation = 'source-over';
    }
    ctx.drawImage(layer, 0, 0);
  }

  /* 纹理遮罩画布（无纹理返回 null） */
  const textureCache = new WeakMap();
  function textureCanvas(brush) {
    if (textureCache.has(brush)) return textureCache.get(brush);
    let w = 0, h = 0, get = null;
    if (brush._grainRgba && brush._grainRgba.w) {
      w = brush._grainRgba.w; h = brush._grainRgba.h;
      get = function (x, y) { return brush._grainRgba.rgba[(y * w + x) * 4 + 3]; };
    } else if (brush._patternPixels && brush._patternPixels.w) {
      const pp = brush._patternPixels; w = pp.w; h = pp.h;
      get = function (x, y) {
        const i = y * w + x;
        if (pp.mode === 3) { const o = i * 3; return Math.round((pp.data[o] + pp.data[o + 1] + pp.data[o + 2]) / 3); }
        return pp.data[i];
      };
    } else return null;
    const n = 128;
    const cv = document.createElement('canvas');
    cv.width = n; cv.height = n;
    const c2 = cv.getContext('2d');
    const img = c2.createImageData(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const sx = Math.min(w - 1, Math.floor(x * w / n));
        const sy = Math.min(h - 1, Math.floor(y * h / n));
        const v = get(sx, sy);
        const o = (y * n + x) * 4;
        img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255; img.data[o + 3] = v;
      }
    }
    c2.putImageData(img, 0, 0);
    textureCache.set(brush, cv);
    return cv;
  }

  /* ---------------- rendering ---------------- */
  /* 事前预检：覆盖全部已勾选笔刷；参数级判断不代表视觉还原。 */
  function updatePrecheck() {
    const el = $('#precheck');
    if (!el) return;
    const sel = $('#optTarget');
    const target = sel ? sel.value : 'bru';
    const brushes = [];
    for (const rec of state.files) {
      for (const b of (rec.brushes || [])) {
        if (b && b.enabled !== false) brushes.push(b);
      }
    }
    if (!brushes.length || !BC.convert.brushLossReport) { el.style.display = 'none'; return; }
    try {
      const txt = BC.convert.brushLossReport(brushes, [target], getOpts());
      const lines = txt.split(String.fromCharCode(10));
      const lostLines = lines.filter(function (l) { return l.indexOf('丢失：') >= 0; });
      const names = [];
      lostLines.forEach(function (ln) {
        ln.replace(/丢失：/, '').split('、').forEach(function (x) {
          const nm = x.split('(')[0].trim();
          if (nm && names.indexOf(nm) < 0) names.push(nm);
        });
      });
      if (!names.length) {
        el.textContent = '预检：已检查 ' + brushes.length + ' 支，目标格式 ' + target + ' 未发现已知未写入项；参数检查不保证笔触一致';
      } else {
        el.textContent = '预检：已检查 ' + brushes.length + ' 支，目标格式 ' + target + ' 存在近似/未完整写入/丢失 ' + names.length + ' 类参数（' + names.slice(0, 8).join('、') + (names.length > 8 ? '…' : '') + '），详见转换报告';
      }
      el.style.display = '';
    } catch (e) { el.style.display = 'none'; }
    // 没有笔尖（shape）图的笔刷在预检里也要说清楚：转出后是参数生成的圆形/椭圆笔尖。
    try {
      const audit = BC.convert.tipSourceAudit ? BC.convert.tipSourceAudit(brushes) : null;
      if (audit && (audit.noTip.length || audit.grainOnly.length || (audit.bruTexMissing || []).length) && el.style.display !== 'none') {
        const parts = [];
        if (audit.noTip.length) parts.push(audit.noTip.length + ' 支没有笔尖(shape)图、会用参数生成笔尖');
        if (audit.grainOnly.length) parts.push(audit.grainOnly.length + ' 支只有纹理(grain)图当笔尖');
        // 第198轮：画世界「小方块/网点」类靠内置纹理出图案，纹理库没载入时会变实心圆
        if ((audit.bruTexMissing || []).length) parts.push(audit.bruTexMissing.length + ' 支画世界内置纹理未载入（需下载纹理库）');
        el.textContent += '；另 ' + parts.join('，');
      }
    } catch (e) { /* ignore */ }
  }
  function updateConvertButton() {
    const allBrushes = state.files.reduce(function (acc, f) { return acc.concat(f.brushes || []); }, []);
    const total = allBrushes.filter(function (b) { return b.enabled !== false; }).length;
    const sel = $('#optTarget');
    const fmtLabel = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text : '';
    const packMode = $('#optPack') ? $('#optPack').value !== 'files' : true;
    const outText = packMode ? '转换并下载' : '转换并保存文件';
    const busy = isBusy();
    // #262 导入没完成前不能开转，否则解析中的卡片跟输出对不上
    btnConvert.disabled = !total || busy || isImporting();
    fileInput.disabled = busy;
    btnClear.disabled = busy;
    ['#btnLog', '#btnShare', '#btnShareResult', '#btnSelectAll', '#btnSaveDirectory', '#btnCompare'].forEach(function (id) { const el=$(id); if(el)el.disabled=busy; });
    // data-dep-off：由设置分组按其它选项暂时禁用的项（如「按来源分文件夹」只在单独文件模式可用），转换结束后不能被这里重新放开
    document.querySelectorAll('#options input, #options select').forEach(function (el) { el.disabled = busy || el.dataset.depOff === '1'; });
    filesEl.classList.toggle('locked', busy);
    // 转换/保存期间卡片内的勾选框也要禁用：pointer-events 只挡鼠标，Tab+空格仍能改状态，
    // 会让输出结果随按键漂移（#259）。
    filesEl.querySelectorAll('input').forEach(function (el) { el.disabled = busy; });
    dz.setAttribute('aria-disabled', String(busy));
    btnConvert.textContent = total
      ? outText + '（已选 ' + total + ' 支 · ' + fmtLabel + '）'
      : (allBrushes.length ? '请至少勾选 1 支笔刷' : outText);
    updatePreviewToolbar(allBrushes.length, total);
  }

  function matchesBrushFilter(b) {
    if (!b) return false;
    const fk = state.filterKind || 'all';
    if (fk === 'dual' && !b.dualOn) return false;
    if (fk === 'textured' && !(b.hasTexture || b.hasGrain || b._grainRgba || b._patternPixels)) return false;
    if (fk === 'synth' && b.tipSource !== 'synth') return false;
    const q = String(state.searchQuery || '').trim().toLowerCase();
    if (q) {
      const name = String(b.name || '未命名').toLowerCase();
      const dualName = b.dualBrush && b.dualBrush.name ? String(b.dualBrush.name).toLowerCase() : '';
      if (name.indexOf(q) < 0 && dualName.indexOf(q) < 0) return false;
    }
    return true;
  }

  function updatePreviewToolbar(totalCount, selectedCount) {
    const tb = $('#previewToolbar');
    const sum = $('#previewSummary');
    if (!tb) return;
    if (totalCount === undefined) {
      const all = state.files.reduce(function (acc, f) { return acc.concat(f.brushes || []); }, []);
      totalCount = all.length;
      selectedCount = all.filter(function (b) { return b.enabled !== false; }).length;
    }
    tb.hidden = !state.files.length || !totalCount;
    if (sum) {
      sum.textContent = '共 ' + state.files.length + ' 个文件 · 已选 ' + selectedCount + ' / ' + totalCount + ' 支';
    }
    const busy = isBusy();
    const invBtn = $('#btnInvertSel');
    if (invBtn) invBtn.disabled = busy;
    const searchEl = $('#brushSearch');
    if (searchEl) searchEl.disabled = busy;
  }

  /* 预览绘制排队：只画进入可视区域的卡片，每帧少量 */
  let previewObserver = null;
  function observePreview(cv, brush) {
    if (typeof IntersectionObserver === 'undefined') { schedulePreview(cv, brush); return; }
    if (!previewObserver) {
      previewObserver = new IntersectionObserver(function (entries) {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const t = en.target;
          previewObserver.unobserve(t);
          if (t._brush) schedulePreview(t, t._brush);
        }
      }, { rootMargin: '300px 0px' });
    }
    cv._brush = brush;
    previewObserver.observe(cv);
  }
  let previewQueue = [];
  let previewScheduled = false;
  function schedulePreview(cv, brush) {
    previewQueue.push({ cv: cv, brush: brush });
    if (!previewScheduled) {
      previewScheduled = true;
      const run = function () {
        const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        let n = 0;
        while (previewQueue.length && n < 3 && (typeof performance === 'undefined' || performance.now() - t0 < 8)) {
          const it = previewQueue.shift();
          try { strokePreview(it.brush, it.cv); } catch (e) { /* 忽略单支失败 */ }
          n++;
        }
        if (previewQueue.length) requestAnimationFrame(run);
        else previewScheduled = false;
      };
      requestAnimationFrame(run);
    }
  }

  /* 批量选择后只同步已有 DOM，不重建整个列表 */
  function syncSelectionUI() {
    if (state.__brushUI) {
      state.__brushUI.forEach(function (ui) {
        const on = ui.brush.enabled !== false;
        ui.input.checked = on;
        ui.item.classList.toggle('off', !on);
      });
    }
    updateConvertButton();
    refreshSelAllLabel();
    if (typeof updatePrecheck === 'function') { clearTimeout(state._precheckT); state._precheckT = setTimeout(updatePrecheck, 120); }
  }

  function makeBrushItem(rec, b, bi, fi) {
    const item = document.createElement('div');
    item.className = 'brush-item' + (b.enabled === false ? ' off' : '');
    const tipCv = document.createElement('canvas');
    tipCv.className = 'tip';
    tipCv.width = 260; tipCv.height = 96;
    observePreview(tipCv, b);
    const info = document.createElement('div');
    info.className = 'binfo';
    const tags = [];
    if (b.pressure) tags.push('<span class="tag">压感</span>');
    if (b.tipSource === 'synth') tags.push('<span class="tag gray">合成圆头</span>');
    if (b.shapeFromLibrary) tags.push('<span class="tag">图库补回</span>');
    if (b.hasTexture && (b._grainRgba || b._patternPixels)) tags.push('<span class="tag teal">纹理</span>');
    else if (b.hasGrain) tags.push('<span class="tag gray">纹理略</span>');
    if (b.scatterOn && (b.scatterPct || 0) > 0) tags.push('<span class="tag">散布</span>');
    if (b.dualOn) {
      const di = b.dualBrush || {};
      const dt = '双笔刷：' + (di.name || '第二支笔尖') + ' · ' + (di.blend || '') +
        (di.diameter ? ' · ' + Math.round(di.diameter) + 'px' : '') +
        (di.useScatter ? ' · 散布' + Math.round(di.scatterPct || 0) + '%×' + (di.count || 1) : '');
      tags.push('<span class="tag" title="' + esc(dt) + '">双笔刷</span>');
    }
    info.innerHTML = '<div class="bname" title="' + esc(b.name) + '">' + (esc(b.name) || '未命名') + '</div>' +
      '<div class="bparams">尺寸 ' + Math.round(b.sizePx || 0) + 'px · 间距 ' + (b.spacingPct || 0).toFixed(1) + '% · 不透明度 ' +
      Math.round((b.opacity === undefined ? 1 : b.opacity) * 100) + '% ' + tags.join(' ') + '</div>';
    const toggle = document.createElement('label');
    toggle.className = 'tog';
    toggle.innerHTML = '<input type="checkbox" ' + (b.enabled === false ? '' : 'checked') + '><span>转换</span>';
    const inputEl = toggle.querySelector('input');
    inputEl.disabled = isBusy();
    const applyToggle = checked => {
      b.enabled = checked;
      inputEl.checked = checked;
      item.classList.toggle('off', !checked);
      updateConvertButton();
      refreshSelAllLabel();
      if (typeof updatePrecheck === 'function') { clearTimeout(state._precheckT); state._precheckT = setTimeout(updatePrecheck, 120); }
    };
    inputEl.onchange = e => applyToggle(e.target.checked);
    item.addEventListener('click', e => {
      if (isBusy() || toggle.contains(e.target)) return;
      applyToggle(!inputEl.checked);
    });
    item.appendChild(tipCv);
    item.appendChild(info);
    item.appendChild(toggle);
    const uiKey = (rec.pkgId || ('f' + fi)) + ':' + bi;
    state.__brushUI.set(uiKey, { item: item, input: inputEl, brush: b });
    return item;
  }

  function appendBrushItems(grid, rec, fi, start, count, indices) {
    const end = Math.min(indices ? indices.length : rec.brushes.length, start + count);
    for (let i = start; i < end; i++) {
      const bi = indices ? indices[i] : i;
      grid.appendChild(makeBrushItem(rec, rec.brushes[bi], bi, fi));
    }
  }

  function render() {
    // render() 会整体重建卡片：旧 canvas 必须从 observer 里断开，
    // 否则反复切换目标格式时旧 canvas（含 _brush 像素引用）一直被持有。
    if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
    filesEl.innerHTML = '';
    previewQueue.length = 0;
    previewScheduled = false;
    state.__brushUI = new Map();
    const allBrushes = state.files.reduce((acc, f) => acc.concat(f.brushes || []), []);
    const total = allBrushes.filter(b => b.enabled !== false).length;
    emptyEl.style.display = state.files.length ? 'none' : 'block';
    updateConvertButton();
    if (typeof updatePrecheck === 'function') { clearTimeout(state._precheckT); state._precheckT = setTimeout(updatePrecheck, 120); }
    const filtering = (state.filterKind && state.filterKind !== 'all') || String(state.searchQuery || '').trim().length > 0;

    state.files.forEach((rec, fi) => {
      const card = document.createElement('div');
      card.className = 'file-card card';
      const head = document.createElement('div');
      head.className = 'file-head';
      const matchedIndices = [];
      if (rec.brushes && rec.brushes.length && filtering) {
        for (let bi = 0; bi < rec.brushes.length; bi++) {
          if (matchesBrushFilter(rec.brushes[bi])) matchedIndices.push(bi);
        }
      }
      const countText = rec.brushes
        ? (filtering ? '匹配 ' + matchedIndices.length + ' / ' + rec.brushes.length + ' 支' : rec.brushes.length + ' 支笔刷')
        : (rec.error ? '出错' : '解析中…');
      head.innerHTML = `
        <div class="fname" title="${esc(rec.name)}">${esc(rec.name)}</div>
        <div class="badge ${rec.error ? 'err' : (rec.kind || 'parsing')}">${rec.error ? '无法识别' : (rec.kind ? (rec.kindLabel || rec.kind) : (rec.parsing ? '解析中…' : '待解析'))}</div>
        <div class="fmeta">${rec.sizeBytes ? fmtSize(rec.sizeBytes) : (rec.bytes ? fmtSize(rec.bytes.length) : '')}</div>
        <div class="fmeta">${countText}${rec.parseMs ? ' · ' + (rec.parseMs >= 1000 ? (rec.parseMs / 1000).toFixed(1) + 's' : rec.parseMs + 'ms') : ''}</div>
        ${rec.brushes && rec.brushes.length ? '<button class="btn tiny ghost selall" title="全选本文件笔刷">全选</button><button class="btn tiny ghost selnone" title="取消本文件笔刷">清空</button>' : ''}
        <button class="btn tiny ghost remove" title="移除">✕</button>`;
      head.querySelector('.remove').onclick = () => {
        // #262 导入中删卡：同时停掉正在跑的导入，否则下一张卡会把它顶回来
        if (isImporting()) { state.importToken++; toast('已停止本次导入'); }
        state.files.splice(fi, 1);
        render();
        updateConvertButton();
      };
      if (head.querySelector('.selall')) head.querySelector('.selall').onclick = () => {
        if (filtering) matchedIndices.forEach(bi => { rec.brushes[bi].enabled = true; });
        else rec.brushes.forEach(b => { b.enabled = true; });
        syncSelectionUI();
      };
      if (head.querySelector('.selnone')) head.querySelector('.selnone').onclick = () => {
        if (filtering) matchedIndices.forEach(bi => { rec.brushes[bi].enabled = false; });
        else rec.brushes.forEach(b => { b.enabled = false; });
        syncSelectionUI();
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
        // #282：把「加载图库」直接放到提示里——用户看到「缺少内置笔尖原图」时就在这一行。
        // v2.5.66：桌面/安卓用随 App 自带的图库（一次点击就好）。
        // #302：网页版没有内置图库，缺图时直接给「一键下载图库包并自动导入」指引按钮，
        //       下载失败再提示去高级选项手动选；不再让用户自己摸索找入口。
        const missingShape = !state.shapeLib && rec.brushes && rec.brushes.some(function (b) { return b && !b.tip && b.bundledShapePath; });
        if (missingShape) {
          const isApp = !!(window.BrushDesktop || window.BrushNative);
          const libBtn = document.createElement('button');
          libBtn.type = 'button';
          libBtn.className = 'btn ghost';
          libBtn.style.marginTop = '8px';
          if (isApp) {
            const native = !!window.BrushNative;
            const desktop = !!window.BrushDesktop;
            libBtn.textContent = native ? '下载内置图库（32MB，联网）' : (desktop ? '加载内置图库（程序目录或联网下载）' : '用内置图库补回真笔尖');
            libBtn.onclick = async function (ev) {
              ev.preventDefault();
              ev.stopPropagation();
              libBtn.disabled = true;
              libBtn.textContent = '正在加载内置图库…';
              const r = await loadBundledShapeLib({
                progressButton: libBtn,
                onStart: function () {
                  toast(native ? '正在下载内置笔尖图库（约 32MB，仅首次，需联网）…'
                    : (desktop ? '先找程序目录的图库包，没有就联网下载（约 32MB）…' : '正在加载内置笔尖图库（约 32MB，仅首次）…'), 12000);
                }
              });
              libBtn.disabled = false;
              if (r && r.ok) {
                libBtn.textContent = '内置图库已加载（' + r.count + ' 张）';
                return;
              }
              libBtn.textContent = '加载内置笔尖图库（补回真图）';
              toast('内置图库不可用，请手动选择文件夹：' + ((r && r.error) || ''), 9000);
              const dirInput = $('#shapeLibDirInput');
              if (dirInput) dirInput.click();
              else { const zi = $('#shapeLibInput'); if (zi) zi.click(); }
            };
          } else {
            libBtn.textContent = '没有图库包？一键下载并自动导入（32MB）';
            libBtn.onclick = async function (ev) {
              ev.preventDefault();
              ev.stopPropagation();
              await downloadShapeLibPack(libBtn, SHAPE_LIB_PACKS.lite);
            };
          }
          wr.appendChild(document.createElement('br'));
          wr.appendChild(libBtn);
          if (!window.BrushDesktop) {
            // 原图高清档：216MB 分 3 卷自动合并（网页与安卓 App 都可用，安卓壳走站点绝对地址）
            const fullBtn = document.createElement('button');
            fullBtn.type = 'button';
            fullBtn.className = 'btn ghost';
            fullBtn.style.marginTop = '8px';
            fullBtn.style.marginLeft = '8px';
            fullBtn.title = '原图高清 216MB，GitHub 限速分 3 卷，浏览器自动下载合并；建议电脑端使用';
            fullBtn.textContent = '或下载原图高清包（216MB）';
            fullBtn.onclick = async function (ev) {
              ev.preventDefault();
              ev.stopPropagation();
              await downloadShapeLibPack(fullBtn, SHAPE_LIB_PACKS.full);
            };
            wr.appendChild(fullBtn);
          }
        }
        card.appendChild(wr);
      }
      if (rec.brushes && rec.brushes.length) {
        const visibleCount = filtering ? matchedIndices.length : rec.brushes.length;
        if (!visibleCount) {
          const emptyMatch = document.createElement('div');
          emptyMatch.className = 'filter-empty';
          emptyMatch.textContent = '本文件内没有符合当前筛选/搜索条件的笔刷';
          card.appendChild(emptyMatch);
        } else {
          const grid = document.createElement('div');
          grid.className = 'grid';
          const LIMIT = 60;
          // #273：展开状态记在记录上，任何 render（改目标格式、勾选等）都不会把它折叠回 60 支
          const filterKey = JSON.stringify([state.filterKind || 'all', state.searchQuery || '']);
          if (filtering && rec._filteredKey !== filterKey) {
            rec._filteredKey = filterKey;
            rec._filteredShown = LIMIT;
          }
          let shown = Math.min(visibleCount, Math.max(LIMIT, (filtering ? rec._filteredShown : rec._shown) || LIMIT));
          appendBrushItems(grid, rec, fi, 0, shown, filtering ? matchedIndices : null);
          card.appendChild(grid);
          if (visibleCount > shown) {
            const bar = document.createElement('div');
            bar.className = 'show-more-bar';
            const more = document.createElement('button');
            more.className = 'btn ghost show-more';
            const expandAll = document.createElement('button');
            expandAll.className = 'btn tiny ghost';
            expandAll.textContent = '全部展开';
            const upd = function () {
              more.textContent = '显示更多（已显示 ' + shown + ' / ' + visibleCount + ' 支）';
              if (shown >= visibleCount) {
                more.style.display = 'none';
                expandAll.style.display = 'none';
                bar.style.display = 'none';
              } else if (visibleCount - shown <= 80) {
                expandAll.style.display = 'none';
              }
            };
            upd();
            more.onclick = function () {
              const next = Math.min(visibleCount, shown + 80);
              appendBrushItems(grid, rec, fi, shown, next - shown, filtering ? matchedIndices : null);
              shown = next;
              if (filtering) rec._filteredShown = next;
              else rec._shown = next;
              upd();
            };
            expandAll.onclick = function () {
              const next = visibleCount;
              appendBrushItems(grid, rec, fi, shown, next - shown, filtering ? matchedIndices : null);
              shown = next;
              if (filtering) rec._filteredShown = next;
              else rec._shown = next;
              upd();
            };
            bar.appendChild(more);
            bar.appendChild(expandAll);
            card.appendChild(bar);
          }
        }
      }
      filesEl.appendChild(card);
    });
    refreshSelAllLabel();
  }

  /* ---------------- loading ---------------- */
  function kindLabel(kind) {
    return {
      abr: 'Photoshop ABR',
      tpl: 'Photoshop TPL',
      procreate: 'Procreate',
      bru: '画世界Pro BRU',
      zip: '压缩包',
      sut: 'CSP / 优动漫 SUT',
      mtd: '优动漫 MTD',
      udongman: '优动漫 ABR',
      gobrush: '天生会画 GoBrush',
      gobrushSet: '天生会画笔刷组',
      kbundle: 'Krita BUNDLE',
      kpp: 'Krita KPP',
      gbr: 'GIMP GBR',
      gih: 'GIMP GIH',
      myb: 'MyPaint MYB',
      painter: 'Corel Painter',
      painterlib: 'Painter 笔刷库',
      mdp: 'MediBang MDP',
      mbini: 'MediBang INI',
      mbini_set: 'MediBang 云笔刷包',
      sai2pack: 'SAI2 素材包',
      sai2ini: 'SAI2 笔刷 INI',
      sai2tool: 'SAI2 toolnrm',
      pat: 'Photoshop PAT',
      'csp-decrypted': 'CSP 解密目录'
    }[kind] || '未知';
  }

  function makeRecord(name, bytes, relDir) {
    /* relDir：从文件夹拖入/选择时的相对子目录（不带首尾斜杠），转出时按它还原目录结构 */
    const rec = { name: name, size: bytes ? bytes.length : 0, bytes: bytes, brushes: null, warnings: [], error: null,
      relDir: String(relDir || '').replace(/^\/+|\/+$/g, '') };
    state.files.push(rec);
    return rec;
  }

  function libraryResourceCount(brush, force) {
    if (!brush) return 0;
    let count = brush.bundledShapePath && (force || !brush.tip) ? 1 : 0;
    if (brush.bundledGrainPath && (force || !brush._grainRgba)) count++;
    if (brush.dualSubBrush) count += libraryResourceCount(brush.dualSubBrush, force);
    return count;
  }

  /* 【第187轮】解析落地前按「笔尖最大边长」降采样。
     53 支 Procreate brushset 解析完是 939 个 ArrayBuffer / 1437MB（其中原始
     15.5MB 字节被 495 个视图共享），转 .brushset 时还要再翻一份，内存峰值直接
     把浏览器/WebView 压崩——用户报的「转出 Procreate 有概率崩溃」就是这个。
     默认上限 512 与设置里一致；用户显式选了更大值就按他的来（并自行承担内存）。 */
  function downsampleParsedTips(parsed) {
    let cap = 512;
    try {
      const el = document.getElementById('optTipSize');
      const v = Number(el && el.value);
      if (v > 0) cap = Math.max(64, Math.min(2048, v));
    } catch (e) { /* 用默认 512 */ }
    const list = (parsed && parsed.brushes) || [];
    let scaled = 0;
    function shrink(t) {
      if (!t || !t.rgba || !t.w || !t.h) return t;
      const side = Math.max(t.w, t.h);
      if (side <= cap) return t;
      const k = cap / side;
      const nw = Math.max(1, Math.round(t.w * k)), nh = Math.max(1, Math.round(t.h * k));
      try {
        const rgba = BC.png.resize(t.rgba, t.w, t.h, nw, nh);
        scaled++;
        return { w: nw, h: nh, rgba: rgba };
      } catch (e) { return t; }
    }
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b) continue;
      b.tip = shrink(b.tip);
      b.dualTip = shrink(b.dualTip);
      /* 已解出的内嵌副笔/纹理同样收口，避免绕过上限 */
      if (b.embeddedTips && b.embeddedTips.length) b.embeddedTips = b.embeddedTips.map(shrink);
    }
    if (scaled) pushLog('解析后按 ' + cap + 'px 上限压缩了 ' + scaled + ' 张笔尖（防止内存峰值崩溃）');
    return parsed;
  }

  function adoptParsed(rec, bytes, parsed, displayName) {
    try { downsampleParsedTips(parsed); } catch (e) { pushLog('笔尖压缩失败（继续用原图）：' + ((e && e.message) || e)); }
    rec.sizeBytes = bytes ? bytes.length : 0;
    rec.pkgId = BC.util.uid();
    rec.baseName = (displayName || rec.name).replace(/\.[^.]+$/, '').split('/').pop();
    rec.kind = parsed.kind;
    const mappedLabel = kindLabel(parsed.kind);
    rec.kindLabel = mappedLabel !== '未知' ? mappedLabel : (parsed.kindLabel || '未知');
    rec.warnings = (rec.warnings || []).concat(parsed.warnings || []);
    rec.brushes = parsed.brushes.map(b => {
      const copy = Object.assign({}, b);
      copy.enabled = true;
      if (!b.tip) copy.tipSource = 'synth';
      return copy;
    });
    rec.origBrushes = parsed.brushes.length;
    rec.parseName = displayName || rec.name;
    // 原始字节只在解析时需要：释放它，几百支的批量解析能省下大量内存。
    // 内置资源引用需保留原始输入，后加载/换图库才能补回主副笔尖和纹理。
    const waitingShape = parsed.kind === 'procreate' && parsed.brushes.some(function (b) { return libraryResourceCount(b, true) > 0; });
    rec.bytes = waitingShape && bytes ? bytes : null;
  }

  /* 大文件用 Worker 解析（不卡界面）；失败自动回退到主线程分块解析 */
  let workerSeq = 0;
  let worker = null;
  let workerBroken = false;
  function workerUrl() {
    const scripts = Array.from(document.scripts || []);
    const inJsDir = scripts.some(function (sc) { return /\/js\/app\.js(\?|$)/.test(sc.src || ''); });
    return inJsDir ? 'js/parse-worker.js' : 'parse-worker.js';
  }
  /* 第201轮（第189轮审查 P2-#18）：超时以前只 reject、不 terminate——卡住的 Worker 继续占内存，
     后面排队的任务全挂在它上面，各自再干等 180s。现在超时/出错都终止这个 Worker，
     把排在它上面的任务一起失败（让它们回退主线程解析），下一个任务新建 Worker。 */
  const workerJobs = new Map();
  function killWorker(reason) {
    const w = worker;
    worker = null;
    if (w) { try { w.terminate(); } catch (e) { /* ignore */ } }
    const jobs = Array.from(workerJobs.values());
    workerJobs.clear();
    jobs.forEach(function (job) { job.cleanup(); job.reject(new Error(reason)); });
  }
  function parseViaWorker(name, bytes, opts, onProgress) {
    return new Promise(function (resolve, reject) {
      if (!window.Worker || workerBroken) return reject(new Error('worker unavailable'));
      try {
        if (!worker) worker = new Worker(workerUrl());
      } catch (e) { workerBroken = true; return reject(e); }
      const w = worker;
      const id = ++workerSeq;
      const timer = setTimeout(function () { killWorker('worker timeout'); }, 180000);
      function cleanup() {
        clearTimeout(timer);
        workerJobs.delete(id);
        w.removeEventListener('message', onMsg);
        w.removeEventListener('error', onErr);
      }
      function onMsg(ev) {
        const m = ev.data || {};
        if (m.id !== id) return;
        if (typeof m.progress === 'number') {
          if (onProgress) onProgress(m.progress);
          return;
        }
        cleanup();
        if (m.ok) resolve(m.result); else reject(new Error(m.error || '解析失败'));
      }
      function onErr(ev) {
        workerBroken = true;
        killWorker('worker error: ' + ((ev && ev.message) || 'unknown'));
      }
      workerJobs.set(id, { reject: reject, cleanup: cleanup });
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
      const copy = bytes.slice ? bytes.slice() : new Uint8Array(bytes);
      w.postMessage({ id: id, name: name, bytes: copy, opts: opts || {} }, [copy.buffer]);
    });
  }

  /* 把常见的英文技术报错翻译成中文提示（保留原文便于排查） */
  function friendlyError(msg) {
    const t = String(msg || '');
    if (/worker timeout/i.test(t)) return '后台解析超时，请改用桌面版或拆分文件';
    if (/not a zip|invalid zip|end of central directory/i.test(t)) return '压缩包结构异常或文件不完整（' + t + '）';
    if (/out of memory|allocation failed|Array buffer allocation/i.test(t)) return '内存不足：文件太大，请用桌面版处理（' + t + '）';
    if (/Unsupported|unsupported/i.test(t)) return '该文件的子类型暂不支持（' + t + '）';
    if (/Cannot read|undefined is not/i.test(t)) return '文件内容不完整或格式变体未覆盖（' + t + '）';
    if (/RangeError/i.test(t)) return '文件数据越界，可能已损坏（' + t + '）';
    return t;
  }

  /* 画世界内置笔尖库（core/hsj-shapes.js，14MB base64 图）：
     小包版/未内置该文件的安装包里按需加载——先用上次缓存的字节，再依次试同源、站点绝对地址、
     gh 镜像与 jsDelivr；全都拿不到就提示用户去设置里点「下载笔尖库」。 */
  const HSJ_LIB_KEY = 'hsj';
  let hsjLibState = 'unknown';       // unknown | missing | loading | ready
  const hsjFailedSources = Object.create(null);
  let hsjTipNotified = false;

  function hsjLibElements() {
    return {
      text: document.getElementById('hsjLibText'),
      btn: document.getElementById('btnHsjDownload')
    };
  }
  function renderHsjLibState(msg) {
    const el = hsjLibElements();
    const label = '下载笔尖库（14MB）';
    if (el.btn) {
      /* 下载中按钮变成「取消」且可点（原来 disabled，14MB 卡住时没法停） */
      el.btn.disabled = false;
      el.btn.textContent = hsjLibState === 'loading' ? '取消下载' : label;
      el.btn.hidden = hsjLibState === 'ready';
    }
    if (el.text) {
      if (hsjLibState === 'ready') el.text.textContent = '已就绪：画世界 ps* 内置笔尖可直接回填（随 App 或已下载）';
      else if (hsjLibState === 'loading') el.text.textContent = msg || '正在下载画世界内置笔尖库…';
      else if (hsjLibState === 'missing') el.text.textContent = '未安装：画世界 BRU 缺内置笔尖时只能留空，点右侧按钮下载（14MB，仅一次）';
      else el.text.textContent = '可选：画世界 BRU 的内置笔尖（ps*）需要它来回填原图';
    }
  }
  /* 本地优先：网页版是 js/hsj-shapes.js，安卓/桌面壳是同包内的 ../core/hsj-shapes.js
     （精简图库版、原图图库版内置该文件，小包版没有 → 才需要联网下载）。 */
  function hsjLocalSrc() {
    const scripts = Array.prototype.slice.call(document.scripts || []);
    const inJsDir = scripts.some(function (sc) { return /\/js\/app\.js(\?|$)/.test(sc.src || ''); });
    return inJsDir ? 'js/hsj-shapes.js' : '../core/hsj-shapes.js';
  }
  /* 线上仓库根就是网页包内容，该文件在仓库里是 js/hsj-shapes.js（core/ 不在线上，实测 404），
     所以镜像与 CDN 都拼 js/ 路径——2026-11-08 用 curl 实测：Pages 200、raw 200、gh-proxy 200、jsDelivr 403。 */
  function hsjShapesCandidates() {
    const name = 'js/hsj-shapes.js';
    const list = [hsjLocalSrc()];
    list.push(SITE_BASE + name);                          // 站点绝对地址（安卓/桌面壳兜底）
    for (let i = 0; i < SITE_MIRRORS.length; i++) list.push(SITE_MIRRORS[i] + SITE_RAW_BASE + name);
    for (let i = 0; i < SITE_CDN.length; i++) list.push(SITE_CDN[i] + name);
    return list;
  }
  function loadHsjScript(url) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = url;
      s.onload = function () { resolve(true); };
      s.onerror = function () { s.remove(); reject(new Error('加载失败')); };
      document.head.appendChild(s);
    });
  }
  async function loadHsjFromBlob(bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
    try { await loadHsjScript(url); } finally { URL.revokeObjectURL(url); }
    return !!BC.hsjShapes;
  }
  async function ensureHsjShapes() {
    if (BC.hsjShapes) { hsjLibState = 'ready'; renderHsjLibState(); return true; }
    hsjLibState = 'loading'; renderHsjLibState('正在加载画世界笔尖库…');
    try {
      const cached = await ShapeLibStore.get(HSJ_LIB_KEY);
      if (cached) {
        try {
          if (await loadHsjFromBlob(cached)) { hsjLibState = 'ready'; renderHsjLibState(); if (typeof backfillHsjShapesInFiles === 'function') backfillHsjShapesInFiles(); return true; }
        } catch (e) { hsjFailedSources.cache = true; }
      }
    } catch (e) { /* 缓存不可用：继续在线 */ }
    const urls = hsjShapesCandidates().filter(function (u) { return !hsjFailedSources[u]; });
    for (const u of urls) {
      try { await loadHsjScript(u); } catch (e) { hsjFailedSources[u] = true; continue; }
      if (BC.hsjShapes) { hsjLibState = 'ready'; renderHsjLibState(); if (typeof backfillHsjShapesInFiles === 'function') backfillHsjShapesInFiles(); return true; }
      hsjFailedSources[u] = true;
    }
    hsjLibState = 'missing'; renderHsjLibState();
    return false;
  }
  async function installHsjBytes(bytes, signal, runToken) {
    if (!bytes || !bytes.length) throw new Error('空文件');
    // AUDIT-20261111-01：先载入、确认注册了 hsjShapes 再写缓存，坏文件不覆盖旧缓存
    /* R202-03：脚本载入是异步的。取消/新一次下载可能发生在「拿到字节 → 载入 → 写缓存」之间，
       以前载入完无条件提交，取消后仍写一次 IndexedDB 并把状态从 unknown 改回 ready。
       每次提交前都确认仍是同一批次且未取消；手动导入图库里的 hsj-shapes.js 不带批次号，行为不变。 */
    if (hsjInstallCancelled(signal, runToken)) return false;
    if (await loadHsjFromBlob(bytes)) {
      if (hsjInstallCancelled(signal, runToken)) return false;
      await ShapeLibStore.put(bytes, HSJ_LIB_KEY);
      if (hsjInstallCancelled(signal, runToken)) return false;
      hsjLibState = 'ready'; renderHsjLibState();
      const fixed = typeof backfillHsjShapesInFiles === 'function' ? backfillHsjShapesInFiles() : 0;
      toast('画世界内置笔尖库已就绪（14MB，已缓存）' + (fixed ? '，已补回 ' + fixed + ' 支笔尖' : ''), 3500);
      return true;
    }
    throw new Error('脚本载入后没有注册 hsjShapes');
  }
  let hsjAbort = null;
  /* R202-03：每次开始下载、每次取消都换一个批次号。安装阶段（载入脚本、写缓存、
     提交界面状态）跨多个 await，旧任务在这些边界上必须被认出来，不能覆盖新任务或取消结果。 */
  let hsjRunToken = 0;
  let hsjTexRunToken = 0;
  function hsjInstallCancelled(signal, runToken) {
    if (runToken !== undefined && runToken !== hsjRunToken) return true;
    return hsjCancelled(signal);
  }
  /* 本次下载是否已被用户取消。取消后清掉 cancel 标记再返回，避免影响下一次下载。
     笔尖库与纹理库共用：传各自的 signal 和失败表。 */
  function hsjCancelled(signal, failed) {
    if (!signal || !signal.aborted) return false;
    (failed || hsjFailedSources).cancel = false;
    return true;
  }
  function cancelHsjDownload() {
    if (hsjAbort) { try { hsjAbort.abort(); } catch (e) { /* 忽略 */ } }
    hsjAbort = null;
    hsjRunToken++;
    hsjLibState = 'unknown';
    hsjFailedSources.cancel = true;
    renderHsjLibState();
    toast('已取消下载笔尖库', 2500);
  }
  async function downloadHsjLib(btn) {
    if (hsjLibState === 'loading') { cancelHsjDownload(); return false; }
    const runToken = ++hsjRunToken;
    hsjLibState = 'loading';
    hsjAbort = (typeof AbortController === 'function') ? new AbortController() : null;
    const signal = hsjAbort ? hsjAbort.signal : undefined;
    renderHsjLibState('连接中…');
    const urls = hsjShapesCandidates();
    let lastErr = null;
    /* 1) 多源并发分块：Pages 单连接实测约 21KB/s，4 路分块能到 250KB/s 以上 */
    try {
      const blob = await parallelRangeBlob(urls, function (got) {
        renderHsjLibState('下载中 ' + (got / 1048576).toFixed(1) + 'MB');
      }, { chunkBytes: 2 * 1048576, parallel: 4, signal: signal });
      // AUDIT-20261111-04：拿到字节时用户可能已经点了取消——不安装、也不退回单连接重下
      if (hsjCancelled(signal)) return false;
      if (blob && blob.size) {
        try { return await installHsjBytes(new Uint8Array(await blob.arrayBuffer()), signal, runToken); }
        catch (e) { lastErr = e; }
      }
    } catch (e) {
      if (hsjCancelled(signal) || (e && e.name === 'AbortError')) { hsjFailedSources.cancel = false; return false; }
      lastErr = e;
    }
    /* 2) 单连接兜底：源不支持 Range 时走流式读取 */
    for (const u of urls) {
      if (hsjCancelled(signal)) return false;
      try {
        renderHsjLibState('下载中…');
        const res = await fetch(u, { cache: 'no-store', signal: signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const total = Number(res.headers.get('content-length')) || 0;
        let got = 0;
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        let bytes;
        if (reader) {
          const parts = [];
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            parts.push(r.value); got += r.value.length;
            const pct = total ? Math.min(99, Math.round(got * 100 / total)) : null;
            renderHsjLibState(pct === null ? ('下载中 ' + (got / 1048576).toFixed(1) + 'MB') : ('下载中 ' + pct + '%'));
          }
          bytes = new Uint8Array(got);
          let off = 0;
          parts.forEach(function (part) { bytes.set(part, off); off += part.length; });
        } else {
          bytes = new Uint8Array(await res.arrayBuffer());
        }
        if (hsjCancelled(signal)) return false;
        return await installHsjBytes(bytes, signal, runToken);
      } catch (e) {
        if (e && e.name === 'AbortError') { hsjAbort = null; return false; }
        lastErr = e; hsjFailedSources[u] = true;
      }
    }
    hsjAbort = null;
    if (hsjFailedSources.cancel) { hsjFailedSources.cancel = false; return false; }
    hsjLibState = 'missing'; renderHsjLibState();
    toast('下载失败：' + ((lastErr && lastErr.message) || '网络不可用') + '，可稍后重试', 6000);
    return false;
  }

  /* 【第187轮】画世界内置纹理库（core/hsj-textures.js，31MB，156 张 ptN）。
     与笔尖库同一套懒加载策略：IndexedDB 缓存 → 同源 → 站点绝对地址 → gh 镜像 → jsDelivr。
     单独写一份而不去改造笔尖库那套：那套已经稳定运行、又被多个测试锁着，为复用动它不值。
     注意 SITE_* 常量声明在文件后部，只能**在函数内**引用——顶层读会 TDZ ReferenceError，
     v2.8.45 就因为这个一路带 5 个版本没人发现（图库按钮消失、检查更新失效）。 */
  const HSJ_TEX_KEY = 'hsjTex';
  const HSJ_TEX_NAME = 'js/hsj-textures.js';
  const HSJ_TEX_MB = 31;
  let hsjTexState = 'unknown';        // unknown | missing | loading | ready
  const hsjTexFailed = Object.create(null);
  let hsjTexAbort = null;

  function hsjTexReady() { return !!BC.hsjTextures; }
  function hsjTexElements() {
    return {
      text: document.getElementById('hsjTexText'),
      btn: document.getElementById('btnHsjTexDownload')
    };
  }
  function renderHsjTexState(msg) {
    const el = hsjTexElements();
    const label = '下载纹理库（' + HSJ_TEX_MB + 'MB）';
    if (el.btn) {
      el.btn.disabled = false;
      el.btn.textContent = hsjTexState === 'loading' ? '取消下载纹理' : label;
      el.btn.hidden = hsjTexState === 'ready';
    }
    if (el.text) {
      if (hsjTexState === 'ready') el.text.textContent = '已就绪：画世界 BRU 的内置纹理（pt*）可直接补像素（随 App 或已下载）';
      else if (hsjTexState === 'loading') el.text.textContent = msg || '正在下载画世界内置纹理库…';
      else if (hsjTexState === 'missing') el.text.textContent = '未安装：BRU 带纹理引用却没有像素时纹理只能留空，点右侧按钮下载（' + HSJ_TEX_MB + 'MB，仅一次）';
      else el.text.textContent = '画世界内置纹理库（可选）：BRU 的纹理（pt*，156 张）需要它补上纹理像素';
    }
  }
  function hsjTexLocalSrc() {
    const scripts = Array.prototype.slice.call(document.scripts || []);
    const inJsDir = scripts.some(function (sc) { return /\/js\/app\.js(\?|$)/.test(sc.src || ''); });
    return inJsDir ? HSJ_TEX_NAME : '../core/hsj-textures.js';
  }
  /* 线上仓库根就是网页包内容，文件在 js/ 下（core/ 不在线上，实测 404），
     所以镜像与 CDN 一律拼 js/ 路径。 */
  function hsjTexCandidates() {
    const list = [hsjTexLocalSrc()];
    list.push(SITE_BASE + HSJ_TEX_NAME);
    for (let i = 0; i < SITE_MIRRORS.length; i++) list.push(SITE_MIRRORS[i] + SITE_RAW_BASE + HSJ_TEX_NAME);
    for (let i = 0; i < SITE_CDN.length; i++) list.push(SITE_CDN[i] + HSJ_TEX_NAME);
    return list;
  }
  async function loadScriptFromBytes(bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
    try { await loadHsjScript(url); } finally { URL.revokeObjectURL(url); }
  }
  async function ensureHsjTextures() {
    if (hsjTexReady()) { hsjTexState = 'ready'; renderHsjTexState(); return true; }
    hsjTexState = 'loading'; renderHsjTexState('正在加载画世界纹理库…');
    try {
      const cached = await ShapeLibStore.get(HSJ_TEX_KEY);
      if (cached) {
        try {
          await loadScriptFromBytes(cached);
          if (hsjTexReady()) { hsjTexState = 'ready'; renderHsjTexState(); return true; }
        } catch (e) { hsjTexFailed.cache = true; }
      }
    } catch (e) { /* 缓存不可用：继续在线 */ }
    const urls = hsjTexCandidates().filter(function (u) { return !hsjTexFailed[u]; });
    for (const u of urls) {
      try { await loadHsjScript(u); } catch (e) { hsjTexFailed[u] = true; continue; }
      if (hsjTexReady()) { hsjTexState = 'ready'; renderHsjTexState(); return true; }
      hsjTexFailed[u] = true;
    }
    hsjTexState = 'missing'; renderHsjTexState();
    return false;
  }
  async function installHsjTexBytes(bytes, signal, runToken) {
    if (!bytes || !bytes.length) throw new Error('空文件');
    // AUDIT-20261111-01：先载入、确认注册了 hsjTextures 再写缓存
    /* R202-03：与笔尖库同一处竞态——载入脚本期间取消后，旧任务不得写缓存/把状态改回 ready。 */
    function stale() {
      return (runToken !== undefined && runToken !== hsjTexRunToken) || hsjCancelled(signal, hsjTexFailed);
    }
    if (stale()) return false;
    await loadScriptFromBytes(bytes);
    if (hsjTexReady()) {
      if (stale()) return false;
      await ShapeLibStore.put(bytes, HSJ_TEX_KEY);
      if (stale()) return false;
      hsjTexState = 'ready'; renderHsjTexState();
      toast('画世界内置纹理库已就绪（' + HSJ_TEX_MB + 'MB，已缓存，156 张纹理可用）', 3500);
      return true;
    }
    throw new Error('脚本载入后没有注册 hsjTextures');
  }
  function cancelHsjTexDownload() {
    if (hsjTexAbort) { try { hsjTexAbort.abort(); } catch (e) { /* 忽略 */ } }
    hsjTexAbort = null;
    hsjTexRunToken++;
    hsjTexState = 'unknown';
    hsjTexFailed.cancel = true;
    renderHsjTexState();
    toast('已取消下载纹理库', 2500);
  }
  async function downloadHsjTexLib(btn) {
    if (hsjTexState === 'loading') { cancelHsjTexDownload(); return false; }
    const runToken = ++hsjTexRunToken;
    hsjTexState = 'loading';
    hsjTexAbort = (typeof AbortController === 'function') ? new AbortController() : null;
    const signal = hsjTexAbort ? hsjTexAbort.signal : undefined;
    renderHsjTexState('连接中…');
    const urls = hsjTexCandidates();
    let lastErr = null;
    /* 1) 多源并发分块：大文件走 4 路 Range 才跑得动（单连接实测约 21KB/s） */
    try {
      const blob = await parallelRangeBlob(urls, function (got) {
        renderHsjTexState('下载中 ' + (got / 1048576).toFixed(1) + 'MB / ' + HSJ_TEX_MB + 'MB');
      }, { chunkBytes: 2 * 1048576, parallel: 4, signal: signal });
      if (hsjCancelled(signal, hsjTexFailed)) return false;
      if (blob && blob.size) {
        try { return await installHsjTexBytes(new Uint8Array(await blob.arrayBuffer()), signal, runToken); }
        catch (e) { lastErr = e; }
      }
    } catch (e) {
      if (hsjCancelled(signal, hsjTexFailed) || (e && e.name === 'AbortError')) { hsjTexFailed.cancel = false; return false; }
      lastErr = e;
    }
    /* 2) 单连接兜底：源不支持 Range 时流式读取 */
    for (const u of urls) {
      if (hsjCancelled(signal, hsjTexFailed)) return false;
      try {
        renderHsjTexState('下载中…');
        const res = await fetch(u, { cache: 'no-store', signal: signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const total = Number(res.headers.get('content-length')) || 0;
        let got = 0;
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        let bytes;
        if (reader) {
          const parts = [];
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            parts.push(r.value); got += r.value.length;
            const pct = total ? Math.min(99, Math.round(got * 100 / total)) : null;
            renderHsjTexState(pct === null ? ('下载中 ' + (got / 1048576).toFixed(1) + 'MB') : ('下载中 ' + pct + '%'));
          }
          bytes = new Uint8Array(got);
          let off = 0;
          parts.forEach(function (part) { bytes.set(part, off); off += part.length; });
        } else {
          bytes = new Uint8Array(await res.arrayBuffer());
        }
        if (hsjCancelled(signal, hsjTexFailed)) return false;
        return await installHsjTexBytes(bytes, signal, runToken);
      } catch (e) {
        if (e && e.name === 'AbortError') { hsjTexAbort = null; return false; }
        lastErr = e; hsjTexFailed[u] = true;
      }
    }
    hsjTexAbort = null;
    if (hsjTexFailed.cancel) { hsjTexFailed.cancel = false; return false; }
    hsjTexState = 'missing'; renderHsjTexState();
    toast('纹理库下载失败：' + ((lastErr && lastErr.message) || '网络不可用') + '，可稍后重试', 6000);
    return false;
  }

  /* SAI2 笔刷文件夹（桌面版）：自动定位 文档\SYSTEMAX Software Development，
     转换 SAI2 时把 scatter/brushtex 文件直接写进去，省掉下载解压拖拽。 */
  const SAI2_DIR = { ok: false, dir: '', settings: '' };
  function sai2DirEls() {
    return {
      row: document.getElementById('sai2DirRow'),
      text: document.getElementById('sai2DirText'),
      auto: document.getElementById('chkSai2Auto'),
      detect: document.getElementById('btnSai2Detect'),
      choose: document.getElementById('btnSai2Choose')
    };
  }
  function sai2Desktop() {
    return !!(window.BrushDesktop && typeof window.BrushDesktop.sai2Folder === 'function');
  }
  function renderSai2Dir(info, error) {
    const el = sai2DirEls();
    if (el.row) el.row.hidden = !sai2Desktop();
    if (!el.text) return;
    if (info && info.ok) {
      SAI2_DIR.ok = true; SAI2_DIR.dir = info.dir || ''; SAI2_DIR.settings = info.settings || '';
      el.text.textContent = '已找到：' + (info.settings || info.dir) +
        (info.exists === false ? '（首次写入会自动创建）' : '');
    } else {
      SAI2_DIR.ok = false; SAI2_DIR.dir = ''; SAI2_DIR.settings = '';
      el.text.textContent = (error || (info && info.error) || '未找到 SAI2 笔刷文件夹') +
        '。可以点「选择文件夹」手动指定「文档」所在目录。';
    }
  }
  async function refreshSai2Folder() {
    if (!sai2Desktop()) return null;
    const el = sai2DirEls();
    if (el.row) el.row.hidden = false;
    try {
      const r = await window.BrushDesktop.sai2Folder();
      renderSai2Dir(r);
      return r;
    } catch (e) { renderSai2Dir(null, '检测失败：' + (e.message || e)); return null; }
  }
  async function chooseSai2Folder() {
    if (!sai2Desktop()) return null;
    try {
      const r = await window.BrushDesktop.sai2ChooseFolder();
      if (r && r.canceled) return null;
      renderSai2Dir(r);
      if (r && r.ok) toast('SAI2 笔刷文件夹已指定', 3000);
      return r;
    } catch (e) { renderSai2Dir(null, '选择失败：' + (e.message || e)); return null; }
  }
  function sai2AutoOn() {
    const el = sai2DirEls();
    return !!(el.auto && el.auto.checked);
  }
  function sai2BytesToB64(bytes) {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + CH)));
    }
    return btoa(bin);
  }
  /* 转换 SAI2 时调用：满足「桌面版 + 勾了自动写入 + 找到目录」就直接落盘 */
  async function autoSaveSai2ToFolder(list, opts) {
    if (!sai2Desktop() || !sai2AutoOn()) return null;
    if (!SAI2_DIR.ok) { const r = await refreshSai2Folder(); if (!r || !r.ok) return null; }
    try {
      const made = BC.convert.makeSai2Files(list, opts || {});
      if (!made || !made.files || !made.files.length) return null;
      /* 自动写入不产生 ZIP，makeSai2Files 的警告没有别的出口，这里补记到日志 */
      for (const w of made.warnings || []) pushLog('SAI2：' + w);
      /* 只落 SAI2 真正会读的 SAIv2/settings 素材。SAI2参数记录.txt 是给 ZIP 用户看的兼容文本，
         写进 SAI2 用户目录既不生效，又会在每次转换被重名顺延成 _2/_3，堆出一串垃圾文件。 */
      const payload = made.files
        .filter(function (f) { return /^SAIv2\/settings\//i.test(f.rel); })
        .map(function (f) { return { rel: f.rel, base64: sai2BytesToB64(f.data) }; });
      if (!payload.length) return null;
      const res = await window.BrushDesktop.sai2Save(payload);
      if (!res) { pushLog('SAI2：写入笔刷文件夹无返回'); return null; }
      const written = res.written || [];
      const errors = res.errors || [];
      const skipped = res.skipped || [];
      const renamed = written.filter(function (w) { return w.renamed; }).length;
      const why = res.error || errors.join('；');
      /* 部分写入成功后 IPC 会返回 ok:false，但文件其实已经落盘了。
         一律提示「失败」会让用户重复导入，在 SAI2 目录里堆出更多 _2/_3。 */
      if (written.length) {
        pushLog('SAI2：已写入 ' + written.length + ' 个文件到 ' + res.settings +
          (renamed ? '（' + renamed + ' 个重名自动加 _2）' : '') +
          (errors.length || skipped.length ? '；' + errors.length + ' 个失败、' + skipped.length + ' 个跳过' : ''));
        if (why || skipped.length) pushLog('SAI2：' + [why, skipped.length ? skipped.length + ' 个路径被跳过' : ''].filter(Boolean).join('；'));
        toast('已保存到 SAI2 笔刷文件夹（' + written.length + ' 个文件' +
          (errors.length ? '，' + errors.length + ' 个失败' : '') + '）', 4200);
      } else {
        pushLog('SAI2：写入笔刷文件夹失败 ' + (why || '未知错误'));
        toast('写入 SAI2 文件夹失败：' + (why || '未知错误'), 6000);
      }
      return res;
    } catch (e) {
      pushLog('SAI2：写入笔刷文件夹异常 ' + (e.message || e));
      return null;
    }
  }

  let hsjShapesLoading = null;
  function needsHsjBuiltinTip(b) {
    if (!b || b.source !== 'bru' || b.tip) return false;
    if (BC.convert && typeof BC.convert.builtinTipKey === 'function') return !!BC.convert.builtinTipKey(b);
    return /^ps(?:[1-9]|[1-9][0-9]|1[0-7][0-9]|18[0-4])$/.test(b.oldTexId || '') ||
      (!b.oldTexId && /^pt(?:[1-9]|[1-9][0-9]|1[0-7][0-9]|18[0-4])$/.test(b.texAssetId || ''));
  }
  function backfillHsjShapesInFiles() {
    const hasLib = !!BC.hsjShapes;
    const shapeRes = typeof state !== 'undefined' && state && state.shapeLib ? state.shapeLib : null;
    if ((!hasLib && !shapeRes) || typeof state === 'undefined' || !state || !Array.isArray(state.files)) return 0;
    let fixed = 0;
    const opts = shapeRes ? { shapeResources: shapeRes } : undefined;
    for (let i = 0; i < state.files.length; i++) {
      const rec = state.files[i];
      if (!rec || !Array.isArray(rec.brushes)) continue;
      const count = BC.convert.restoreHsjTips(rec, opts);
      if (count > 0) {
        fixed += count;
        rec.brushes.forEach(function (b) {
          if (b && b.tip && b.tipSource === 'synth') delete b.tipSource;
        });
        if (Array.isArray(rec.warnings) && rec.brushes.every(function (b) { return !b || !!b.tip; })) {
          rec.warnings = rec.warnings.filter(function (w) {
            return String(w).indexOf('没有笔尖（shape）图片') < 0 && String(w).indexOf('内置笔尖') < 0;
          });
        }
      }
    }
    if (fixed > 0 && typeof render === 'function') render();
    return fixed;
  }
  async function restoreHsjShapes(parsed) {
    const needed = parsed && parsed.brushes && parsed.brushes.some(needsHsjBuiltinTip);
    if (!needed) return;
    try {
      if (!BC.hsjShapes) {
        if (!hsjShapesLoading) hsjShapesLoading = ensureHsjShapes();
        const ok = await hsjShapesLoading;
        hsjShapesLoading = null;
        if (!ok && !hsjTipNotified) {
          hsjTipNotified = true;
          toast('有笔刷缺画世界内置笔尖：可在「设置」里点「下载笔尖库（14MB）」补回', 6500);
        }
      }
      if (BC.hsjShapes) BC.convert.restoreHsjTips(parsed);
      else if (typeof state !== 'undefined' && state && state.shapeLib) BC.convert.restoreHsjTips(parsed, { shapeResources: state.shapeLib });
      else pushLog('画世界内置笔尖：本安装包未内置该库，ps* 笔尖暂留空');
    } catch (e) { pushLog(String(e.message || e)); }
  }

  async function parseRecord(rec, displayName, bytes, opts) {
    const importToken = state.importToken;
    const shouldCancel = function () { return importToken !== state.importToken; };
    try {
      // 已加载的图库可能很大：留在主线程，走分块解析，避免复制整套图库到 Worker。
      // 注意：导入 .brushset 单文件时 opts 是 null，这里必须自己造对象，否则图库永远传不进去
      if (state.shapeLib && (!opts || opts.shapeResources !== state.shapeLib)) {
        opts = Object.assign({}, opts || {}, { shapeResources: state.shapeLib });
      }
      const big = bytes && bytes.length > 8 * 1024 * 1024;
      // 超大文件不用 Worker：结构化克隆会再复制一份，容易 OOM；改用主线程分块解析（会卡但更省内存）
      const useWorker = !state.shapeLib && big && bytes.length <= 100 * 1024 * 1024 && window.Worker && /^https?:/.test(location.protocol);
      if (useWorker) {
        try {
          setProgress(0, '后台解析：' + displayName);
          const parsed = await parseViaWorker(displayName, bytes, opts, function (p) {
            if (!shouldCancel()) setProgress(p, '后台解析：' + displayName);
          });
          if (shouldCancel()) return;
          setProgress(null);
          await restoreHsjShapes(parsed);
          if (shouldCancel()) return;
          adoptParsed(rec, bytes, parsed, displayName);
          return;
        } catch (e) {
          if (shouldCancel()) return;
          // #266：以前这里静默回退，用户盯着「后台解析」几分钟后界面又冻结却不知道发生了什么。
          pushLog('WORKER 回退：' + (e && e.message ? e.message : e));
          toast('后台解析未能完成，已改为主线程重新解析（大文件会短暂卡顿）：' + friendlyError(e && e.message ? e.message : e), 9000);
        }
        setProgress(null);
      }
      // 压缩后的 brushset 即使不到 8MB，也可能有许多高分辨率笔尖。
      if ((big || /\.brush(?:set)?$/i.test(displayName)) && BC.convert.parseFileAsync) {
        const parsed = await BC.convert.parseFileAsync(displayName, bytes, Object.assign({}, opts, {
          onProgress: function (p, text) { if (!shouldCancel()) setProgress(p, text + '：' + displayName); },
          shouldCancel: shouldCancel
        }));
        if (shouldCancel()) return;
        setProgress(null);
        await restoreHsjShapes(parsed);
        if (shouldCancel()) return;
        adoptParsed(rec, bytes, parsed, displayName);
      } else {
        const parsed = BC.convert.parseFile(displayName, bytes, opts);
        await restoreHsjShapes(parsed);
        if (shouldCancel()) return;
        adoptParsed(rec, bytes, parsed, displayName);
      }
    } catch (e) {
      if (shouldCancel()) return;
      setProgress(null);
      rec.error = friendlyError(e.message);
    }
  }

  /* Expand a zip into one record per brush file found inside. */
  async function addZip(name, bytes, depth, batchToken) {
    depth = depth || 0;
    /* 第201轮（第189轮审查 P2-#19）：记下进入时的导入批次。用户中途点「清空」/停止导入会让 importToken 变，
       以前这里的循环不看它，后面的条目照样 makeRecord 进清空后的新列表。
       R202-04：批次由 addFiles 在读盘前就取好并传进来——清空若发生在「读盘」这个 await 里，
       这里再读 state.importToken 会拿到清空后的新 token，等于把旧文件认成新批次。
       未传 batchToken 的调用方（旧入口/测试）仍按进入时的 token 处理。 */
    const token = batchToken === undefined ? state.importToken : batchToken;
    let res;
    try {
      res = BC.convert.expandArchive(name, bytes, depth);
    } catch (e) {
      if (token !== state.importToken) return 0; // 清空后不再给旧批次建错误卡片
      const rec = makeRecord(name, bytes);
      // #267：全站错误都走 friendlyError，唯独 ZIP 把裸英文丢给用户
      rec.error = friendlyError(e && e.message ? e.message : e) || '压缩包解析失败';
      rec.kindLabel = '压缩包';
      render();
      return 0;
    }
    let added = 0;
    for (const inner of res.files) {
      if (token !== state.importToken) break;
      const rec = makeRecord(name + ' / ' + inner.name, inner.bytes);
      const innerOpts = inner.decrypted ? { decrypted: inner.decrypted } : null;
      // 大文件会走 Worker/异步分块解析：必须 await 后重新 render，否则卡片停在「解析中」
      // 且首次导入时转换按钮一直禁用。
      rec.parsing = true;
      render();
      await parseRecord(rec, inner.name, inner.bytes, innerOpts);
      if (token !== state.importToken) break;
      rec.parsing = false;
      rec.fromZip = name;
      added++;
      render();
      await sleep(0);
    }
    if (!added && token === state.importToken) {
      const rec = makeRecord(name, bytes);
      rec.kindLabel = '压缩包';
      rec.error = (res.warnings && res.warnings[0]) || '压缩包里没有可识别的笔刷文件';
      render();
    }
    return added;
  }

  async function addFiles(fileList) {
    /* 两种输入：拖文件夹走 {file, relDir}；<input webkitdirectory> 用 webkitRelativePath */
    const arr = Array.from(fileList || []).map(function (x) {
      if (x && x.file) return { file: x.file, relDir: x.relDir || '' };
      const rel = (x && x.webkitRelativePath) || '';
      const cut = rel.lastIndexOf('/');
      return { file: x, relDir: cut > 0 ? rel.slice(0, cut) : '' };
    }).filter(function (x) { return x.file; });
    if (!arr.length) return;
    // #262 导入中再拖/再选：不静默失败，也不允许两批交错塞卡片
    if (isImporting() || isBusy()) { toast(isBusy() ? '正在转换，完成后再添加文件' : '正在导入上一个文件，稍等'); return; }
    const token = ++state.importToken;
    state.importing++;
    updateConvertButton();
    try {
    for (const item of arr) {
      const f = item.file;
      // #262 用户点了「清空」/单卡✕：token 变了就停手，不再往新列表里 push
      if (token !== state.importToken) break;
      let rec = null;
      try {
        const bytes = await readFileBytes(f).catch(function (e) { return null; });
        /* R202-04：读盘是外层第一个异步边界。清空可能就发生在这次等待里，
           那时 importToken 已经变了，后面再建卡/再展开 ZIP 都会把旧文件塞进新列表。 */
        if (token !== state.importToken) break;
        if (!bytes) {
          rec = makeRecord(f.name, null, item.relDir);
          rec.error = '读取文件失败';
          render();
          continue;
        }
        const mb = Math.round(bytes.length / 1048576);
        if (bytes.length > 400 * 1024 * 1024) toast('文件超过 400MB，网页版可能内存不足；若失败请用桌面版', 8000);
        if (bytes.length > 150 * 1024 * 1024) {
          window.__brushLogs = window.__brushLogs || [];
          window.__brushLogs.push(new Date().toISOString() + ' 大文件 ' + f.name + ' ' + mb + 'MB');
          toast('文件较大（' + mb + 'MB）：正在读取与解析，大文件可能需要 1~2 分钟', 5000);
        }
        let kind = null;
        try {
          kind = BC.convert.detect(f.name, bytes);
        } catch (e) {
          kind = null;
        }
        let opts = null;
        if (kind === 'sut' && f.path && window.BrushDesktop && window.BrushDesktop.sutDecrypted) {
          try {
            const dec = await window.BrushDesktop.sutDecrypted(f.path);
            if (dec && dec.json) opts = { decrypted: dec };
          } catch (e) { /* fall back to plain .sut */ }
        }
        if (!kind && BC.zip.isZip(bytes)) {
          try {
            setProgress(null, '解压中：' + f.name + (mb > 100 ? '（大压缩包请稍候…）' : ''));
            await sleep(0);
            if (token !== state.importToken) break;
            await addZip(f.name, bytes, 0, token);
            setProgress(null);
          } catch (e) {
            rec = makeRecord(f.name, null, item.relDir);
            rec.error = friendlyError(e.message) || '压缩包解析失败';
            render();
          }
          continue;
        }
        // 先建卡片再解析：大文件解析要一会儿，界面能立刻看到进度
        if (token !== state.importToken) break; // SUT 解密等异步边界之后也要复核批次
        rec = makeRecord(f.name, null, item.relDir);
        rec.sizeBytes = bytes.length;
        rec.parsing = true;
        render();
        await sleep(0);
        if (!kind) {
          rec.parsing = false;
          rec.error = '无法识别的文件格式（支持 .abr/.tpl/.bru/.brush/.brushset/.sut/.mtd/.gobrush/.gbr/.gih/.myb/.kpp/.bundle/.brushcategory、toolnrm 等，或包含笔刷的 ZIP）';
          render();
          continue;
        }
        const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        setProgress(null, '解析中：' + f.name + (mb > 100 ? '（大文件，请稍候…）' : ''));
        await sleep(0);
        if (token !== state.importToken) break;
        await parseRecord(rec, f.name, bytes, opts);
        if (token !== state.importToken) break;
        rec.parsing = false;
        rec.parseMs = Math.max(1, Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0));
        setProgress(null);
        render();
        await sleep(0);
      } catch (e) {
        if (!rec) {
          try { rec = makeRecord(f.name, null); } catch (e2) { rec = null; }
        }
        if (rec) {
          rec.parsing = false;
          rec.error = friendlyError(e && e.message ? e.message : String(e));
          render();
        }
        setProgress(null);
        toast('导入失败：' + (e && e.message ? e.message : e), 6000);
      }
    }
    } finally {
      state.importing = Math.max(0, state.importing - 1);
      setProgress(null);
      updateConvertButton();
    }
  }

  /* ---------------- convert ---------------- */
  function getOpts() {
    const tipSize = parseInt($('#optTipSize').value, 10) || 2048;   // 第199轮：默认取上限，避免缩笔尖
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
    const textureMode = $('#optTextureMode') ? $('#optTextureMode').value : 'pattern';
    const bruTexAsset = $('#optBruTex') ? $('#optBruTex').value : 'off';
    const bruDensity = $('#optBruDensity') ? $('#optBruDensity').value : 'off';
    const scatterScale = $('#optScatterScale') && $('#optScatterScale').value !== 'auto' ? Number($('#optScatterScale').value) / 100 : undefined;
    const autoBatch = $('#optAutoBatch') ? $('#optAutoBatch').value !== '0' : true;
    const dualBake = $('#optDualBake') ? $('#optDualBake').value !== '0' : true;
    const dualCompanion = $('#optDualCompanion') ? $('#optDualCompanion').value !== '0' : false;
    const dualPair = $('#optDualPair') ? $('#optDualPair').value !== '0' : true;
    const bruEmbed = $('#optBruEmbed') ? $('#optBruEmbed').value !== '0' : true;
    const compareReport = $('#optCompareReport') ? $('#optCompareReport').value === '1' : false;
    return { tipSize, sizeScale, spacingOverride, pressureMode, prefix, groupBySource, mode, target, packOut, goScatter, grainBake, fidelity, textureMode, bruTexAsset, bruDensity, scatterScale, autoBatch, dualBake, dualCompanion, dualPair, bruEmbed, compareReport };
  }

  /* 提示条（toast）：停留时间统一收短——默认 2.2s、最长 3.2s，点一下也能立刻关。
     以前有 5~12s 的长提示（下载图库、发现新版本等），手机上会一直挡着内容。 */
  const TOAST_DEFAULT_MS = 2200;
  const TOAST_MAX_MS = 3200;
  function toast(msg, ms) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
      el.addEventListener('click', function () { el.classList.remove('show'); });
    }
    const wait = Math.min(ms || TOAST_DEFAULT_MS, TOAST_MAX_MS);
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), wait);
  }

  // 输出 ZIP 的文件名前缀：按目标格式命名，不能一律叫"画世界笔刷"
  function outputBundleLabel(target) {
    switch (target) {
      case 'bru': return '画世界笔刷';
      case 'abr': return 'Photoshop笔刷';
      case 'tpl': return 'Photoshop工具预设';
      case 'udongman': return '优动漫笔刷';
      case 'udongman_sut': return '优动漫SUT笔刷';
      case 'udongman_mtd': return '优动漫MTD笔刷';
      case 'gopaint_abr': return '天生会画ABR';
      case 'brushset': case 'brush': return 'Procreate笔刷';
      case 'kbundle': return 'Krita笔刷';
      case 'gbr': case 'gih': return 'GIMP笔刷';
      case 'myb': return 'MyPaint笔刷';
      case 'painter': return 'Painter笔刷';
      case 'gopaint': case 'gopaint_set': return '天生会画笔刷';
      case 'medibang': case 'mbini': return 'MediBang笔刷';
      case 'sai2': return 'SAI2笔刷';
      case 'png': return '笔尖PNG';
      case 'texture_png': return '纹理PNG';
      case 'all': return '全部格式笔刷';
      default: return '笔刷包';
    }
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
    if (p === null) {
      // 有文字时保留面板显示阶段提示（解压中/解析中）；无文字才隐藏进度条
      if (!text) { progressEl.classList.add('hidden'); return; }
      progressEl.classList.remove('hidden');
      progressEl.querySelector('.bar').style.width = '0%';
      progressEl.querySelector('.ptext').textContent = text;
      return;
    }
    progressEl.classList.remove('hidden');
    progressEl.querySelector('.bar').style.width = Math.round(p * 100) + '%';
    progressEl.querySelector('.ptext').textContent = text || '';
  }

  async function convertAllOnce(sink, force, recordsOverride) {
    if (state.converting && !force) return;
    const opts = getOpts();
    // 分批转换只传入本批记录，不改 state.files：否则卡片列表会整体变成本批、
    // 勾选计数与进度条反复归零（#258）。
    const records = (recordsOverride || state.files).filter(r => r.brushes && r.brushes.some(b => b.enabled !== false));
    const totalBrushes = records.reduce((s, r) => s + r.brushes.filter(b => b.enabled !== false).length, 0);
    if (!records.length || !totalBrushes) { toast('没有可转换的笔刷'); return; }
    state.converting = true;
    if (!force) state.cancelRequested = false;
    if (typeof btnCancel !== 'undefined' && btnCancel) { btnCancel.style.display = ''; btnCancel.disabled = false; }
    if (typeof needsHsjBuiltinTip === 'function' && typeof restoreHsjShapes === 'function') {
      for (const rec of records) {
        if (rec && rec.brushes && rec.brushes.some(needsHsjBuiltinTip)) {
          await restoreHsjShapes(rec);
          rec.brushes.forEach(function (b) {
            if (b && b.tip && b.tipSource === 'synth') delete b.tipSource;
          });
        }
      }
    }
    render();
    const outFiles = [];
    const failed = [];
    const warnings = [];
    // 源文件没有 shape（笔尖/形状）图的笔刷：转出时需要明确提示（用户反馈：以前只阴在解析日志里）
    try {
      const auditList = [];
      for (const rec of records) for (const b of (rec.brushes || [])) auditList.push(b);
      if (BC.convert.tipSourceHint) {
        BC.convert.tipSourceHint(BC.convert.tipSourceAudit(auditList)).forEach(function (m) { warnings.push(m); });
      }
    } catch (e) { /* 提示失败不影响转换 */ }
    // ABR 目标：真实纹理按「来源笔刷组」各出一批 PAT，命名「组名-纹理.pat」（同组多张加 #2），
    // 与笔刷同包/同目录，不散出 PNG。烘焙模式仅附纹理备用；图案模式才把 PAT 的引用传给 ABR。
    let commonPatRefs = null;
    if (opts.target === 'abr' || opts.target === 'all') {
      try {
        const groups = new Map(); // 组名 -> 本组里还没出过 PAT 的纹理笔刷
        const seenTexture = new Set();
        let missingTextures = 0;
        for (const rec of records) {
          const base = rec.baseName || String(rec.name || '').replace(/\.[^.]+$/, '') || '笔刷组';
          const gname = BC.convert.sanitizeName((opts.prefix || '') + base, 0, true);
          for (const b of (rec.brushes || [])) {
            if (!b || b.enabled === false || !b.hasTexture) continue;
            const t = BC.convert.textureGray(b);
            if (!t) { missingTextures++; continue; }
            // 同一张纹理只出一个 PAT：按内容去重，归属它第一次出现的组
            const key = t.w + 'x' + t.h + ':' + BC.util.md5(t.gray);
            if (seenTexture.has(key)) continue;
            seenTexture.add(key);
            if (!groups.has(gname)) groups.set(gname, []);
            groups.get(gname).push(b);
          }
        }
        let patCount = 0, patFileCount = 0;
        for (const [gname, list] of groups) {
          const pat = BC.convert.makePatternFile(list, { size: 256, groupName: gname });
          if (opts.textureMode === 'pattern') {
            if (!commonPatRefs) commonPatRefs = new Map();
            pat.refs.forEach(function (v, k) { commonPatRefs.set(k, v); });
          }
          for (const f of (pat.files || [])) { outFiles.push({ name: f.name + '.pat', data: f.bytes }); patFileCount++; }
          patCount += pat.count;
        }
        if (patFileCount) {
          warnings.push('已将 ' + patCount + ' 张真实纹理导出为 ' + patFileCount + ' 个 PAT（按「笔刷组名-纹理」命名），与笔刷放在同一导出包或保存目录中；' +
            (opts.textureMode === 'pattern' ? '已按图案 ID 自动关联；先在 PS 图案面板导入这些 PAT，再导入笔刷，无需逐支选择纹理' : '笔刷仍按烘焙模式输出，PAT 可按需导入 PS 图案面板备用'));
        }
        if (missingTextures) warnings.push(missingTextures + ' 支笔刷缺少原纹理图片，未收入本次 PAT');
      } catch (e) { warnings.push('纹理 PAT 生成失败：' + e.message); }
    }
    // 原样保留的 ABR 仍引用原图案；附备用 PAT 不会静默替换源引用。
    if ((opts.target === 'abr' || opts.target === 'all') && opts.textureMode !== 'pattern') {
      let refCount = 0;
      for (const rec of records) {
        for (const b of rec.brushes) {
          if (b && b.enabled !== false && b.hasTexture && (b.source === 'abr' || b._rawPreset)) refCount++;
        }
      }
      if (refCount > 0) warnings.push('ABR 里保留了 ' + refCount + ' 支笔刷的原纹理引用；如目标 PS 缺少原图案，可改「纹理处理=图案文件」，让笔刷引用本次 PAT 合集后重新导出');
    }
    try {
      if (opts.compareReport !== false && BC.convert.buildCompareHtml) {
        const cmpHtml = BC.convert.buildCompareHtml(
          records.reduce(function (acc, r) { return acc.concat(r.brushes.filter(function (b) { return b.enabled !== false; })); }, []),
          opts.target,
          { fileName: records.map(function (r) { return r.name; }).join(' + '), options: opts }
        );
        outFiles.push({ name: '参数对比.html', data: new TextEncoder().encode(cmpHtml) });
      }
    } catch (e) { /* 对比页失败不影响转换 */ }
    /* 【第190轮审批】texture_png **故意不放进 ALL_FORMATS**：它是「把某支笔刷的纹理图导出来看」
       的辅助目标，不是一种笔刷格式。放进批量清单会让用户点「全部格式」时每支笔刷多产一个
       _纹理.png，而且没有纹理的笔刷各刷一条「没有纹理，已跳过」——79 支的包里能刷出几十条
       噪音，把真正重要的警告（丢参数、近似映射）淹掉。用户需要时在目标下拉里单独选。 */
    const ALL_FORMATS = ['bru', 'abr', 'tpl', 'udongman', 'gopaint', 'gopaint_set', 'brushset', 'brush', 'gbr', 'gih',
      'myb', 'kbundle', 'sai2', 'png', 'painter', 'medibang', 'mbini'];
    const usedFileNames = new Set();
    let doneCount = 0;
    let outBytes = 0;

    function uniqueFile(base, ext) {
      let name = base, k = 2;
      while (usedFileNames.has((name + ext).toLowerCase())) { name = base + ' (' + k + ')'; k++; }
      usedFileNames.add((name + ext).toLowerCase());
      return name + ext;
    }
    /* 【第190轮】「纹理 PNG」目标：逐支调用 makeTexturePng（它内部会让 textureGray
       兜底到画世界内置纹理库）。没有纹理的笔刷不能静默掉，必须给一条跳过警告。
       输出名走 uniqueFile + sanitizeName，与其它格式完全一致。 */
    function emitTexturePng(b, nameBase) {
      const made = BC.convert.makeTexturePng(b);
      if (made && made.bytes && made.bytes.length) {
        outFiles.push({ name: uniqueFile(nameBase + '_纹理', '.png'), data: made.bytes });
        return true;
      }
      warnings.push((b.name || '未命名') + '：没有纹理，已跳过');
      return false;
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
        scatterScale: opts.scatterScale,
        dualBake: opts.dualBake,
        noTextureBake: opts.grainBake === false,
        patternRefs: commonPatRefs,
        fidelity: opts.fidelity === false ? false : undefined,
        textureMode: (opts.target === 'abr' || opts.target === 'all' || opts.target === 'tpl') ? opts.textureMode : undefined,
        bruTexAsset: opts.bruTexAsset && opts.bruTexAsset !== 'off' ? opts.bruTexAsset : undefined,
        bruDensity: opts.bruDensity === 'off' ? 'off' : undefined
      };
    }

    for (let recIdx = 0; recIdx < records.length; recIdx++) {
      if (state.cancelRequested) { warnings.push('已取消：已转换的部分仍会打包'); break; }
      const rec = records[recIdx];
      try { btnConvert.textContent = '转换中 ' + (recIdx + 1) + '/' + records.length + ' …'; } catch (e) { /* ignore */ }
      await new Promise(function (r) { setTimeout(r, 0); });
      const list = rec.brushes.filter(b => b.enabled !== false);
      if (!list.length) continue;
      if (list.some(function (b) { return b.dualOn && !b.dualTip; })) {
        warnings.push('部分双笔刷缺少副笔图像，无法完整写出；请提供含主副笔资源的原始整包');
      }
      const targets = opts.target === 'all' ? ALL_FORMATS : [opts.target || 'bru'];
      if (targets.indexOf('bru') >= 0) {
        const textured = list.filter(function (b) { return b.source !== 'bru' && b.hasTexture; });
        if (textured.length) {
          const available = textured.filter(function (b) { return !!(b._grainRgba || b._patternPixels); }).length;
          const texLayerOn = opts.bruTexAsset && opts.bruTexAsset !== 'off';
          if (available && opts.grainBake !== false) {
            warnings.push(texLayerOn
              ? '画世界：' + available + ' 支真实纹理已烘进笔尖，并额外挂了画世界内置材质纹理层（两者叠加）；材质 id 依赖画世界版本，导入后请先试画一笔。'
              : '画世界：' + available + ' 支真实纹理按选项近似烘焙进笔尖；单独纹理层未开启（可在高级设置「画世界真纹理」打开），空纹理保持关闭。');
          }
          if (available < textured.length || opts.grainBake === false) warnings.push('画世界：缺少纹理原图或关闭烘焙的笔刷未写出纹理，已关闭空纹理避免无法出墨。');
          if (texLayerOn) warnings.push('画世界：纹理层只验证过「沙纸（pt24）」；若某些笔刷画不出来，把「画世界真纹理」改回关再转一次。');
        }
      }
      /* 【第184轮】转 .bru 时不再额外附带 .abr。
         那个 ABR 是早年 BRU 还不支持双笔刷时的兜底，现在单支 BRU 已能内嵌副笔
         （f119 + 记录末尾副图），画世界自己就能表达双笔；而额外那个 ABR 在画世界
         里打开会闪退。实测反馈后直接移除这条出口。 */
      if (opts.target === 'abr' && list.some(function (b) { return b.dualOn && !b._rawPreset; })) {
        warnings.push('已生成 ABR 原生双笔刷结构，请在 Photoshop 验证导入与效果');
      }
      if ((opts.target === 'brush' || opts.target === 'brushset') && list.some(function (b) { return b.dualOn; })) {
        warnings.push('Procreate 双笔刷已写入独立 Sub01 副笔，未烘焙主笔；请在 Procreate 验证效果');
      }
      if (opts.target === 'all' && opts.mode === 'pack') {
        warnings.push('全部格式：会生成 ' + ALL_FORMATS.length + ' 种格式，文件较多，请耐心等待');
      }
      if (opts.mode === 'pack') {
        // whole set -> one file per target format
        setProgress(doneCount / totalBrushes, '正在打包 ' + (rec.baseName || rec.name) + '（' + list.length + ' 支）…');
        await sleep(0);
        const sourceName = rec.baseName || rec.name.replace(/\.[^.]+$/, '') || '笔刷集';
        const base = BC.convert.sanitizeName(opts.prefix + sourceName, 0, true);
        for (const fmt of targets) {
          try {
            if (fmt === 'brushset') {
              // 组名必须用包名（文件名），否则会回落到 brushList[0].name，
              // 导入 Procreate 后整包显示成第一支笔刷的名字（如「感谢支持」）。
              const made = BC.convert.makeProcreateBrushset(list, Object.assign(commonOpts(rec), { setName: base }));
              outFiles.push({ name: uniqueFile(base, '.brushset'), data: made.bytes });
            } else if (fmt === 'brush' || fmt === 'gbr' || fmt === 'myb') {
              for (const b of list) {
                const co = commonOpts(rec);
                const made = fmt === 'brush'
                  ? BC.convert.makeProcreateBrush(b, co)
                  : fmt === 'gbr' ? BC.convert.makeGbr(b, co)
                  : fmt === 'myb' ? BC.convert.makeMyb(b, co)
                  : BC.convert.makeIpcfg(b, co);
                const bname = BC.convert.sanitizeName(opts.prefix + (b.name || 'brush'), 0, true);
                outFiles.push({ name: uniqueFile(bname, '.' + fmt), data: made.bytes });
              }
            } else if (fmt === 'sai2') {
              const made = BC.convert.makeSai2Pack(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base, '.zip'), data: made.bytes });
              if (made.warnings && made.warnings.length) warnings.push(...made.warnings);
              autoSaveSai2ToFolder(list, commonOpts(rec)).catch(function () { /* 已在内部记日志 */ });
            } else if (fmt === 'kbundle') {
              const made = BC.convert.makeKritaBundle(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base, '.bundle'), data: made.bytes });
              if (made.warnings && made.warnings.length) warnings.push(...made.warnings);
            } else if (fmt === 'gih') {
              /* 【第189轮】GIMP 的 .gih 是「一支笔刷的多 cell 数组」，GIMP 内部
                 gimp_brush_pipe_select_brush 每次落笔只从里面挑一个 cell 给画笔用。
                 以前把整组塞进一个 pipe，用户在 GIMP 里只拿到一支「每次落笔换图案」的笔刷，
                 不是 N 支笔刷。改成逐支输出（同名自动加 _2 后缀）。
                 单支笔刷若开了散布，makeGih 内部会做成「N 个偏移副本 + sel0:random」。 */
              const made = BC.convert.makeGihFiles(list, commonOpts(rec));
              for (const f of made.files) outFiles.push({ name: uniqueFile(f.name, '.gih'), data: f.bytes });
              if (made.warnings && made.warnings.length) warnings.push(...made.warnings);
            } else if (fmt === 'painter') {
              const made = BC.convert.makePainter(list, commonOpts(rec), sourceName);
              outFiles.push({ name: uniqueFile(base, '.brushcategory'), data: made.bytes });
            } else if (fmt === 'mbini') {
              for (const b of list) {
                const made = BC.convert.makeMediBangIniPack([b], commonOpts(rec));
                const bname = BC.convert.sanitizeName(opts.prefix + (b.name || 'medibang'), 0, true);
                outFiles.push({ name: uniqueFile(bname, '.zip'), data: made.bytes });
              }
            } else if (fmt === 'medibang') {
              for (const b of list) {
                const made = BC.convert.makeMediBangBrush(b, commonOpts(rec));
                const bname = BC.convert.sanitizeName(opts.prefix + (b.name || 'medibang'), 0, true);
                outFiles.push({ name: uniqueFile(bname, '.zip'), data: made.bytes });
              }
            } else if (fmt === 'png') {
              const made = BC.convert.makeTipPngPack(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base, '.zip'), data: made.bytes });
            } else if (fmt === 'texture_png') {
              for (const b of list) {
                const bname = BC.convert.sanitizeName(opts.prefix + (b.name || 'brush'), 0, true);
                emitTexturePng(b, bname);
              }
            } else if (fmt === 'gopaint_set') {
              const made = BC.convert.makeGoPaintGroup(list, Object.assign({}, commonOpts(rec), { groupName: (opts.prefix || '') + sourceName }));
              outFiles.push({ name: uniqueFile(base, '.gobrushes'), data: made.bytes });
            } else if (fmt === 'gopaint') {
              for (const b of list) {
                const made = BC.convert.makeGoPaintBrush(b, commonOpts(rec));
                outFiles.push({ name: uniqueFile(BC.convert.sanitizeName(opts.prefix + (b.name || 'gopaint'), 0, true), '.gobrush'), data: made.bytes });
              }
            } else if (fmt === 'gopaint_abr') {
              const made = BC.convert.makeGoPaintAbr(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base, '.abr'), data: made.bytes });
            } else if (fmt === 'udongman') {
              const made = BC.convert.makeUdongmanPack(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base, '.abr'), data: made.bytes });
              outFiles.push({ name: uniqueFile(base + '_优动漫导入说明', '.txt'), data: BC.util.utf8Encode(made.importGuide) });
              warnings.push(...made.warnings);
            } else if (fmt === 'udongman_sut') {
              const made = BC.convert.makeUdongmanSutPack(list, commonOpts(rec));
              // 第201轮（第189轮审查 P2-#21）：目录名也走 uniqueFile，两个同名源各自一个目录，不再混在一起互相覆盖
              const dir = uniqueFile(base + '_优动漫SUT', '/');
              for (const f of made.files) outFiles.push({ name: dir + f.name, data: f.data });
              outFiles.push({ name: uniqueFile(base + '_优动漫SUT导入说明', '.txt'), data: BC.util.utf8Encode(made.importGuide) });
              warnings.push(...made.warnings);
            } else if (fmt === 'udongman_mtd') {
              const made = BC.convert.makeUdongmanMtdPack(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base, '.mtd'), data: made.bytes });
              outFiles.push({ name: uniqueFile(base + '_优动漫MTD导入说明', '.txt'), data: BC.util.utf8Encode(made.importGuide) });
              warnings.push(...made.warnings);
            } else if (fmt === 'tpl') {
              const made=BC.convert.makeTplPack(list,commonOpts(rec));
              outFiles.push({name:uniqueFile(base,'.tpl'),data:made.bytes});
              warnings.push(...made.warnings);
            } else if (fmt === 'abr') {
              // 源就是 .abr 且整包导出时：原样透传，100% 保留文件夹分组 / 动态 / 计算画笔
              const isAbrSource = /^abr$/i.test(rec.kind || '') || /\.abr$/i.test(rec.name || '');
              const allSelected = rec.brushes && list.length === rec.brushes.length;
              const rebindTextures = opts.textureMode === 'pattern' && commonPatRefs &&
                list.some(function (b) { return b.hasTexture && commonPatRefs.has(BC.convert.textureKey(b)); });
              const unchangedSettings=opts.sizeScale===1 && !(opts.spacingOverride>0) && opts.pressureMode==='auto' && opts.fidelity!==false;
              const unchangedBrushes=list.every(function(b){return b._rawBrushState && b._rawBrushState===BC.util.brushFingerprint(b);});
              if (isAbrSource && allSelected && unchangedSettings && unchangedBrushes && !rebindTextures) {
                // 整包 ABR→ABR 等于复制文件，没必要产出；只有筛选子集/合并才需要重新打包
                warnings.push((rec.name || 'ABR') + '：源文件已经是 .abr 且整包导出，跳过（如需筛选/拆分，请只勾选部分笔刷）');
              } else {
                const made = BC.convert.makeAbrPack(list, commonOpts(rec));
                outFiles.push({ name: uniqueFile(base, '.abr'), data: made.bytes });
              }
            } else {
              let packList = list;
              let pairNote = false;
              if (opts.bruEmbed === false && opts.dualPair !== false && BC.convert.buildBruDualPairBrushes) {
                packList = [];
                for (const b of list) {
                  if (b.dualOn && b.dualTip) {
                    const pair = BC.convert.buildBruDualPairBrushes(b);
                    if (pair) { packList.push(pair.primary, pair.secondary); pairNote = true; continue; }
                  }
                  packList.push(b);
                }
              }
              const made = BC.convert.makeBruPack(packList, Object.assign({}, commonOpts(rec), { dualBake: pairNote ? false : opts.dualBake, embedSubTip: opts.bruEmbed !== false }));
              outFiles.push({ name: uniqueFile(base, '.bru'), data: made.bytes });
              if (pairNote) warnings.push('画世界双笔刷：主笔旁的「原笔刷名_副笔尖」是关联辅助笔尖，请选择主笔使用；辅助条目并非重复笔刷，删除会影响双笔效果');
              else if (opts.bruEmbed !== false && list.some(function (b) { return b.dualOn && b.dualTip; })) warnings.push('画世界双笔刷已内嵌副笔尖，不额外增加辅助笔刷条目；整包文件仍可包含多支主笔刷。');
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
        const brushTag = (b.name || '').trim();
        const composed = (opts.prefix || '') + (brushTag || rec.baseName || ('笔刷 ' + String(i + 1).padStart(2, '0')));
        const base = BC.convert.sanitizeName(composed, doneCount, true);
        /* 目录结构优先：从文件夹导入的笔刷按原来的子目录还原；否则退回「按来源分文件夹」 */
        const relDir = String(rec.relDir || '').replace(/^\/+|\/+$/g, '');
        const folder = relDir
          ? relDir.split('/').map(function (seg) { return BC.convert.sanitizeName(seg, 0, true); }).join('/') + '/'
          : (opts.groupBySource && rec.baseName ? BC.convert.sanitizeName(rec.baseName, 0, true) + '/' : '');
        for (const fmt of targets) {
          try {
            if (fmt === 'texture_png') { emitTexturePng(b, folder + base); continue; }
            const co = commonOpts(rec);
            if (fmt === 'bru' && opts.bruEmbed !== false && b.dualTip && BC.convert.makeBru) {
              const made = BC.convert.makeBru(b, Object.assign({}, co, { embedSubTip: true }));
              outFiles.push({ name: uniqueFile(folder + base, '.bru'), data: made.bytes });
              warnings.push(b.dualOn ? '双笔刷已按画世界原生 3.0 单支内嵌副笔尖写出（一个文件=一支笔刷）' : '已内嵌缓存副笔尖，双笔刷保持关闭');
              continue;
            }
            if (fmt === 'bru' && opts.dualPair !== false && b.dualOn && b.dualTip && BC.convert.makeBruDualPair) {
              const pair = BC.convert.makeBruDualPair(b, co);
              if (pair) {
                outFiles.push({ name: uniqueFile(folder + base, '.bru'), data: pair.bytes });
                warnings.push('双笔刷已输出为主笔及「原笔刷名_副笔尖」辅助条目，请选择主笔使用，保留关联辅助条目');
                continue;
              }
            }
            const made = fmt === 'udongman'
              ? BC.convert.makeUdongmanPack([b], co)
              : fmt === 'udongman_sut'
              ? BC.convert.makeUdongmanSutPack([b], co)
              : fmt === 'udongman_mtd'
              ? BC.convert.makeUdongmanMtdPack([b], co)
              : fmt === 'abr'
              ? BC.convert.makeAbrPack([b], co)
              : fmt === 'tpl' ? BC.convert.makeTplPack([b],co)
              : fmt === 'gopaint' ? BC.convert.makeGoPaintBrush(b, co)
              : fmt === 'gopaint_set' ? BC.convert.makeGoPaintGroup([b], Object.assign({}, co, { groupName: b.name }))
              : fmt === 'gopaint_abr' ? BC.convert.makeGoPaintAbr([b], co)
              : fmt === 'brushset' ? BC.convert.makeProcreateBrushset([b], co)
              : fmt === 'brush' ? BC.convert.makeProcreateBrush(b, co)
              : fmt === 'gbr' ? BC.convert.makeGbr(b, co)
              : fmt === 'myb' ? BC.convert.makeMyb(b, co)
              : fmt === 'sai2' ? BC.convert.makeSai2Pack([b], co)
              : fmt === 'kbundle' ? BC.convert.makeKritaBundle([b], co)
              : fmt === 'gih' ? BC.convert.makeGih([b], co)
              : fmt === 'painter' ? BC.convert.makePainter([b], co, b.name)
              : fmt === 'mbini' ? BC.convert.makeMediBangIniPack([b], co)
              : fmt === 'medibang' ? BC.convert.makeMediBangBrush(b, co)
              : fmt === 'png' ? BC.convert.makeTipPng(b, co)
              : BC.convert.makeBru(b, co);
            const extOut = { painter: '.brushcategory', kbundle: '.bundle', sai2: '.zip', medibang: '.zip', mbini: '.zip',
              udongman: '.abr', udongman_sut: '.sut', udongman_mtd: '.mtd', gopaint: '.gobrush', gopaint_abr: '.abr', gopaint_set: '.gobrushes' }[fmt] || ('.' + fmt);
            outFiles.push({ name: uniqueFile(folder + base, extOut), data: made.bytes });
            if (fmt === 'sai2') autoSaveSai2ToFolder([b], co).catch(function () { /* 已在内部记日志 */ });
            /* 第165轮：所有 writer 的不可保真提示统一收集（原先只有 tpl）。
               GIH/MDP 等纯位图格式回读会静默重置尺寸与间距，互转时尤其需要提示。 */
            if (made.warnings && made.warnings.length) made.warnings.forEach(w => { if (warnings.indexOf(w) < 0) warnings.push(w); });
            if (fmt === 'udongman') {
              if (!outFiles.some(f => f.name === '优动漫导入说明.txt')) outFiles.push({ name: '优动漫导入说明.txt', data: BC.util.utf8Encode(made.importGuide) });
              made.warnings.forEach(w => { if (warnings.indexOf(w) < 0) warnings.push(w); });
            }
            if (fmt === 'udongman_sut') {
              if (!outFiles.some(f => f.name === '优动漫SUT导入说明.txt')) outFiles.push({ name: '优动漫SUT导入说明.txt', data: BC.util.utf8Encode(made.importGuide) });
              made.warnings.forEach(w => { if (warnings.indexOf(w) < 0) warnings.push(w); });
            }
            if (fmt === 'udongman_mtd') {
              if (!outFiles.some(f => f.name === '优动漫MTD导入说明.txt')) outFiles.push({ name: '优动漫MTD导入说明.txt', data: BC.util.utf8Encode(made.importGuide) });
              made.warnings.forEach(w => { if (warnings.indexOf(w) < 0) warnings.push(w); });
            }
            if (fmt === 'png') {
              // PNG 笔尖旁边同时输出该笔刷的参数，方便在目标软件里手动还原设置
              outFiles.push({
                name: uniqueFile(folder + base + '_参数', '.txt'),
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

    setProgress(0.99, opts.packOut === false ? '正在保存文件…' : '正在准备输出文件…');
    await sleep(10);
    const onlyAux = outFiles.length > 0 && outFiles.every(function (f) { return isAuxOutFile(f.name); });
    if (!outFiles.length) {
      // 没有任何真实输出：区分「真的失败」与「被合理跳过/未勾选」，并把已收集的
      // warnings 当作原因展示，而不是笼统的「未知错误」（#257）。
      state.converting = false;
      try { if (typeof btnCancel !== 'undefined' && btnCancel) btnCancel.style.display = 'none'; } catch (e) { /* ignore */ }
      setProgress(null);
      render();
      const reason = failed.length ? failed[0] : (warnings.length ? warnings[0] : '请勾选至少一支笔刷，或确认源文件没有被全部跳过');
      toast((failed.length ? '转换失败：' : '没有产生输出文件：') + reason, 8000);
      return;
    }
    if (onlyAux) {
      // 只生成了辅助文件（例如纹理 .pat / 参数文本）。原先这里直接 return，
      // 会把已生成的 .pat 丢掉、安装说明与报告也永远不落盘（#261）。
      warnings.push('本次没有生成笔刷文件，只生成了辅助文件（如纹理 .pat / 参数文本）；已按辅助文件打包');
    }
    // 输出体积提示：几百支大笔刷时提醒分批，避免浏览器内存爆掉
    let totalOut = 0;
    for (const f of outFiles) totalOut += (f.data && f.data.length) || 0;
    if (totalOut > 500 * 1024 * 1024) {
      warnings.push('本次输出约 ' + (totalOut / 1048576).toFixed(0) + 'MB，可能超出浏览器内存，建议分 2~3 批转换（每批 50~100 支）');
    } else if (totalOut > 200 * 1024 * 1024) {
      warnings.push('本次输出约 ' + (totalOut / 1048576).toFixed(0) + 'MB，若保存失败请分批转换');
    }
    // prepare output payload: zip mode -> one zip; files mode -> individual files
    let payload;
    if (opts.packOut === false || sink) {
      payload = outFiles;
    } else {
      // Count every output, including PAT and reports: 1–3 direct, 4+ ZIP.
      const mobileWeb = !window.BrushNative && !window.BrushDesktop && window.BCSaver &&
        window.BCSaver.isMobileBrowser && window.BCSaver.isMobileBrowser();
      if (exportWithoutZip(outFiles, onlyAux, mobileWeb, totalOut)) {
        // All platforms: 1–3 actual output files save directly, including PAT/reports.
        payload = outFiles.slice();
      } else {
      const ts = new Date();
      const pad = n => String(n).padStart(2, '0');
      const stamp = ts.getFullYear() + pad(ts.getMonth() + 1) + pad(ts.getDate()) + '_' + pad(ts.getHours()) + pad(ts.getMinutes());
      const bundleName = records.length === 1
        ? BC.convert.sanitizeName((opts.prefix || '') + (records[0].baseName || records[0].name.replace(/\.[^.]+$/, '') || '笔刷集'), 0, true)
        : outputBundleLabel(opts.target) + '_' + stamp;
      const LIMIT = 120 * 1024 * 1024;
      if (opts.autoBatch !== false && totalOut > 200 * 1024 * 1024) {
        // 大输出自动分卷：每卷最多 120MB，避免浏览器一次分配超大 Buffer
        const vols = [];
        let cur = [], curSize = 0;
        for (const f of outFiles) {
          const sz = (f.data && f.data.length) || 0;
          if (cur.length && curSize + sz > LIMIT) { vols.push(cur); cur = []; curSize = 0; }
          cur.push(f); curSize += sz;
        }
        if (cur.length) vols.push(cur);
        payload = vols.map(function (files, i) {
          return { name: bundleName + '_' + (i + 1) + 'of' + vols.length + '.zip', data: BC.zip.write(files) };
        });
        warnings.push('输出较大，已自动分成 ' + vols.length + ' 个 ZIP（每卷约 120MB）');
      } else {
        payload = [{ name: bundleName + '.zip', data: BC.zip.write(outFiles) }];
      }
      }
    }
    if (sink) {
      // 分批模式：只把这一批的结果交出去，由外层统一保存
      sink.push({ payload: payload, warnings: warnings.slice(), doneCount: doneCount, failed: failed.slice(), fileCount: outFiles.length });
      state.lastWarnings = warnings.slice();
      renderWarnings();
      state.converting = !!force;   // 分批时保持转换中，防止重复点击
      setProgress(null);
      render();
      return;
    }
    setProgress(0.995, opts.packOut === false ? '正在保存文件…' : '正在准备输出文件…');
    // #264 提示不再只活在 toast 里：转完就落盘到面板，保存失败也能看到
    state.lastWarnings = warnings.slice();
    renderWarnings();
    let savedMsg = '';
    try {
      lastSavedFiles = payload;
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
    renderResultPanel();
  }

  /* 每 N 支一个包 */
  function buildBrushChunks(n) {
    const flat = [];
    state.files.forEach(function (rec, ri) {
      const list = (rec.brushes || []).filter(function (b) { return b && b.enabled !== false; });
      list.forEach(function (b) { flat.push({ ri: ri, b: b }); });
    });
    if (!flat.length) return [];
    const chunks = [];
    for (let i = 0; i < flat.length; i += n) {
      const slice = flat.slice(i, i + n);
      const byRec = new Map();
      slice.forEach(function (it) {
        if (!byRec.has(it.ri)) byRec.set(it.ri, { rec: state.files[it.ri], brushes: [] });
        byRec.get(it.ri).brushes.push(it.b);
      });
      const records = [];
      byRec.forEach(function (v) {
        records.push(Object.assign({}, v.rec, { brushes: v.brushes }));
      });
      chunks.push(records);
    }
    return chunks;
  }

  async function convertAllBatches() {
    if (state.converting) return;
    const sel = $('#optBatchN');
    const n = sel ? Number(sel.value) || 0 : 0;
    if (n <= 0) return convertAllOnce(null);
    const chunks = buildBrushChunks(n);
    if (chunks.length <= 1) return convertAllOnce(null);
    const orig = state.files;
    const sink = [];
    state.converting = true;
    state.cancelRequested = false;
    if (typeof btnCancel !== 'undefined' && btnCancel) { btnCancel.style.display = ''; btnCancel.disabled = false; }
    render();
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (state.cancelRequested) break;
        await convertAllOnce(sink, true, chunks[i]);
      }
    } finally {
      state.files = orig;
      state.converting = false;
      if (typeof btnCancel !== 'undefined' && btnCancel) btnCancel.style.display = 'none';
    }
    const all = [];
    sink.forEach(function (r) { r.payload.forEach(function (f) { all.push(f); }); });
    // 分批时每个组各有一批「组名-纹理.pat」：先按内容去掉完全重复的，其它保留（ABR 里的图案 ID 不会失效）
    const patKeys = new Set();
    for (let i = all.length - 1; i >= 0; i--) {
      if (!/\.pat$/i.test(all[i].name)) continue;
      const key = BC.util.md5(all[i].data);
      if (patKeys.has(key)) { all.splice(i, 1); continue; }
      patKeys.add(key);
    }
    // Different batches of the same source group have fresh pattern IDs, so
    // byte dedup alone cannot produce the one-PAT-per-group output contract.
    const groupPats = new Map(), mergedAway = new Set();
    for (const f of all) if (/\.pat$/i.test(f.name)) {
      const key = f.name.toLowerCase();
      if (!groupPats.has(key)) groupPats.set(key, []);
      groupPats.get(key).push(f);
    }
    for (const files of groupPats.values()) if (files.length > 1) {
      files[0].data = BC.convert.mergePatternFiles(files.map(f => f.data)).bytes;
      files.slice(1).forEach(f => mergedAway.add(f));
    }
    for (let i=all.length-1;i>=0;i--) if (mergedAway.has(all[i])) all.splice(i,1);
    all.sort(function (a, b) {
      const ap = /\.pat$/i.test(a.name) ? 0 : 1, bp = /\.pat$/i.test(b.name) ? 0 : 1;
      return ap - bp;
    });
    // Keep original names, including existing numbered names, across batches.
    const nameKey = name => name.normalize('NFC').toLowerCase();
    const reservedNames = new Set(all.map(f => nameKey(f.name)));
    const seen = new Set();
    all.forEach(function (f) {
      const key = nameKey(f.name);
      if (seen.has(key)) {
        const m = f.name.match(/^(.*?)(\.[^./]+)$/);
        const base = m ? m[1] : f.name, ext = m ? m[2] : '';
        let k = 2, candidate;
        do { candidate = base + ' (' + k++ + ')' + ext; }
        while (reservedNames.has(nameKey(candidate)) || seen.has(nameKey(candidate)));
        f.name = candidate;
      }
      seen.add(nameKey(f.name));
    });
    const warns = [];
    let done = 0, failedCount = 0, files = 0;
    sink.forEach(function (r) {
      r.warnings.forEach(function (w) { if (warns.indexOf(w) < 0) warns.push(w); });
      done += r.doneCount || 0;
      failedCount += (r.failed || []).length;
      files += r.fileCount || 0;
    });
    files = all.length;
    if (warns.length) toast(warns[0], 6000);
    state.converting = false;
    setProgress(null);
    render();
    try {
      const packOutMode = $('#optPack') ? $('#optPack').value !== 'files' : true;
      let outAll = all;
      // 打包模式下多批结果合并：只有 1 个笔刷文件时直接输出该文件本身（与单批一致）；
      // 多个文件重新打成一个 ZIP，保持「打包」语义。
      if (packOutMode && all.length >= 4) {
        const ts = new Date();
        const pad = n => String(n).padStart(2, '0');
        const stamp = ts.getFullYear() + pad(ts.getMonth() + 1) + pad(ts.getDate()) + '_' + pad(ts.getHours()) + pad(ts.getMinutes());
        const bundleName = orig.length === 1
          ? BC.convert.sanitizeName((($('#optPrefix') || {}).value || '') + (orig[0].baseName || String(orig[0].name || '').replace(/\.[^.]+$/, '') || '笔刷集'), 0, true)
          : outputBundleLabel($('#optTarget') ? $('#optTarget').value : '') + '_' + stamp;
        outAll = [{ name: bundleName + '.zip', data: BC.zip.write(all) }];
      }
      lastSavedFiles = outAll;
      const savedMsg = await saveOutputs(outAll, { packOut: packOutMode });
      if (savedMsg === null) { toast('已取消保存'); return; }
      if (savedMsg && String(savedMsg).indexOf('ERROR') === 0) throw new Error(String(savedMsg).slice(6));
      let msg = '完成：' + sink.length + (packOutMode ? (outAll.length === 1 ? ' 个文件' : ' 个包') : ' 批文件') + '（' + files + ' 个文件，共 ' + done + ' 支笔刷）';
      if (failedCount) msg += '，' + failedCount + ' 支失败';
      toast(msg + (savedMsg ? '｜' + savedMsg : ''), 9000);
      setOutputLocation(savedMsg);
    } catch (e) {
      toast('保存失败：' + (e && e.message ? e.message : e), 7000);
    }
  }

  async function convertAll() {
    if (isBusy()) return;
    state.activeJob = true;
    // Release the previous ZIP before allocating the next conversion output.
    lastSavedFiles = null;
    renderResultPanel();
    updateConvertButton();
    try {
      await convertAllBatches();
    } catch (e) {
      pushLog('CONVERT ' + (e && e.message ? e.message : e));
      toast('转换失败：' + friendlyError(e && e.message ? e.message : e), 7000);
    } finally {
      state.activeJob = false;
      state.converting = false;
      if (btnCancel) btnCancel.style.display = 'none';
      setProgress(null);
      render();
      renderResultPanel();
    }
  }

  /* Output saving is delegated to the environment adapter (window.BCSaver):
     web / desktop / android builds all load save-legacy.js
     （小红书小工具容器版已于 v2.5.57 停止支持，save-minitool.js 已删除） */
  async function saveOutputs(files, saveOpts) {
    const saver = window.BCSaver;
    if (!saver || typeof saver.save !== 'function') {
      toast('当前环境不支持保存文件', 7000);
      return '';
    }
    if (state.saving) throw new Error('上一批文件仍在保存，请等待完成');
    state.saving = true;
    updateConvertButton();
    try {
      const result = await saver.save(files, saveOpts || {}, {
        progress: function (p, text) { setProgress(0.99 + 0.009 * p, text); }
      });
      if (directoryControls && !directoryControls.hidden) await refreshDirectory();
      return result;
    } finally {
      state.saving = false;
      if (!state.activeJob) setProgress(null);
      updateConvertButton();
    }
  }
  /* Prepare visible links before the next tap; conversion itself may outlive
     the user activation needed by mobile download/share UI. */
  function formatSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  /* #264 转换提示常驻面板：警告/失败原因不再一闪而过 */
  function renderWarnings() {
    const panel = $('#warnPanel');
    const list = $('#warnList');
    const head = $('#warnHead');
    if (!panel || !list) return;
    const items = (state.lastWarnings || []).filter(function (w) { return w && String(w).trim(); });
    if (!items.length) {
      panel.style.display = 'none';
      list.innerHTML = '';
      return;
    }
    panel.style.display = '';
    head.textContent = '转换提示（' + items.length + ' 条，可能影响目标软件里的显示效果）';
    list.innerHTML = '';
    items.slice(0, 30).forEach(function (w) {
      const row = document.createElement('div');
      row.className = 'result-item result-warn';
      const name = document.createElement('span');
      name.className = 'result-name';
      name.textContent = String(w);
      row.appendChild(name);
      list.appendChild(row);
    });
    if (items.length > 30) {
      const more = document.createElement('div');
      more.className = 'result-item';
      const span = document.createElement('span');
      span.className = 'result-name';
      span.textContent = '另有 ' + (items.length - 30) + ' 条提示（完整列表见输出里的「转换报告.txt」）';
      more.appendChild(span);
      list.appendChild(more);
    }
  }
  (function initWarnPanel() {
    const btn = $('#btnWarnClose');
    if (btn) btn.addEventListener('click', function () { const p = $('#warnPanel'); if (p) p.style.display = 'none'; });
  })();

  function renderResultPanel() {
    const panel = $('#resultPanel');
    const list = $('#resultList');
    if (!panel || !list) return;
    const files = lastSavedFiles || [];
    const webOnly = !window.BrushNative && !window.BrushDesktop;
    const saver = window.BCSaver;
    if (!files.length || !webOnly) {
      if (saver && saver.releaseDownloads) saver.releaseDownloads();
      preparedShare = null;
      preparedShareSource = null;
      panel.style.display = 'none';
      list.innerHTML = '';
      return;
    }
    panel.style.display = '';
    list.innerHTML = '';
    if (preparedShareSource !== files) {
      preparedShareSource = files;
      preparedShare = null;
      if (saver && saver.prepareShare) {
        try { preparedShare = saver.prepareShare(files); }
        catch (e) { pushLog('SHARE 准备失败：' + (e.message || e)); }
      }
    }
    if (btnShare) btnShare.textContent = preparedShare && preparedShare.zipped ? '分享ZIP保存' : '分享保存';
    if (btnShareResult) btnShareResult.textContent = preparedShare && preparedShare.zipped ? '分享ZIP保存' : '分享保存';
    const iosWebKit = window.BCSaver && typeof window.BCSaver.isIOSWebKit === 'function'
      ? window.BCSaver.isIOSWebKit() : false;
    if (iosWebKit) {
      const iosNote = document.createElement('div');
      iosNote.className = 'result-item result-warn';
      const iosTxt = document.createElement('span');
      iosTxt.className = 'result-name';
      iosTxt.textContent = '苹果：点「下载」后到「文件」App 查看；也可用「分享保存」存到文件。';
      iosNote.appendChild(iosTxt);
      list.appendChild(iosNote);
    }
    const hostile = window.BCSaver && typeof window.BCSaver.downloadHostileName === 'function'
      ? window.BCSaver.downloadHostileName() : '';
    if (hostile) {
      const note = document.createElement('div');
      note.className = 'result-item result-warn';
      const txt = document.createElement('span');
      txt.className = 'result-name';
      txt.textContent = preparedShare
        ? '没反应就用「分享保存」。'
        : '这个浏览器可能拦下载：用「分享保存」，或装安卓版 App。';
      /* 不再区分浏览器：统一给「安卓版 App（夸克网盘）」，用户自己点开链接取安装包 */
      const appLink = document.createElement('a');
      appLink.className = 'btn primary';
      appLink.href = 'https://pan.quark.cn/s/a455643c9aed';
      appLink.target = '_blank';
      appLink.rel = 'noopener';
      appLink.textContent = '安卓版 App（夸克网盘）';
      note.appendChild(txt);
      note.appendChild(appLink);
      list.appendChild(note);
    }
    files.forEach(function (f) {
      const row = document.createElement('div');
      row.className = 'result-item';
      const name = document.createElement('span');
      name.className = 'result-name';
      name.textContent = f.name + '（' + formatSize(f.data ? f.data.length : 0) + '）';
      const save = document.createElement('a');
      save.className = 'btn ghost';
      save.textContent = /\.zip$/i.test(f.name) ? '下载ZIP' : '下载';
      let link = null;
      try { if (saver && saver.prepareDownload) link = saver.prepareDownload(f); }
      catch (e) { pushLog('DOWNLOAD 准备失败：' + (e.message || e)); }
      if (link) {
        save.href = link.url;
        save.download = link.name;
        save.rel = 'noopener';
      } else save.setAttribute('aria-disabled', 'true');
      save.addEventListener('click', function (e) {
        if (!link) { e.preventDefault(); toast('下载链接未能生成，请试「分享保存」或分批转换', 7000); return; }
        // Let the anchor's default action run on this real tap.
        toast('已请求下载：' + f.name, 3000);
      });
      row.appendChild(name);
      row.appendChild(save);
      list.appendChild(row);
    });
  }

  /* ---------------- built-in sample brushes ---------------- */
  /* 运行时生成的示例笔刷（原先给小红书小工具容器用；容器版已停止支持，
     这里保留能力，供页面按钮或调试脚本调用 window.BCDemo.loadSample()）。 */
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
      syncSelectionUI();
      toast(anyOff ? ('已全选 ' + all.length + ' 支笔刷') : '已取消全选');
    };
  }

  /* ---------------- 笔刷预览搜索 / 特征筛选 / 反选 ---------------- */
  (function initPreviewToolbar() {
    const searchEl = $('#brushSearch');
    const invBtn = $('#btnInvertSel');
    const pills = Array.prototype.slice.call(document.querySelectorAll('.pt-pill[data-filter]'));
    let searchTimer = null;
    if (searchEl) {
      searchEl.addEventListener('input', function () {
        const val = searchEl.value || '';
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          if (state.searchQuery === val) return;
          state.searchQuery = val;
          render();
        }, 120);
      });
    }
    pills.forEach(function (pill) {
      pill.addEventListener('click', function () {
        if (isBusy()) return;
        const fk = pill.getAttribute('data-filter') || 'all';
        if (state.filterKind === fk) return;
        state.filterKind = fk;
        pills.forEach(function (p) { p.classList.toggle('active', p === pill); });
        render();
      });
    });
    if (invBtn) {
      invBtn.addEventListener('click', function () {
        if (isBusy()) return;
        const filtering = (state.filterKind && state.filterKind !== 'all') || String(state.searchQuery || '').trim().length > 0;
        const list = [];
        state.files.forEach(function (rec) {
          (rec.brushes || []).forEach(function (b) {
            if (!filtering || matchesBrushFilter(b)) list.push(b);
          });
        });
        if (!list.length) { toast('当前没有可反选的笔刷'); return; }
        list.forEach(function (b) { b.enabled = b.enabled === false; });
        syncSelectionUI();
        const onCount = list.filter(function (b) { return b.enabled !== false; }).length;
        toast('已反选（当前选中 ' + onCount + ' / ' + list.length + ' 支）');
      });
    }
  })();

  /* ---------------- 首次打开公告弹窗 ---------------- */
const APP_VERSION = '2.8.89';
/* 检查更新总开关：2026-11-09 用户要求「暂时去掉」。代码全保留（版本比较、网盘入口、三端 openUrl），
   改回 true 即可整体恢复；放在文件顶部是为了避免 TDZ（加载期引用后声明的 const 会直接抛错）。 */
const UPDATE_ENABLED = false;
  let lastSavedFiles = null;
  let preparedShare = null;
  let preparedShareSource = null;
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
    // notice.js 已在页面加载早期处理过弹窗与页脚入口，避免重复
    if (window.__brushNotice) return;
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
  dz.addEventListener('click', () => { if (!isBusy()) fileInput.click(); });
  fileInput.addEventListener('change', e => {
    if (isBusy()) { fileInput.value = ''; return; }
    addFiles(e.target.files);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach(ev => {
    dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); if (!isBusy()) dz.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(ev => {
    dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('over'); });
  });
  /* #263 拖入文件夹以前完全没反应：用 webkitGetAsEntry 递归展开目录里的文件 */
  async function collectDroppedFiles(dt) {
    if (!dt) return [];
    const plain = Array.from(dt.files || []);
    const items = dt.items ? Array.from(dt.items) : [];
    const roots = [];
    for (const it of items) {
      if (it.kind !== 'file' || typeof it.webkitGetAsEntry !== 'function') continue;
      const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (entry) roots.push(entry);
    }
    if (!roots.length) return plain;
    const out = [];
    async function walk(entry) {
      if (!entry) return;
      if (entry.isFile) {
        const f = await new Promise(function (res) { try { entry.file(res, function () { res(null); }); } catch (e) { res(null); } });
        if (f) {
          /* entry.fullPath 形如 /子目录/文件.bru：记下相对目录，转出时还原结构 */
          const full = String(entry.fullPath || '');
          const cut = full.lastIndexOf('/');
          out.push({ file: f, relDir: cut > 0 ? full.slice(1, cut) : '' });
        }
        return;
      }
      if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise(function (res) { try { reader.readEntries(res, function () { res([]); }); } catch (e) { res([]); } });
          if (!batch || !batch.length) break;
          for (const e of batch) await walk(e);
        }
      }
    }
    for (const r of roots) await walk(r);
    return out.length ? out : plain;
  }
  /* 「选择文件夹」：webkitdirectory 拿到的 File 带 webkitRelativePath，addFiles 会据此还原目录 */
  (function initFolderPick() {
    const btn = document.getElementById('btnPickFolder');
    const inp = document.getElementById('folderInput');
    if (btn && inp) btn.addEventListener('click', function () { inp.click(); });
    if (inp) inp.addEventListener('change', function () {
      if (!inp.files || !inp.files.length) return;
      addFiles(inp.files);
      inp.value = '';           // 允许连续选同一个文件夹
    });
  })();

  dz.addEventListener('drop', async e => {
    if (isBusy()) { toast('正在转换，完成后再添加文件'); return; }
    const files = await collectDroppedFiles(e.dataTransfer);
    if (!files.length) { toast('没读到文件：文件夹里的笔刷请打包成 ZIP 再拖入'); return; }
    addFiles(files);
  });
  // 本地日志（不联网）：记录错误/警告，便于反馈
  window.__brushLogs = window.__brushLogs || [];
  function pushLog(line) { window.__brushLogs.push(new Date().toISOString() + ' ' + line); }
  window.addEventListener('error', function (e) { pushLog('ERROR ' + (e.message || e.type)); });
  window.addEventListener('unhandledrejection', function (e) { pushLog('REJECT ' + (e.reason && e.reason.message ? e.reason.message : e.reason)); });
  const btnLog = $('#btnLog');
  if (btnLog) btnLog.addEventListener('click', async function () {
    if (isBusy()) return;
    const NL = String.fromCharCode(10);
    const head = '笔刷转换器 ' + ($('#ver') ? $('#ver').textContent : '') + NL + 'UA: ' + navigator.userAgent + NL + '时间: ' + new Date().toISOString() + NL;
    const body = (window.__brushLogs || []).join(NL) || '(无日志)';
    const data = BC.util.utf8Encode(head + body);
    const saver = window.BCSaver;
    if (saver && saver.save) {
      try { await saveOutputs([{ name: '运行日志.txt', data: data }], {}); }
      catch (e) { toast('保存日志失败：' + e.message); }
    }
    else toast('当前环境不支持保存日志');
  });
  btnConvert.addEventListener('click', convertAll);
  // 参数对比预览（转换前也能看）
  (function initCompare() {
    const btn = $('#btnCompare');
    const modal = $('#compareModal');
    const frame = $('#compareFrame');
    const close = $('#compareClose');
    if (!btn || !modal) return;
    btn.addEventListener('click', function () {
      const sel = $('#optTarget');
      const target = sel ? sel.value : 'bru';
      const brushes = [];
      for (const rec of state.files) {
        for (const b of (rec.brushes || [])) if (b && b.enabled !== false) brushes.push(b);
        if (brushes.length >= 20) break;
      }
      if (!brushes.length) { toast('先添加笔刷文件'); return; }
      try {
        const html = BC.convert.buildCompareHtml(brushes.slice(0, 20), target, { options: getOpts() });
        frame.srcdoc = html;
        modal.style.display = 'flex';
        try { (close || modal).focus(); } catch (e) { /* ignore */ }
      } catch (e) { toast('生成对比失败：' + e.message); }
    });
    if (close) close.addEventListener('click', closeCompare);
    modal.addEventListener('click', function (ev) { if (ev.target === modal) closeCompare(); });
    // #265 以前只能点按钮/背板关，ESC 无效，也没有焦点圈禁
    function closeCompare() {
      modal.style.display = 'none';
      try { btn.focus(); } catch (e) { /* ignore */ }
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || modal.style.display !== 'flex') return;
      ev.preventDefault();
      closeCompare();
    });
    modal.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Tab') return;
      const focusables = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    });
  })();
  var btnCancel = $('#btnCancel');
  if (btnCancel) btnCancel.addEventListener('click', function () { state.cancelRequested = true; btnCancel.disabled = true; });
  document.addEventListener('change', function (ev) {
    const t = ev.target;
    if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT')) {
      updateConvertButton();
      if (typeof updatePrecheck === 'function') updatePrecheck();
    }
  });
  /* 必须等脚本全部求值完再跑：checkForUpdate → updateSources() 会读 SITE_BASE，
     而 const SITE_BASE 声明在本文件更靠后。在加载期直接调用会踩 TDZ（ReferenceError 被 catch 吞掉，
     表现成「检查更新永远不会自动触发」）。挂到 load 事件上就绕开了。 */
  if (UPDATE_ENABLED) window.addEventListener('load', function () {
    (async function checkVersion() {
      // 安卓 App 跑在 file:///android_asset 下，fetch 本地文件会报 “URL scheme file is not supported”，直接跳过
      if (window.BrushNative) return;
      try {
        await checkForUpdate({ silent: true });
      } catch (e) { /* 离线/本地文件忽略 */ }
    })();
  });
  /* ---------- 目标 = SAI2 时，列出本机 SAI2 已装的散布笔刷 ---------- */
  const SAI2_LIST = { loaded: false, dir: '', items: [], error: null };
  function sai2ListEls() {
    return {
      panel: document.getElementById('sai2ListPanel'),
      count: document.getElementById('sai2ListCount'),
      body: document.getElementById('sai2ListBody'),
      hint: document.getElementById('sai2ListHint'),
      search: document.getElementById('sai2ListSearch'),
      refresh: document.getElementById('btnSai2ListRefresh')
    };
  }
  function sai2OutputNames() {
    /* 本次将要写进 SAI2 的名字（含去重后的 _2），用来标「重名」 */
    const names = new Set();
    (state.files || []).forEach(function (rec) {
      (rec.brushes || []).forEach(function (b) {
        if (!b || b.enabled === false) return;   // 取消勾选的笔刷不会输出，不做重名提示
        names.add(String(b.sai2ShapeName || b.name || '').trim().toLowerCase());
      });
    });
    return names;
  }
  function renderSai2List() {
    const el = sai2ListEls();
    if (!el.body) return;
    const q = (el.search && el.search.value || '').trim().toLowerCase();
    const dup = sai2OutputNames();
    const items = SAI2_LIST.items.filter(function (it) {
      return !q || String(it.name).toLowerCase().indexOf(q) >= 0;
    });
    el.body.innerHTML = '';
    items.slice(0, 300).forEach(function (it) {
      const row = document.createElement('div');
      row.className = 'sai2-row';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = it.name;
      const sz = document.createElement('span'); sz.className = 'sz';
      sz.textContent = it.bytes ? (Math.round(it.bytes / 1024) + 'KB') : '';
      row.appendChild(nm); row.appendChild(sz);
      if (dup.has(String(it.name).toLowerCase())) {
        const d = document.createElement('span'); d.className = 'dup'; d.textContent = '重名 → 会存为 _2';
        row.appendChild(d);
      }
      el.body.appendChild(row);
    });
    if (el.count) el.count.textContent = SAI2_LIST.error ? '' : ('（' + SAI2_LIST.items.length + ' 支）');
    if (el.hint) {
      el.hint.textContent = SAI2_LIST.error
        ? ('读取失败：' + SAI2_LIST.error)
        : (SAI2_LIST.dir ? ('目录：' + SAI2_LIST.dir) : '目标格式选 SAI2 时会自动读取这个列表');
    }
  }
  async function loadSai2Brushes(force) {
    const el = sai2ListEls();
    const target = $('#optTarget') ? $('#optTarget').value : '';
    if (!el.panel) return;
    if (target !== 'sai2') { el.panel.hidden = true; return; }
    if (!(window.BrushDesktop && typeof window.BrushDesktop.sai2List === 'function')) {
      el.panel.hidden = true;   // 网页/安卓没有本地 SAI2 目录
      return;
    }
    el.panel.hidden = false;
    if (SAI2_LIST.loaded && !force) { renderSai2List(); return; }
    if (el.hint) el.hint.textContent = '正在读取本机 SAI2 笔刷…';
    try {
      const r = await window.BrushDesktop.sai2List();
      if (r && r.ok) {
        SAI2_LIST.items = r.brushes || [];
        SAI2_LIST.dir = r.dir || '';
        SAI2_LIST.error = null;
      } else {
        SAI2_LIST.items = []; SAI2_LIST.dir = '';
        SAI2_LIST.error = (r && r.error) || '未知错误';
      }
    } catch (e) {
      SAI2_LIST.items = []; SAI2_LIST.error = e.message || String(e);
    }
    SAI2_LIST.loaded = true;
    renderSai2List();
  }
  (function initSai2ListUi() {
    const el = sai2ListEls();
    if (el.refresh) el.refresh.addEventListener('click', function () { loadSai2Brushes(true); });
    if (el.search) el.search.addEventListener('input', renderSai2List);
    const sel = $('#optTarget');
    if (sel) sel.addEventListener('change', function () { SAI2_LIST.loaded = false; loadSai2Brushes(); });
    loadSai2Brushes();          // 默认目标就是 SAI2 时立刻拉一次
  })();

  /* ---------- 检查更新（网页 / 桌面 EXE / 安卓共用一套） ---------- */
  const UPDATE = { checking: false, latest: null, error: null };
  function updateEls() {
    return {
      btn: document.getElementById('btnCheckUpdate'),
      go: document.getElementById('btnUpdateGo'),
      text: document.getElementById('updateText'),
      current: document.getElementById('updateCurrent')
    };
  }
  function updateNative() { return !!(window.BrushNative || window.BrushDesktop); }
  function updateSources() {
    const lib = BC.update;
    return lib.sources({
      siteBase: SITE_BASE, rawBase: SITE_RAW_BASE,
      mirrors: SITE_MIRRORS, cdn: SITE_CDN, native: updateNative()
    });
  }
  async function fetchLatestVersion() {
    const urls = updateSources();
    let lastErr = null;
    for (const u of urls) {
      try {
        const res = await fetch(BC.update.bust(u), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const info = BC.update.normalize(await res.json());
        if (!info) throw new Error('内容不是版本信息');
        return info;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('没有可用的更新源');
  }
  /* 安卓：直接下小包版 APK（发布脚本会把它传到站点的 apk/brushconv-latest.apk）；
     桌面/网页：打开下载页（网页本身就是新版本，点「刷新页面」即可）。 */
  /* 注意：SITE_BASE 的 const 声明在本文件更靠后的位置（TDZ）。这里必须**惰性求值**，
     不能在顶层算好——v2.8.45 写成 `const APK_LATEST = SITE_BASE + ...` 直接在加载时抛
     ReferenceError，把后面所有初始化（图库下载按钮、检查更新、SAI2 列表）全带死了。 */
  function apkLatestUrl() { return SITE_BASE + 'apk/brushconv-latest.apk'; }
  function updateTarget() {
    if (window.BrushNative) return { native: true, url: apkLatestUrl() };
    if (window.BrushDesktop) return { native: true, url: SITE_BASE };
    return { native: false, url: SITE_BASE };
  }
  function openDownloadPage() {
    const t = updateTarget();
    try {
      if (window.BrushNative && typeof window.BrushNative.openUrl === 'function') { window.BrushNative.openUrl(t.url); return; }
      if (window.BrushDesktop && typeof window.BrushDesktop.openUrl === 'function') { window.BrushDesktop.openUrl(t.url); return; }
    } catch (e) { /* 落到下面的 window.open */ }
    try { window.open(t.url, '_blank'); } catch (e) { /* 忽略 */ }
  }
  function updateReload() { try { location.reload(); } catch (e) { /* 忽略 */ } }
  /* 网盘兜底：GitHub Pages / 夸克偶尔被墙或限速，用户给的百度+夸克链接直接摆在「发现新版本」面板里 */
  const PAN_URLS = {
    baidu: 'https://pan.baidu.com/s/1E2cK7Dj3xeIZzEDhV7RidQ?pwd=i782',
    baiduCode: 'i782',
    quark: 'https://pan.quark.cn/s/a455643c9aed',
    quarkCode: '/~eaf43bwbgU~:/'
  };
  function openExternal(url) {
    try {
      if (window.BrushDesktop && typeof window.BrushDesktop.openUrl === 'function') { window.BrushDesktop.openUrl(url); return; }
      if (window.BrushNative && typeof window.BrushNative.openUrl === 'function') { window.BrushNative.openUrl(url); return; }
    } catch (e) { /* 落到 window.open */ }
    try { window.open(url, '_blank'); } catch (e) { /* 忽略 */ }
  }
  async function copyQuarkCode() {
    const code = PAN_URLS.quarkCode;
    const hint = document.getElementById('ulHint');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(code);
        if (hint) hint.textContent = '已复制夸克口令：' + code + '（打开夸克 App 会自动识别）';
        toast('夸克口令已复制', 3000);
        return;
      }
      throw new Error('no clipboard');
    } catch (e) {
      if (hint) hint.textContent = '口令：' + code + '（长按复制）';
      toast('口令：' + code, 6000);
    }
  }
  function renderUpdateLinks(newer, info) {
    const box = document.getElementById('updateLinks');
    if (!box) return;
    box.hidden = !newer;
    if (!newer) return;
    const ver = document.getElementById('ulVer');
    if (ver) ver.textContent = 'v' + (info && info.version ? info.version : '');
    const hint = document.getElementById('ulHint');
    if (hint) hint.textContent = '百度网盘提取码：' + PAN_URLS.baiduCode + '；夸克可直接点开，也可复制口令用 App 打开';
  }
  (function initUpdateLinks() {
    const bind = function (id, fn) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };
    bind('ulSite', function () { openDownloadPage(); });
    bind('ulBaidu', function () { openExternal(PAN_URLS.baidu); });
    bind('ulQuark', function () { openExternal(PAN_URLS.quark); });
    bind('ulQuarkCode', function () { copyQuarkCode(); });
  })();
  function renderUpdate(state, info, err) {
    const el = updateEls();
    if (el.current) el.current.textContent = APP_VERSION;
    if (el.btn) {
      el.btn.disabled = state === 'checking';
      /* 窄屏只显示图标（↻），宽屏显示文字：文案写到 .lbl 里，别覆盖掉图标节点 */
      const lbl = el.btn.querySelector('.lbl');
      const txt = state === 'checking' ? '检查中…' : '检查更新';
      if (lbl) lbl.textContent = txt; else el.btn.textContent = txt;
      el.btn.title = txt;
      el.btn.setAttribute('aria-label', txt);
    }
    const newer = !!(info && BC.update.isNewer(info.version, APP_VERSION));
    if (el.go) {
      el.go.hidden = !newer;
      el.go.textContent = window.BrushNative ? '下载新版 APK' : (window.BrushDesktop ? '打开下载页' : '刷新页面');
    }
    if (!el.text) return;
    if (state === 'checking') { el.text.textContent = '正在检查更新…'; return; }
    if (state === 'error') {
      el.text.textContent = '检查失败：' + ((err && (err.message || err)) || '网络不可用') + '（可稍后再试）';
      return;
    }
    const day = info && info.date ? '（' + String(info.date).slice(0, 10) + '）' : '';
    if (el.text.classList) el.text.classList.toggle('is-new', newer);
    renderUpdateLinks(newer, info);
    if (newer) {
      el.text.textContent = '发现新版本 v' + info.version + day + '，当前 v' + APP_VERSION +
        (updateNative() ? '。点「打开下载页」取新包' : '。点「刷新页面」即可更新');
    } else {
      el.text.textContent = '已是最新版本 v' + APP_VERSION + (info && info.date ? '（线上 ' + String(info.date).slice(0, 10) + '）' : '');
    }
  }
  async function checkForUpdate(opts) {
    opts = opts || {};
    if (!UPDATE_ENABLED) return null;          // 关闭时任何调用都静默退出
    if (UPDATE.checking) return UPDATE.latest;
    UPDATE.checking = true;
    if (!opts.silent) renderUpdate('checking');
    try {
      const info = await fetchLatestVersion();
      UPDATE.latest = info; UPDATE.error = null;
      const newer = BC.update.isNewer(info.version, APP_VERSION);
      /* 静默检查只在「有新版」时写底栏，避免每次启动都多一行字 */
      if (!opts.silent || newer) renderUpdate('done', info);
      if (newer) {
        toast('发现新版本 v' + info.version + '（当前 v' + APP_VERSION + '）' +
          (updateNative() ? '，可在设置里点「检查更新」打开下载页' : '，刷新页面即可更新'), 8000);
      } else if (!opts.silent) {
        toast('已是最新版本 v' + APP_VERSION, 2600);
      }
      return info;
    } catch (e) {
      UPDATE.error = e;
      if (!opts.silent) renderUpdate('error', null, e);
      if (!opts.silent) toast('检查更新失败：' + (e.message || e), 5000);
      return null;
    } finally { UPDATE.checking = false; }
  }
  (function initUpdateUi() {
    if (!UPDATE_ENABLED) {
      /* 暂时关闭：按钮/状态/面板一律隐藏，也不绑任何点击事件（页面底部只剩声明区） */
      ['btnCheckUpdate', 'btnUpdateGo', 'updateText', 'updateLinks'].forEach(function (id) {
        const node = document.getElementById(id);
        if (node) { node.hidden = true; node.style.display = 'none'; }
      });
      return;
    }
    const el = updateEls();
    if (el.current) el.current.textContent = APP_VERSION;
    /* 底栏自带 vX，状态行初始留空（空字符串有 :empty 样式，不占位） */
    if (el.text) el.text.textContent = '';
    if (el.btn) el.btn.addEventListener('click', function () { checkForUpdate({ silent: false }); });
    if (el.go) el.go.addEventListener('click', function () { if (updateNative()) openDownloadPage(); else updateReload(); });
  })();

  const btnShare = $('#btnShare');
  const btnShareResult = $('#btnShareResult');
  [btnShare, btnShareResult].filter(Boolean).forEach(function (button) {
    if (!(navigator.canShare && navigator.share)) {
      button.style.display = 'none';
      /* 安卓 WebView 没有 Web Share：本行只剩一个按钮时让它占满两列，避免半行悬空 */
      var row = button.closest ? button.closest('.nav-row') : null;
      if (row) row.classList.add('is-single');
      return;
    }
    button.hidden = false;
    button.addEventListener('click', async function () {
      if (!lastSavedFiles || !lastSavedFiles.length) { toast('还没有可分享的转换结果'); return; }
      try {
        if (!preparedShare) { toast('这个浏览器不支持分享，请点下方结果文件的「下载」', 3000); return; }
        await navigator.share({ files: preparedShare.files, title: '笔刷转换结果' });
        toast('已交给系统分享；请在接收应用或「文件」中确认是否保存', 7000);
      } catch (e) {
        if (e && e.name === 'AbortError') toast('已取消分享，转换结果仍在下方');
        else { pushLog('SHARE ' + (e && e.message || e)); toast('分享失败，请点「下载ZIP」', 3000); }
      }
    });
  });
  if ($('#optTarget')) $('#optTarget').addEventListener('change', function () { render(); });
  const btnDemo = $('#btnDemo');
  if (btnDemo) btnDemo.addEventListener('click', function (e) { e.stopPropagation(); window.BCDemo.loadSample(); });
  btnClear.addEventListener('click', () => {
    // #262 导入中清空：token+1 让正在跑的循环立即停手，清空后不会再冒卡片
    state.importToken++;
    state.files = [];
    render();
    updateConvertButton();
  });

  /* #263 拖到虚线框外也不该静默：提示放到框里 */
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    if (dz.contains(e.target)) return;
    if (isBusy()) { toast('正在转换，完成后再添加文件'); return; }
    toast('把笔刷文件拖到上面的虚线框里');
  });

  /* ---------------- 内置笔尖图库（Procreate 内置 shape 资源） ----------------
     Procreate 内置笔刷的 Shape 图不随 .brushset 导出，包里只有资源名（bundledShapePath）。
     用户可以从自己的 Procreate 安装/备份里整理出这些图，打包成 ZIP 或直接选文件夹，
     导入时按文件名补回真图，避免退化成合成圆头。 */
  /* 图库已导入 → 下载按钮灰掉写「图库已安装」，别再让用户怀疑没生效又下一遍 32MB。
     换包/删包统一走下面的「删除已下载的图库」；已经装了精简档时仍可升到高清档。 */
  function syncShapeLibDownloadButtons() {
    const lite = document.getElementById('btnShapeLibDownload');
    const full = document.getElementById('btnShapeLibDownloadFull');
    const installed = !!(state.shapeLib && state.shapeLib.size);
    if (lite && lite.dataset && lite.dataset.label) {
      if (installed) {
        lite.disabled = true;
        lite.textContent = '图库已安装';
        lite.title = '图库已经导入（' + state.shapeLib.size + ' 张），不用再下载；要换或删见下面的「删除已下载的图库」';
      } else {
        lite.disabled = false;
        lite.textContent = lite.dataset.label;
        lite.title = '';
      }
    }
    if (full && full.dataset && full.dataset.label) {
      if (installed) {
        // 不管装的是哪一档，216MB 那份都先别让点：重复下 216MB 既费流量又容易塞满手机
        full.disabled = true;
        full.textContent = state.shapeLibPackKey === 'full' ? '高清图库已安装' : '高清图库包（先删除当前图库）';
        full.title = state.shapeLibPackKey === 'full'
          ? '已经在用原图高清图库，无需再下载'
          : '已经装了图库（' + state.shapeLib.size + ' 张）。想换 216MB 高清版，先点下面「删除已下载的图库」，再点这里下载';
      } else {
        full.disabled = false;
        full.textContent = full.dataset.label;
        full.title = '高清图库约 216MB，手机空间紧张时用上面的 32MB 版';
      }
    }
  }
  /* 辅助文件（安装说明、报告、纹理 .pat、参数文本…）：它们不是笔刷本体，导出决策要看它们脸色 */
  function isAuxOutFile(name) {
    return /^(安装\/|转换报告\.txt$|参数对比\.html$|纹理图案_|优动漫导入说明\.txt$|优动漫SUT导入说明\.txt$|优动漫MTD导入说明\.txt$|.*_优动漫导入说明\.txt$|.*_参数\.txt$)/.test(String(name || ''));
  }
  /* 输出全是 .brushset 时直接给文件，不套 ZIP。手机浏览器例外（多文件逐个下载体验差），
     体积过大时也例外（回到分卷 ZIP）。 */
  function exportWithoutZip(outFiles, onlyAux, mobileWeb, totalOut) {
    return !!outFiles && outFiles.length > 0 && outFiles.length < 4;
  }
  function updateShapeLibText() {
    syncShapeLibDownloadButtons();
    const el = $('#shapeLibText');
    if (!el) return;
    if (state.shapeLib && state.shapeLib.size) {
      el.textContent = '图库已加载：' + state.shapeLib.size + ' 张' +
        (state.shapeLibBytes ? '（' + Math.round(state.shapeLibBytes / 1048576) + 'MB）' : '');
    } else {
      // 安卓壳 / 网页版都能直接下（安卓壳走站点绝对地址），把入口写在提示里，别让用户找按钮
      const canDownload = window.BrushNative || window.BrushDesktop || /^https?:/.test(location.protocol);
      if (state.shapeLibBuiltIn === false && state.shapeLibError) {
        el.textContent = canDownload
          ? '还没有图库：下面下载一份，或用「选择图库文件夹」导入'
          : '图库包没读到（' + state.shapeLibError + '）：可以点「选择图库文件夹」手动指定';

      } else {
        el.textContent = canDownload
          ? '还没有图库：下面下载一份，或用「选择图库文件夹」导入'
          : '还没有图库：把图库 zip 放到程序旁边，或点「选择图库 ZIP / 图片」';
      }
    }
  }
  /* ===== 内置笔尖图库包（单独分发，不塞进安装包）=====
     资源包来自 assets/shape-lib.zip（精简 512）或另做的「原图」包：292 张 Procreate IPA 内置 Shape。
     桌面版启动时去程序目录找这个 zip（主进程读文件 → IPC 传字节），找不到就等用户手动选。
     内存策略见 loadShapeLibrary：只留原始字节，core 用到才解码。 */
  let bundledLoading = null;
  /* 桌面版用户主动点过「删除图库」：记住这个选择，别下次启动又背地里下 32MB */
  function shapeLibUserCleared() {
    try { return localStorage.getItem('shapeLibUserCleared') === '1'; } catch (e) { return false; }
  }
  function setShapeLibUserCleared(v) {
    try {
      if (v) localStorage.setItem('shapeLibUserCleared', '1');
      else localStorage.removeItem('shapeLibUserCleared');
    } catch (e) { /* 没有 localStorage：按「没删过」处理 */ }
  }
  async function shapeLibFromZipBytes(bytes, onProgress) {
    const map = new Map();
    let index = null;
    const entries = BC.zip.read(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const base = String(e.name || '').split(/[\\/]/).pop().toLowerCase();
      if (base === 'index.json') {
        try { index = JSON.parse(BC.util.utf8Decode(e.data())); } catch (err) { index = null; }
      } else if (/\.(png|jpe?g)$/i.test(base)) {
        map.set(base, e.data());
      }
      // 一口气解完 292 张会把界面钉住：每 8 张让出一帧（安卓低端机尤其明显）
      if ((i & 7) === 7) {
        if (onProgress) onProgress(i + 1, entries.length);
        await sleep(0);
      }
    }
    if (index && Number.isFinite(index.count) && index.count > map.size) {
      throw new Error('图库资源数量不足：声明 ' + index.count + ' 张，实际 ' + map.size + ' 张');
    }
    if (onProgress) onProgress(entries.length, entries.length);
    return { map: map, index: index };
  }
  async function bundledShapeLibBytes(onProgress) {
    // 安卓 App：图库包在 APK assets 里，或已下载到 App 私有目录；WebView 读不了 file://，走原生分块
    const native = window.BrushNative;
    if (native && typeof native.shapeLibLength === 'function' && typeof native.shapeLibChunk === 'function') {
      const total = Number(native.shapeLibLength());
      if (total <= 0) {
        // 小包版（不带图库）不能默默去拉 32MB：直接告知，让用户自己选下载或手动选图库
        throw new Error('这个安装包没带内置图库（可在下面下载，或手动选图库文件夹）');
      }
      let source = 'asset';
      try { if (typeof native.shapeLibSource === 'function') source = String(native.shapeLibSource()); } catch (e) { /* ignore */ }
      if (total > 0) {
        const bytes = new Uint8Array(total);
        const CHUNK = 1024 * 1024; // 1MB 一块：atob/拷贝的单块耗时压到十几毫秒，界面才跟得上
        for (let off = 0; off < total; off += CHUNK) {
          const b64 = native.shapeLibChunk(off, Math.min(CHUNK, total - off));
          if (!b64) throw new Error('内置图库分块读取失败（offset ' + off + '）');
          const bin = atob(b64);
          const expected = Math.min(CHUNK, total - off);
          if (bin.length !== expected) throw new Error('内置图库分块长度不完整（offset ' + off + '）');
          const n = bin.length;
          for (let i = 0; i < n; i++) bytes[off + i] = bin.charCodeAt(i);
          if (onProgress) onProgress(off + n);
          // 33MB 一口气读完会把主线程堵死（安卓导入图库卡顿的主因之一）：每块让出一帧
          await sleep(0);
        }
        return { bytes: bytes, name: source === 'file' ? 'App 内已下载的图库包' : '应用内置图库包', path: source === 'file' ? 'files/shape-lib.zip' : 'assets/app/shape-lib.zip' };
      }
    }
    const desk = window.BrushDesktop;
    if (desk && typeof desk.readShapeLib === 'function') {
      try {
        const r = await desk.readShapeLib();
        if (r && r.ok) return { bytes: new Uint8Array(r.bytes), name: r.name || '', path: r.path || '' };
      } catch (e) { /* 程序目录没有图库包：下面走联网下载 */ }
      // 用户点过「删除已下载的图库」：下次启动别再偷偷下 32MB，等他主动点下载/导入
      if (shapeLibUserCleared()) {
        throw new Error('图库已删除：要用时点「下载图库包（32MB）」重新安装，或手动选图库文件');
      }
    }
    if (typeof fetch === 'function') {
      // 网页版：同源 shape-lib.zip；安卓/桌面（file:// 壳）：本地取不到时改从站点/镜像拉
      const urls = shapeLibSourceUrls('shape-lib.zip');
      if (onProgress) onProgress(0);
      const blob = await raceDownloadBlob(urls, onProgress);
      return { bytes: new Uint8Array(await blob.arrayBuffer()), name: 'shape-lib.zip', path: '' };
    }
    throw new Error('当前环境读不到内置图库');
  }
  async function loadBundledShapeLib(opts) {
    if (bundledLoading) return bundledLoading;
    bundledLoading = (async function () {
      const progressButton = (opts && opts.progressButton) || $('#btnShapeLibDownload');
      let downloadTick = null, loaded = false;
      try {
        if (opts && opts.onStart) opts.onStart();
        const got = await bundledShapeLibBytes(function (n) {
          if (!downloadTick && shapeLibDlBusy && progressButton) {
            // 原生下载已结束、正在读包：照样给个会动的数，别让人以为卡死
            progressButton.textContent = '正在读取图库 ' + (n / 1048576).toFixed(1) + 'MB…';
          }
          if (!downloadTick && !shapeLibDlBusy && progressButton) {
            shapeLibDlBusy = true;
            progressButton.disabled = true;
            /* 这里读的是「本地已下好的包」（可能是 216MB 原图档），不是网络下载：
               总量优先用已记录的真实字节数，未知就传 0 交给 paint 兜底。 */
            const knownBytes = Number(state.shapeLibBytes) > 0 ? Number(state.shapeLibBytes) : 0;
            downloadTick = shapeDlProgressStart(progressButton, knownBytes, '正在读取图库');
          }
          if (downloadTick) downloadTick.set(n);
        });
        if (downloadTick) {
          if (shapeDlTick === downloadTick) shapeDlProgressStop();
          progressButton.textContent = '正在导入图库…';
        }
        // 解包里 292 张图是安卓导入卡顿的大头：分片让出主线程，顺便把张数报在按钮上
        const parsed = await shapeLibFromZipBytes(got.bytes, function (done, all) {
          if (progressButton && all) progressButton.textContent = '正在导入图库 ' + done + '/' + all + '…';
        });
        const map = parsed.map;
        if (!map.size) throw new Error('内置图库为空');
        const idx = parsed.index || {};
        const variant = idx.variant === 'original' ? '原始分辨率' : (idx.maxEdge ? idx.maxEdge + 'px 精简' : '');
        state.shapeLib = map;
        state.shapeLibBuiltIn = true;
        state.shapeLibLabel = [got.name || '图库包', variant].filter(Boolean).join(' · ');
        state.shapeLibBytes = got.bytes.length;
        state.shapeLibPackKey = got.bytes.length > 120 * 1048576 ? 'full' : 'lite';
        updateShapeLibText();
        const fixed = await reparseWithShapeLib();
        pushLog('图库包已加载 ' + map.size + ' 张 / ' + Math.round(got.bytes.length / 1048576) + 'MB / ' + state.shapeLibLabel);
        if (fixed) toast('图库已生效：补回 ' + fixed + ' 处笔尖/纹理原图', 8000);
        if (got.bytes.length > 120 * 1048576) {
          toast('已加载原图库包（' + Math.round(got.bytes.length / 1048576) + 'MB）。内存紧张时（手机/低配）请改用「精简512」包', 12000);
        }
        // 安卓 App 已经内置精简图库：把「下载精简512」按钮收起来，避免用户再去联网拉 32MB（手机上会很慢）
        if (window.BrushNative) {
          const liteBtn = document.getElementById('btnShapeLibDownload');
          if (liteBtn && state.shapeLibBuiltIn) liteBtn.hidden = true;
        }
        loaded = true;
        return { ok: true, count: map.size, fixed: fixed, label: state.shapeLibLabel };
      } catch (e) {
        state.shapeLibError = e && e.message ? e.message : String(e);
        state.shapeLibBuiltIn = false;
        updateShapeLibText();
        pushLog('图库包加载失败：' + state.shapeLibError);
        return { ok: false, error: state.shapeLibError };
      } finally {
        if (downloadTick) {
          if (shapeDlTick === downloadTick) shapeDlProgressStop();
          progressButton.disabled = false;
          progressButton.textContent = loaded ? '图库已加载' : '下载失败，点这里重试';
          shapeLibDlBusy = false;
          syncShapeLibDownloadButtons(); // 已安装：让「图库已安装」灰态盖住临时文案
        }
        bundledLoading = null;
      }
    })();
    return bundledLoading;
  }
  window.__loadBundledShapeLib = loadBundledShapeLib;
  const shapeDecodeLog = [];
  window.__shapeDecodeLog = shapeDecodeLog;
  async function decodeImageToRgba(name, bytes) {
    // 先用自带解码器（快、不依赖 DOM）；解不了（例如 progressive JPEG）再交给浏览器 canvas
    const diag = { name: name, bytes: bytes ? bytes.length : 0 };
    try {
      if (/\.png$/i.test(name)) {
        const im = BC.png.decode(bytes);
        diag.path = 'png'; shapeDecodeLog.push(diag);
        return { w: im.width, h: im.height, rgba: im.rgba };
      }
      if (/\.jpe?g$/i.test(name) && BC.jpeg && BC.jpeg.isJpeg(bytes)) {
        const im = BC.jpeg.decode(bytes);
        diag.path = 'jpeg'; shapeDecodeLog.push(diag);
        return { w: im.width, h: im.height, rgba: im.rgba };
      }
    } catch (e) { diag.builtinError = String(e && e.message ? e.message : e); }
    try {
      if (typeof createImageBitmap === 'function') {
        const bmp = await createImageBitmap(new Blob([bytes]));
        try {
          // 实测坑：个别 progressive JPEG 在这里会返回 0x0（不抛错），当成成功就会把空图存进图库
          if (!bmp || !bmp.width || !bmp.height) throw new Error('createImageBitmap 返回 ' + (bmp ? bmp.width + 'x' + bmp.height : 'null'));
          const cv = document.createElement('canvas');
          cv.width = bmp.width; cv.height = bmp.height;
          const ctx = cv.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          const data = ctx.getImageData(0, 0, bmp.width, bmp.height);
          diag.path = 'canvas'; diag.w = bmp.width; diag.h = bmp.height;
          shapeDecodeLog.push(diag);
          return { w: bmp.width, h: bmp.height, rgba: new Uint8Array(data.data) };
        } finally { if (bmp && bmp.close) bmp.close(); }
      }
      diag.canvasError = 'no createImageBitmap';
    } catch (e) { diag.canvasError = String(e && e.message ? e.message : e); }
    // 再用 <img> + objectURL 兜底（比 createImageBitmap 更老更稳，progressive JPEG 全靠它）
    try {
      if (typeof Image === 'function' && typeof URL !== 'undefined' && URL.createObjectURL) {
        const url = URL.createObjectURL(new Blob([bytes]));
        try {
          const img = new Image();
          await new Promise(function (res, rej) { img.onload = res; img.onerror = function () { rej(new Error('img onerror')); }; img.src = url; });
          const w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) throw new Error('img ' + w + 'x' + h);
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const data = ctx.getImageData(0, 0, w, h);
          diag.path = 'img'; diag.w = w; diag.h = h;
          shapeDecodeLog.push(diag);
          return { w: w, h: h, rgba: new Uint8Array(data.data) };
        } finally { URL.revokeObjectURL(url); }
      }
      diag.imgError = diag.imgError || 'no Image';
    } catch (e) { diag.imgError = String(e && e.message ? e.message : e); }
    diag.path = 'failed'; shapeDecodeLog.push(diag);
    return null;
  }
  /* 只看 JPEG 头里的 SOF 标记判断类型（不整张解码，几微秒）：
     baseline 交给 core 的 jpeg.js；progressive 它解不了，得先用 canvas 解出来再存成 PNG。 */
  function jpegScanKind(bytes) {
    if (!bytes || bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return 'none';
    const n = Math.min(bytes.length, 65536);
    for (let i = 0; i < n - 1; i++) {
      if (bytes[i] !== 0xFF) continue;
      const m = bytes[i + 1];
      if (m === 0xC0 || m === 0xC1) return 'baseline';
      if (m === 0xC2) return 'progressive';
    }
    return 'jpeg';
  }
  /* strictPack（R202-01）：由「下载入口」置 true，要求整包完整可读，任一条目读失败就整包作废，
     绝不能把已读出的半张图库当成新图库提交，更不能让调用方拿原坏 ZIP 覆盖缓存。
     手动选择文件夹/多张独立图片时保持原来的部分成功策略（坏一张只记日志，不牵连其余）。 */
  async function loadShapeLibrary(fileList, libLabel, forceReparse, strictPack) {
    const list = Array.prototype.slice.call(fileList || []);
    if (!list.length) {
      if (strictPack) throw new Error('图库包没有内容');
      return;
    }
    toast('正在读取图库…', 8000);
    const map = new Map();
    let undecoded = 0;
    const undecodedNames = [];
    let converted = 0;
    let inputBytes = 0;
    /* 关键：不要整包解成 RGBA 常驻（292 张原图 = 1GB+ 会直接崩）。
       PNG 与 baseline JPEG 只存原始字节，core 用到时才同步解码；
       只有 progressive JPEG 必须在这解一次，解完烘成灰度 PNG 存起来（同样不常驻 RGBA）。 */
    let hsjScriptBytes = null;
    /* R205-01/02：每个输入文件先写进独立的 out，整包读全了才并进总 map / hsjScriptBytes。
       一个坏 ZIP 不会留下半张图，也不会把随包的笔尖库脚本装上去。 */
    function newOut() { return { map: new Map(), script: null, count: 0 }; }
    async function addOne(name, bytes, out) {
      const base = String(name || '').split(/[\\/]/).pop().toLowerCase();
      if (base === 'hsj-shapes.js' && bytes && bytes.length > 1024) { out.script = bytes; return; }
      if (!/\.(png|jpe?g)$/i.test(base)) return;
      let entry = bytes;
      if (/\.jpe?g$/i.test(base) && jpegScanKind(bytes) === 'progressive') {
        const dec = await decodeImageToRgba(base, bytes);
        if (dec) {
          const gray = new Uint8Array(dec.w * dec.h);
          for (let i = 0; i < gray.length; i++) {
            const o = i * 4;
            const l = Math.max(dec.rgba[o], dec.rgba[o + 1], dec.rgba[o + 2]);
            gray[i] = dec.rgba[o + 3] === 255 ? l : Math.round((l * dec.rgba[o + 3]) / 255);
          }
          entry = BC.png.encodeGray(dec.w, dec.h, gray, 6);
          converted++;
        } else {
          /* 解码失败是设备解码能力问题，不是包被损坏：仍按原策略记日志降级，
             不让一台解不开 progressive JPEG 的设备连整个图库都装不上。
             ZIP/条目数据损坏（CRC 等）由外层 catch 走 strictPack 的整包失败。 */
          undecoded++;
          undecodedNames.push(base);
        }
      }
      out.map.set(base, entry);
    }
    let packError = null;
    let zipFailed = false;
    for (const f of list) {
      const isZip = /\.zip$/i.test(f.name);
      try {
        if (isZip) {
          const raw = await f.arrayBuffer();
          const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
          const entries = BC.zip.read(bytes);
          const out = newOut();
          /* R205-01：目录条目（name 以 / 结尾）没有 data()，7-Zip/资源管理器打的包几乎都带；
             以前无条件 entries[i].data() 一抛 TypeError，整个 ZIP 后面所有资源都读不到，
             下载入口严格模式还会把这种完全合法的包判成坏包。
             R205-01/02：先按名字筛再解压，index.json 之类的非资源条目不牵连整包。 */
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (e.dir) continue;
            const base = String(e.name || '').split(/[\\/]/).pop().toLowerCase();
            if (base === 'index.json') {
              try {
                const idxText = (BC.util && typeof BC.util.utf8Decode === 'function')
                  ? BC.util.utf8Decode(e.data()) : new TextDecoder().decode(e.data());
                const idx = JSON.parse(idxText);
                if (idx && Number.isFinite(idx.count) && idx.count > 0) out.count = idx.count;
              } catch (err) { /* 旧包/自定义包索引不可用：按实际读到的资源数装载 */ }
              continue;
            }
            await addOne(base, e.data(), out);
            // 安卓：整包解压会把界面钉住 → 每 16 张让出一帧并报进度
            if ((i & 15) === 15) {
              setProgress(0.15 + 0.5 * (i / (entries.length || 1)), '正在读取图库 ' + map.size + ' 张…');
              await sleep(0);
            }
          }
          /* R205-03：发布包自带 index.json 声明资源数。少一张都说明这不是完整发布版，
             严格模式必须整包作废——否则「合法但只剩 2 张图」的坏包照样替换 292 张旧图库。 */
          if (strictPack && out.count && out.map.size < out.count) {
            throw new Error('图库资源数量不足：声明 ' + out.count + ' 张，实际 ' + out.map.size + ' 张');
          }
          for (const [k, v] of out.map) map.set(k, v);
          if (out.script) hsjScriptBytes = out.script;
          inputBytes += bytes.byteLength;
          setProgress(null);
        } else {
          const imageBytes = new Uint8Array(await f.arrayBuffer());
          const out = newOut();
          await addOne(f.name, imageBytes, out);
          for (const [k, v] of out.map) map.set(k, v);
          if (out.script) hsjScriptBytes = out.script;
          inputBytes += imageBytes.byteLength;
        }
      } catch (e) {
        pushLog('图库读取失败 ' + f.name + '：' + e.message);
        if (!packError) packError = e;
        /* R205-02：散图保持「坏一张不牵连其余」，ZIP 必须整包不作废才算成功。
           否则半张图会提交成新图库，还会被 takeFiles 当成成功去覆盖持久化缓存。 */
        if (isZip) zipFailed = true;
        if (strictPack) break;
      }
    }
    /* R202-01 + R205-02：必须在提交 state.shapeLib、安装随包脚本、写任何缓存之前判定整包成败。
       以前外层 catch 只写日志，读到 b.png 的 CRC 错误后照样把 a.png 当新图库返回成功。 */
    if (strictPack && packError) {
      throw new Error('图库压缩包不完整（' + ((packError && packError.message) || packError) + '），未替换已有图库');
    }
    if (zipFailed) {
      toast('图库 ZIP 不完整，已忽略这批文件；原有图库保持不变', 8000);
      return false;
    }
    if (hsjScriptBytes) {
      if (typeof installHsjBytes === 'function') {
        try { await installHsjBytes(hsjScriptBytes); } catch (e) { pushLog('画世界笔尖库读取失败：' + e.message); }
      }
      if (!map.size) return !!BC.hsjShapes;
    }
    if (!map.size) { toast('图库里没有 PNG/JPG：请选择包含内置笔尖图的 ZIP 或文件夹', 8000); return false; }
    if (converted) pushLog('图库里有 ' + converted + ' 张 progressive JPEG 已用 canvas 解出并转存为灰度 PNG');
    if (undecoded) pushLog('图库有 ' + undecoded + ' 张解不开：' + undecodedNames.slice(0, 12).join(', '));
    forceReparse = !!forceReparse || !!state.shapeLib;
    state.shapeLib = map;
    state.shapeLibBytes = inputBytes;
    state.shapeLibBuiltIn = false; // 用户自己选的图库优先于内置（通常是原始高分辨率图）
    state.shapeLibLabel = libLabel || '自选图库';
    setShapeLibUserCleared(false); // 又装上了：恢复启动自动加载
    updateShapeLibText();
    refreshShapeLibStoreUI(); // 桌面：手动导入后也要显示「图库已装载」和删除按钮
    const fixed = (await reparseWithShapeLib(forceReparse)) + (typeof backfillHsjShapesInFiles === 'function' ? backfillHsjShapesInFiles() : 0);
    toast('图库已加载 ' + map.size + ' 张' + (fixed ? '；补回 ' + fixed + ' 处笔尖/纹理原图'
      : '；未匹配到新的缺失原图'), 8000);
    return true;
  }

  async function loadShapeLibraryBytes(bytes, label, forceReparse) {
    // Reuse downloaded bytes directly instead of File -> arrayBuffer copies.
    // R202-01：下载入口走严格模式；半包/CRC 错误必须整包失败，旧图库与旧缓存保持不动
    const loaded = await loadShapeLibrary([{ name: 'shape-library.zip', arrayBuffer: async function () { return bytes; } }], label, forceReparse, true);
    if (!loaded) throw new Error('图库读取失败，未替换已有图库');
  }

  /* #282：图库是后加载的，用户不该为此重新导入一遍笔刷——
     把「当时留着原始字节的 Procreate 记录」原地重新解析一次，卡片立刻从合成圆头变成图库补回。 */
  let relibRunning = false;
  let relibAgain = false;
  let relibForce = false;
  async function reparseWithShapeLib(force) {
    if (!state.shapeLib) return 0;
    relibForce = relibForce || !!force;
    if (relibRunning) { relibAgain = true; return relibRunning; }
    relibRunning = (async function () {
      // 先让出一次，确保无目标时也不会在 Promise 赋值前清空运行标记。
      await sleep(0);
      let fixed = 0;
      try {
        do {
          relibAgain = false;
          const library = state.shapeLib;
          const refreshAll = relibForce;
          relibForce = false;
          const targets = state.files.filter(function (rec) {
            return rec.bytes && rec.brushes && rec.brushes.some(function (b) {
              return libraryResourceCount(b, refreshAll) > 0;
            });
          });
          for (let i = 0; i < targets.length; i++) {
            const rec = targets[i];
            const before = rec.brushes.reduce(function (n, b) { return n + libraryResourceCount(b, false); }, 0);
            setProgress(0.05 + 0.9 * (i / targets.length), '用图库补回原图：' + rec.name);
            await sleep(0);
            if (state.files.indexOf(rec) < 0) continue;
            const staged = Object.assign({}, rec, { warnings: [], brushes: null, error: null });
            try {
              await parseRecord(staged, rec.parseName || rec.name, rec.bytes);
              // 旧图库的异步结果不得覆盖新图库；最后一次刷新必须执行。
              if (state.shapeLib !== library) { relibAgain = true; relibForce = true; break; }
              if (staged.error || !staged.brushes || staged.brushes.length !== rec.brushes.length ||
                  staged.brushes.some(function (b, n) { return b.name !== rec.brushes[n].name; })) {
                throw new Error(staged.error || '笔刷列表变化，已保留原结果');
              }
              if (state.files.indexOf(rec) < 0) continue;
              staged.brushes.forEach(function (b, n) { b.enabled = rec.brushes[n].enabled; });
              staged.warnings = Array.from(new Set((rec.warnings || []).filter(function (w) {
                return String(w).indexOf('内置笔尖原图') < 0;
              }).concat(staged.warnings || [])));
              ['sizeBytes','baseName','kind','kindLabel','warnings','brushes','origBrushes','parseName','bytes','error'].forEach(function (key) {
                if (Object.prototype.hasOwnProperty.call(staged, key)) rec[key] = staged[key];
              });
            } catch (e) {
              pushLog('图库重解析失败 ' + rec.name + '：' + (e && e.message ? e.message : e));
              continue;
            }
            const after = rec.brushes.reduce(function (n, b) { return n + libraryResourceCount(b, false); }, 0);
            fixed += Math.max(0, before - after);
            render();
          }
        } while (relibAgain && state.shapeLib);
      } finally {
        relibRunning = false;
        relibForce = false;
        setProgress(null);
      }
      updateShapeLibText();
      return fixed;
    })();
    return relibRunning;
  }
  /* #301：网页版一键下载图库包并自动导入。
     选项区的常驻按钮和缺图笔刷提示里的指引按钮共用这一个流程：
     流式显示下载进度 → 喂给 loadShapeLibrary → 自动 reparse 补回真笔尖。
     #303：精简512（32MB 单文件，推荐）与原图高清（216MB 分 3 卷，浏览器自动合并）两档可选。 */
  /* 图库包跨会话记忆：小包版/网页每次重开都要重下 32MB 太浪费，下过一次就存 IndexedDB。
     只存精简档（32MB）；原图 216MB 不存，避免撑爆配额。 */
  const ShapeLibStore = (function () {
    const DB_NAME = 'brushconv-shapelib', STORE = 'packs';
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        if (!window.indexedDB) return reject(new Error('当前环境不支持 IndexedDB'));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () { try { req.result.createObjectStore(STORE); } catch (e) { /* ignore */ } };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('IndexedDB 打开失败')); };
      });
      return dbp;
    }
    async function get(key) {
      try {
        const db = await open();
        return await new Promise(function (resolve, reject) {
          const tx = db.transaction(STORE, 'readonly');
          const r = tx.objectStore(STORE).get(key || 'lite');
          r.onsuccess = function () { resolve(r.result || null); };
          r.onerror = function () { reject(r.error); };
        });
      } catch (e) { return null; }
    }
    async function put(bytes, key) {
      if (!bytes || bytes.byteLength > 120 * 1048576) return false;
      try {
        const db = await open();
        await new Promise(function (resolve, reject) {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(bytes, key || 'lite');
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        });
        return true;
      } catch (e) { pushLog('图库缓存写入失败：' + ((e && e.message) || e)); return false; }
    }
    async function clear() {
      try {
        const db = await open();
        await new Promise(function (resolve, reject) {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete('lite');
          tx.objectStore(STORE).delete('full');
          tx.objectStore(STORE).delete('hsj');   // 画世界内置笔尖库（14MB），删除图库时一并释放
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        });
        return true;
      } catch (e) { return false; }
    }
    return { get: get, put: put, clear: clear };
  })();
  window.__shapeLibCache = ShapeLibStore;

  const SHAPE_LIB_PACKS = {
    lite: {
      key: 'lite',
      parts: ['Procreate内置笔尖图库_精简512.zip'],
      zipName: 'Procreate内置笔尖图库_精简512.zip',
      label: '图库包 · 精简512（自动下载）',
      doneText: '图库包已下载并导入',
      totalMB: 32,
    },
    full: {
      key: 'full',
      parts: ['Procreate内置笔尖图库_原图.zip.part1', 'Procreate内置笔尖图库_原图.zip.part2', 'Procreate内置笔尖图库_原图.zip.part3'],
      zipName: 'Procreate内置笔尖图库_原图.zip',
      label: '图库包 · 原图高清（自动下载）',
      doneText: '原图图库包已下载并导入',
      totalMB: 216,
    },
  };
  /* 原生壳（安卓 file:///android_asset、Electron file://）相对路径都取不到站点资源，
     统一用站点绝对地址；网页版仍用同源相对路径（可离线缓存）。 */
  const SITE_BASE = 'https://lostintianyi0712.github.io/brush-converter/';
  /* 国内直连 GitHub 实测很慢（0.1~2MB/s 大幅波动，raw/jsDelivr 直接连不上）：
     附上 gh 加速镜像（代理 raw.githubusercontent.com，带 CORS *、支持 Range 断点续传），
     下载时多源竞速，哪个快用哪个；镜像挂了也不影响直连兜底。 */
  const SITE_RAW_BASE = 'https://raw.githubusercontent.com/LostinTianyi0712/brush-converter/main/';
  /* 2026-11-07 实测（本机直连、无代理，取 512KB 片段）：
       Pages 直连 21.7 KB/s ｜ raw 直连 24.6 ｜ jsDelivr 17.3 ｜ gh-proxy 77.7 ｜ ghfast 78.9。
     单连接被限速，所以：① 镜像/jsd 排前面，直连只做兜底；② 单连接慢就靠多连接分段并发。 */
  const SITE_MIRRORS = ['https://gh-proxy.com/', 'https://gh-proxy.org/', 'https://ghfast.top/'];
  const SITE_CDN = ['https://cdn.jsdelivr.net/gh/LostinTianyi0712/brush-converter@main/'];
  function shapeLibSourceUrls(name) {
    if (/^(https?:)?\/\//.test(name)) return [name];
    const enc = encodeURI(name);
    const list = [];
    for (let i = 0; i < SITE_MIRRORS.length; i++) list.push(SITE_MIRRORS[i] + SITE_RAW_BASE + enc);
    for (let i = 0; i < SITE_CDN.length; i++) list.push(SITE_CDN[i] + enc);
    if (!(window.BrushNative || window.BrushDesktop)) list.push(enc); // 同源：可吃离线缓存，兜底
    list.push(SITE_BASE + enc);
    return list;
  }
  /* 原生壳传参格式：同一卷的多个候选源用 ';' 连接（卷与卷之间仍是 '|'），
     安卓原生按 ';' 逐源测速/换源重试 */
  function shapeLibUrl(name) { return shapeLibSourceUrls(name).join(';'); }
  let shapeLibDlBusy = false;
  /* 图库到底存在哪、占多大（安卓原生）：用户问「下载后图库去哪了」，界面直接读原生字段展示 */
  function nativeShapeLibInfo() {
    try {
      const n = window.BrushNative;
      if (n && typeof n.shapeLibInfo === 'function') return JSON.parse(String(n.shapeLibInfo()));
    } catch (e) { /* 老版本壳没有这个接口 */ }
    return null;
  }
  function refreshShapeLibStoreUI() {
    const box = document.getElementById('shapeLibStore');
    /* 学原神：先校验再决定要不要重下，别动不动整包重下 */
    const verify = document.getElementById('btnShapeLibVerify');
    if (verify && !verify.__wired) {
      verify.__wired = true;
      verify.addEventListener('click', function () {
        const n = window.BrushNative;
        if (!n || typeof n.shapeLibVerify !== 'function') return;
        const old = verify.textContent;
        verify.textContent = '校验中…';
        try {
          const r = String(n.shapeLibVerify(0) || '');
          if (r === 'ok:asset') {
            verify.textContent = '图库正常（安装包自带）';
            setTimeout(function () { verify.textContent = old; }, 2600);
            return;
          }
          if (r.indexOf('ok:') === 0) {
            verify.textContent = '图库正常（' + (Number(r.slice(3)) / 1048576).toFixed(1) + 'MB）';
            setTimeout(function () { verify.textContent = old; }, 2600);
            return;
          }
          verify.textContent = r === 'missing' ? '图库不在了，开始重新下载…' : '图库异常，开始修复…';
          const dl = document.getElementById('btnShapeLibDownload');
          if (dl) { dl.click(); setTimeout(function () { verify.textContent = old; }, 1500); }
          else verify.textContent = old;
        } catch (e) {
          verify.textContent = old;
        }
      });
    }
    const clear = document.getElementById('btnShapeLibClear');
    if (!box) return;
    const info = nativeShapeLibInfo();
    if (!info) {
      // 桌面版没有原生信息接口：图库在程序目录（下载或手动放进去的），有就显示一行 + 删除按钮
      const desk = window.BrushDesktop;
      if (desk && state.shapeLib && state.shapeLib.size) {
        box.hidden = false;
        box.textContent = '图库已装载：' + state.shapeLib.size + ' 张' +
          (state.shapeLibBytes ? '（' + (state.shapeLibBytes / 1048576).toFixed(1) + 'MB）' : '') +
          '，存在程序目录，卸载软件时一起删除。';
        if (clear) clear.hidden = false;
      } else {
        box.hidden = true;
        if (clear) clear.hidden = true;
      }
      return;
    }
    const mb = function (b) { return (b / 1048576).toFixed(1) + 'MB'; };
    // 诊断：区分「文件不在了」和「文件在但读不了」——清后台后要不要重下就靠这行判断
    const diag = [];
    if (info.privateBytes > 0) diag.push('files/ ' + mb(info.privateBytes));
    else diag.push('files/ 不存在');
    if (info.bakBytes > 0) diag.push('.bak ' + mb(info.bakBytes));
    if (info.extBytes > 0) diag.push('Android/data ' + mb(info.extBytes));
    if (info.asset) diag.push('安装包内置');
    if (info.readError) diag.push('读取错误：' + info.readError);
    if (window.__shapeLibDiagOnly) return;
    window.__shapeLibDiagText = '诊断：' + diag.join('；');
    try { if (diag.length && window.__shapeLibDiagLogged !== diag.join('|')) { window.__shapeLibDiagLogged = diag.join('|'); pushLog('图库诊断：' + diag.join('；')); } } catch (e) { /* ignore */ }
    const parts = [];
    // 只给一句结论：有没有图库、多大、卸载会删；存储细节只写进日志（诊断行）
    let when = '';
    if (info.mtime) {
      try {
        const d = new Date(Number(info.mtime));
        when = '，' + (d.getMonth() + 1) + '月' + d.getDate() + '日下载';
      } catch (e) { /* ignore */ }
    }
    const readyBytes = info.activeBytes > 0 ? info.activeBytes : info.privateBytes;
    if (readyBytes > 0) {
      parts.push('图库已就绪（' + mb(readyBytes) + '）' + when + '，卸载 App 时会一起删除');
    } else if (info.source === 'asset') parts.push('图库已就绪（安装包自带）');
    if (!parts.length) { box.hidden = true; if (clear) clear.hidden = true; return; }
    box.hidden = false;

    box.textContent = parts.join('；') + '。';
    if (clear) clear.hidden = !(info.privateBytes > 0 || info.active === 'ext');
    const vbtn = document.getElementById('btnShapeLibVerify');
    if (vbtn) vbtn.hidden = !(info.privateBytes > 0 || info.extBytes > 0 || info.asset);
  }
  window.__refreshShapeLibStoreUI = refreshShapeLibStoreUI;
  /* 安卓：走原生下载（WebView 自己 fetch 32MB 实测卡在 0/32MB），下载完直接读 App 私有目录。
     resume=true 时不重新发起下载，只接管已有任务（导入笔刷 / Activity 重建后进度不丢）。 */
  async function nativeShapeLibDownload(urls, btn, totalMB, resume) {
    const native = window.BrushNative;
    const list = Array.isArray(urls) ? urls : [urls];
    btn.textContent = '下载中 0/' + totalMB + 'MB…';
    let lastT = Date.now(), lastGot = null, speed = 0, stagnantSec = 0;
    if (!resume) {
      const started = list.length > 1
        ? (typeof native.shapeLibDownloadMultiStart === 'function' && native.shapeLibDownloadMultiStart(list.join('|')))
        : native.shapeLibDownloadStart(list[0]);
      if (!started) throw new Error('已有下载在进行');
    }
    const started = Date.now();
    for (;;) {
      await new Promise(function (r) { setTimeout(r, 400); });
      const raw = String(native.shapeLibDownloadStatus() || 'idle|0|-1');
      const parts = raw.split('|');
      const st = parts[0], got = Number(parts[1]) || 0, total = Number(parts[2]) || 0;
      if (st === 'done') { btn.textContent = '下载完成，正在导入…'; return; }
      if (st.indexOf('error') === 0) throw new Error(st.slice(6) || '下载失败');
      const nowT = Date.now();
      if (lastGot === null) { lastGot = got; lastT = nowT; }
      if (nowT - lastT >= 1500) {
        speed = Math.max(0, got - lastGot) / ((nowT - lastT) / 1000);
        /* 【第181轮】接管旧任务时加停滞检测：覆盖安装后原生状态可能卡在 running 且
           got 不再增长，界面会永久停在「下载中 141.0/32MB」。连续 12 秒没新字节就
           中止接管（Abort 只清 .part，不动已下好的图库），交给上层恢复界面。 */
        if (got > lastGot) stagnantSec = 0; else stagnantSec += (nowT - lastT) / 1000;
        if (resume && stagnantSec >= 12) {
          try { if (typeof native.shapeLibDownloadAbort === 'function') native.shapeLibDownloadAbort(); } catch (e) { /* ignore */ }
          throw new Error('上次的下载已停滞，停止接管');
        }
        lastT = nowT; lastGot = got;
      }
      const mbps = (speed / 1048576).toFixed(2) + 'MB/s';
      /* totalMB 传 0（接管分支）时不能除 0，也不能让「141.0/32MB」这种矛盾数字出现：
         原生 total 不可信时先用已下字节兜底，至少分母不会小于分子。 */
      const displayTotal = total >= got && total > 0 ? total : (totalMB > 0 ? totalMB * 1048576 : Math.max(got, 1));
      btn.textContent = '下载中 ' + Math.round(got / 1048576) +
        (displayTotal >= got ? '/' + Math.round(displayTotal / 1048576) : '') + 'MB · ' + mbps + '…';
      if (Date.now() - started > 15 * 60 * 1000) throw new Error('下载超时');
    }
  }
  /* 把图库字节分块写进 App 私有目录（安卓：内部 files/，外部 Android/data/<包名>/files）。
     按块走 base64，避免一次性复制几百 MB；大包只落盘、不进 IndexedDB（内存翻倍会崩）。 */
  async function nativePersistLibBytes(bytes, quiet) {
    const n = window.BrushNative;
    if (!n || typeof n.shapeLibSaveBegin !== 'function') return false;
    if (!bytes || !bytes.length) return false;
    try {
      if (!n.shapeLibSaveBegin()) throw new Error('无法创建文件');
      const CHUNK = 3 * 1024 * 1024;
      for (let off = 0; off < bytes.length; off += CHUNK) {
        const part = bytes.subarray(off, Math.min(CHUNK, bytes.length - off) + off);
        let bin = '';
        for (let i = 0; i < part.length; i++) bin += String.fromCharCode(part[i]);
        if (!n.shapeLibSaveChunk(btoa(bin))) { n.shapeLibSaveAbort(); throw new Error('写入失败'); }
        await sleep(0); // 落盘也分片让出，别边下载边卡界面
      }
      const res = String(n.shapeLibSaveEnd() || '');
      if (res.indexOf('ok:') !== 0) throw new Error(res.slice(6) || '保存失败');
      pushLog('图库已写入 App 私有目录：' + res.slice(3) + 'B（升级安装不丢，卸载一起删）');
      refreshShapeLibStoreUI();
      return true;
    } catch (e) {
      pushLog('图库落盘失败：' + ((e && e.message) || e));
      if (!quiet) toast('图库已加载，但没能存进 App 目录（下次启动需重下）：' + ((e && e.message) || e), 7000);
      return false;
    }
  }

  /* 多源竞速下载：并发请求所有候选地址，先开一个观察窗口（2.5s）比较各源到手的字节，
     之后只留最快的源继续读，其余掐掉；领先源卡死（10s 读不出一个字节）、报错或
     提前结束时，把已收字节入库，用 Range 到其余源上重开一轮竞速，直到凑齐总长。
     返回完整 Blob。 */
  /* 多连接分段下载：同一条链路被限速时（实测单连接 ~78KB/s），并发 4 段能叠加吞吐。
     先各源并发探一个字节拿 Content-Range 总长并计速；不支持 Range（非 206）就返回 null，
     由调用方退回单连接竞速。任何一段失败会换下一个源重试；拿不全也返回 null。 */
  async function parallelRangeBlob(urls, onProgress, opts) {
    urls = (urls || []).filter(Boolean);
    if (!urls.length || typeof fetch !== 'function') return null;
    opts = opts || {};
    const CHUNK = opts.chunkBytes || 4 * 1048576;
    const MAXP = Math.max(1, Math.min(8, opts.parallel || 4));
    /* 第200轮（AUDIT-20261111-02/04）：每个请求都有期限，并接受调用方的取消信号。
       以前预检 Promise.all 等全部源、分片也没有期限——一个永不返回的源就能让整次下载挂住；
       signal 也只是被传进来、从没用到，取消后照样发请求、照样把结果交给调用方安装。
       probeTimeoutMs：预检单个源的连接+读取期限；stallMs：分片「多久没收到新字节」算卡死；
       bodyTimeoutMs：环境不支持流式读取时，整段读取的总期限。 */
    const PROBE_MS = opts.probeTimeoutMs > 0 ? opts.probeTimeoutMs : 8000;
    const STALL_MS = opts.stallMs > 0 ? opts.stallMs : 20000;
    const BODY_MS = opts.bodyTimeoutMs > 0 ? opts.bodyTimeoutMs : Math.max(STALL_MS, 180000);
    const PROBE_GRACE_MS = opts.probeGraceMs >= 0 ? opts.probeGraceMs : 1500;
    const signal = opts.signal || null;
    const inflight = new Set();
    let stopped = false;
    function abortError() { const e = new Error('下载已取消'); e.name = 'AbortError'; return e; }
    function aborted() { return !!(signal && signal.aborted); }
    function checkAbort() { if (aborted()) throw abortError(); }
    function stopAll() { stopped = true; inflight.forEach(function (c) { try { c.abort(); } catch (e) { /* ignore */ } }); }
    function onOuterAbort() { stopAll(); }
    if (signal && signal.addEventListener) signal.addEventListener('abort', onOuterAbort);
    /* 单个 Range 请求：连接期限 connectMs；流式读取时每次 read 都重新计时（只判「卡住」，不误杀慢而健康的源），
       不支持流式时按 bodyMs 限总时长。超时/取消都会 abort 底层请求，且不依赖 fetch 自己响应 abort。 */
    async function timedRange(u, range, connectMs, bodyMs) {
      checkAbort();
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      if (ctl) inflight.add(ctl);
      let timer = null, kill = null;
      const killed = new Promise(function (_, reject) { kill = reject; });
      killed.catch(function () { /* 由 race 消费 */ });
      function arm(ms, msg) {
        clearTimeout(timer);
        timer = setTimeout(function () { if (ctl) ctl.abort(); kill(new Error(msg)); }, ms);
      }
      function onAbort() { if (ctl) ctl.abort(); kill(abortError()); }
      if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort);
      try {
        arm(connectMs, '下载源连接超时');
        const res = await Promise.race([
          fetch(u, { headers: { Range: range }, cache: 'no-store', signal: ctl ? ctl.signal : (signal || undefined) }),
          killed
        ]);
        if (res.status !== 206) {
          try { if (res.body && res.body.cancel) Promise.resolve(res.body.cancel()).catch(function () {}); } catch (e) { /* ignore */ }
          if (ctl) ctl.abort();
          return { res: res, bytes: null };
        }
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        let bytes;
        if (reader) {
          const parts = [];
          let len = 0;
          for (;;) {
            arm(connectMs, '下载源读取卡住');
            const r = await Promise.race([reader.read(), killed]);
            if (r.done) break;
            parts.push(r.value); len += r.value.length;
          }
          bytes = new Uint8Array(len);
          let off = 0;
          for (const p of parts) { bytes.set(p, off); off += p.length; }
        } else {
          arm(bodyMs, '下载源读取超时');
          bytes = new Uint8Array(await Promise.race([res.arrayBuffer(), killed]));
        }
        return { res: res, bytes: bytes };
      } catch (e) {
        if (aborted()) throw abortError();
        throw e;
      } finally {
        clearTimeout(timer);
        if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
        if (ctl) inflight.delete(ctl);
      }
    }
    function contentRange(res) {
      const cr = (res.headers && res.headers.get && res.headers.get('content-range')) || '';
      const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(cr);
      return m ? { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? 0 : Number(m[3]) } : null;
    }
    /* R202-02：文件「版本身份」。等长 + Range 全对也不代表同一份文件——主站已发新版、
       镜像还缓存着等长的旧版时，各取一半会拼出一个谁都没发布过的混合文件。
       ETag（优先）/ Last-Modified 用来认版本；两者都没有的源记为 ''（未知）。 */
    function versionId(res) {
      const h = res && res.headers;
      if (!h || typeof h.get !== 'function') return '';
      const etag = h.get('etag');
      if (etag) return 'etag:' + String(etag).trim();
      const lm = h.get('last-modified');
      return lm ? 'lm:' + String(lm).trim() : '';
    }
    try {
      checkAbort();
      const score = new Map();
      let total = 0;
      const authUrl = urls.find(function (u) { return typeof u === 'string' && u.indexOf(SITE_BASE) === 0; });
      let readyNow = null;
      const ready = new Promise(function (r) { readyNow = r; });
      const probes = urls.map(async function (u) {
        const t0 = Date.now();
        try {
          const got = await timedRange(u, 'bytes=0-0', PROBE_MS, PROBE_MS);
          if (!got.bytes) return;
          const cr = contentRange(got.res);
          // 探测必须真的是第 0 字节；起点不对的源（错误缓存/代理乱回 Range）直接不参选
          if (!cr || cr.start !== 0 || cr.end !== 0 || got.bytes.length !== 1) return;
          score.set(u, { bytes: 1, ms: Math.max(1, Date.now() - t0), total: cr.total, ver: versionId(got.res) });
          // 发布源到了（或根本没有发布源时任一源到了），再给其余源一个短宽限就开始，不等慢源
          if (cr.total > 0 && (!authUrl || u === authUrl)) readyNow();
        } catch (e) { if (e && e.name === 'AbortError') throw e; /* 该源不支持/不可达/超时 */ }
      });
      const allProbes = Promise.all(probes);
      await Promise.race([
        allProbes,
        ready.then(function () { return new Promise(function (r) { setTimeout(r, PROBE_GRACE_MS); }); })
      ]);
      allProbes.catch(function () { /* 迟到的预检结果不再采用 */ });
      checkAbort();
      // 预检阶段结束：还没回来的探测一律掐掉，别和分片抢连接
      inflight.forEach(function (c) { try { c.abort(); } catch (e) { /* ignore */ } });
      /* 选权威长度：原来直接取所有源里最大的 Content-Range，等于默认「旧缓存更大就是新版」。
         一旦新版比旧缓存小，就会静默把 CDN 旧文件当新版下载回来（没有任何报错）。
         按 SITE_BASE 前缀认出发布源，优先采信它的长度（不依赖候选顺序）；
         发布源不可达或调用方只给了自定义 URL 时，退回「票多者胜、平局取大」。 */
      const authoritative = authUrl && score.get(authUrl);
      if (authoritative && authoritative.total > 0) {
        total = authoritative.total;
      } else {
        const votes = new Map();
        for (const u of urls) {
          const s = score.get(u);
          if (s && s.bytes > 0 && s.total > 0) votes.set(s.total, (votes.get(s.total) || 0) + 1);
        }
        let best = 0, bestVotes = -1;
        for (const [len, cnt] of votes) {
          if (cnt > bestVotes || (cnt === bestVotes && len > best)) { best = len; bestVotes = cnt; }
        }
        total = best;
      }
      /* 只认同长度的源：镜像/CDN 可能缓存着旧版本（实测 gh-proxy 对同一路径返回 10,638,011B、
         Pages 与 ghfast 是 14,171,205B）。不同长度的源混进并发分块会拼出坏文件，直接剔除。 */
      /* R202-02：再按版本身份筛一遍。发布源优先当基准；没有发布源时取第一个带身份的源。
         基准存在时，身份不同或根本不报身份的源都不参与——「无法核实是同一版本」就不混拼，
         宁可少几个连接或退回单连接兜底，也不能把两版拼成一个文件。
         所有源都不报 ETag/Last-Modified 时保持原有行为（无法区分，仍按长度与 Range 校验）。 */
      let baseVer = authoritative && authoritative.ver ? authoritative.ver : '';
      if (!baseVer) {
        for (const u of urls) {
          const s = score.get(u);
          if (s && s.bytes > 0 && s.total === total && s.ver) { baseVer = s.ver; break; }
        }
      }
      const live = urls.filter(function (u) {
          const s = score.get(u);
          if (!s || !(s.bytes > 0) || s.total !== total) return false;
          return !baseVer || s.ver === baseVer;
      });
      if (baseVer) {
        const mixedVer = urls.filter(function (u) {
          const s = score.get(u);
          return s && s.bytes > 0 && s.total === total && s.ver !== baseVer;
        });
        if (mixedVer.length) pushLog('下载源版本不一致，已忽略：' + mixedVer.map(function (u) {
          return u + ' (' + (score.get(u).ver || '无版本标识') + ')';
        }).join('、'));
      }
      if (!total || !live.length) {
        const mixed = urls.filter(function (u) { return score.has(u) && score.get(u).total !== total; });
        if (mixed.length) pushLog('下载源长度不一致，已忽略：' + mixed.map(function (u) { return u + ' (' + score.get(u).total + 'B)'; }).join('、'));
        return null;
      }
      const n = Math.ceil(total / CHUNK);
      const parts = new Array(n);
      let got = 0, next = 0;
      function orderBy() {
        return live.slice().sort(function (a, b) {
            const sa = score.get(a), sb = score.get(b);
            return (sb.bytes / sb.ms) - (sa.bytes / sa.ms);
        });
      }
      async function oneChunk(i) {
        const start = i * CHUNK, end = Math.min(total, start + CHUNK) - 1, want = end - start + 1;
        let lastErr = null;
        for (const u of orderBy()) {
          if (stopped) break;
          checkAbort();
          const t0 = Date.now();
          try {
            const r = await timedRange(u, 'bytes=' + start + '-' + end, STALL_MS, BODY_MS);
            if (!r.bytes) throw new Error('range unsupported: ' + r.res.status);
            /* 第200轮（AUDIT-20261111-03）：长度对不等于内容对。CDN 错误缓存/代理乱处理 Range 时，
               会对 bytes=4-7 回 206 + 「bytes 0-3/8」+ 4 字节，以前照收，拼出 abcdabcd。
               起点/终点/总长三项必须与请求一致，否则拒收换源。 */
            const cr = contentRange(r.res);
            if (!cr || cr.start !== start || cr.end !== end || (cr.total && cr.total !== total)) {
              throw new Error('Content-Range 不符：请求 ' + start + '-' + end + '/' + total + '，返回 ' +
                ((r.res.headers && r.res.headers.get && r.res.headers.get('content-range')) || '无'));
            }
            /* R202-02：分片响应自己也要复核版本。文件可能在下载途中被更新，
               预检一致不代表此刻这一段还是同一版。 */
            const rver = versionId(r.res);
            if (baseVer && rver && rver !== baseVer) {
              throw new Error('下载源分片版本不一致：期望 ' + baseVer + '，返回 ' + rver);
            }
            const buf = r.bytes;
            if (buf.length !== want) throw new Error('short chunk ' + buf.length + '/' + want);
            const s = score.get(u) || { bytes: 0, ms: 1 };
            s.bytes += buf.length; s.ms += Math.max(1, Date.now() - t0);
            score.set(u, s);
            parts[i] = buf; got += buf.length;
            onProgress && onProgress(got);
            return;
          } catch (e) {
            if (e && e.name === 'AbortError') throw e;
            lastErr = e;
            // 出错/卡死的源降权：后面的分片先找别的源，不再每段都在它身上等满期限
            const s = score.get(u);
            if (s) s.ms += STALL_MS;
          }
        }
        throw lastErr || new Error('chunk ' + i + ' failed');
      }
      const workers = Math.min(MAXP, n);
      try {
        await Promise.all(Array.from({ length: workers }, async function () {
          for (;;) {
            if (stopped) return;
            const i = next++;
            if (i >= n) return;
            await oneChunk(i);
          }
        }));
      } catch (e) {
        stopAll(); // 一段彻底失败：其余并行分片立即停，不在后台继续耗流量
        if (aborted() || (e && e.name === 'AbortError')) throw abortError();
        return null;
      }
      checkAbort();
      if (got !== total) return null;
      return new Blob(parts);
    } finally {
      if (signal && signal.removeEventListener) signal.removeEventListener('abort', onOuterAbort);
      inflight.forEach(function (c) { try { c.abort(); } catch (e) { /* ignore */ } });
    }
  }

  async function raceDownloadBlob(urls, onProgress) {
    urls = (urls || []).filter(Boolean);
    if (!urls.length) throw new Error('没有可用的下载地址');
    let remaining = urls.slice();
    let chunks = [];      // 已确认字节（观察期 + 各轮领先源读到的数据）
    let chunksGot = 0;    // chunks 里的字节数（换源续传的起点）
    let expectTotal = 0;  // 按响应 Content-Length/Content-Range 算出的文件总长（0 = 未知）
    const EVAL_MS = 2500, EVAL_GRACE_MS = 3000, STALL_MS = 10000;
    /* R202-02：单连接竞速同样会「领先源读一半 → 带 Range 换源续传」，等长异版本也能拼成混合文件。
       并行分段被版本筛掉后会退回这里，所以兜底路径也要认版本：以**实际贡献了前一段字节的
       领先源**为基准（而不是最先返回响应头的源），续传轮只接同一版本的源。 */
    let raceVer = '';
    function versionId(res) {
      const h = res && res.headers;
      if (!h || typeof h.get !== 'function') return '';
      const etag = h.get('etag');
      if (etag) return 'etag:' + String(etag).trim();
      const lm = h.get('last-modified');
      return lm ? 'lm:' + String(lm).trim() : '';
    }

    function resLen(res) {
      const h = res.headers;
      if (!h || !h.get) return 0;
      if (res.status === 206) {
        const cr = h.get('content-range');
        if (cr) { const t = Number(String(cr).split('/')[1]); if (t > 0) return t; }
        return chunksGot + (Number(h.get('content-length')) || 0); // 206 无 content-range：CL 是剩余量
      }
      return Number(h.get('content-length')) || 0;
    }

    async function round() {
      const headers = chunksGot > 0 ? { Range: 'bytes=' + chunksGot + '-' } : {};
      const st = [], pending = [], requests = [];
      let accepting = true, t0 = 0, announceReady;
      const firstReady = new Promise(function (resolve) { announceReady = resolve; });
      // 观察窗口：所有源并发各读一段，比较字节量，选最快的；
      // 读过程不设每读定时器（不误杀健康的慢源）。窗口到点后对还在途的 read
      // 限时宽限（并行等）：宽限内落地的源连接干净、交给主循环接着读；
      // 仍不返回的源判挂死（skip）：连接掐掉、本轮不再参选——它 reader 上还有
      // 在途 read，此时接管会错位丢数据，只能等下一轮带 Range 换源重试。
      // 观察窗口里也要报进度：否则用户看到的是「一直不动，等一整卷下完才跳」。
      // 取各源已收字节的最大值（就是当前领先者），250ms 节流，避免刷 DOM。
      let lastReport = 0;
      function reportEval() {
        const now = Date.now();
        if (now - lastReport < 250) return;
        lastReport = now;
        let max = 0;
        for (let i = 0; i < st.length; i++) if (st[i].got > max) max = st[i].got;
        onProgress && onProgress(chunksGot + max);
      }
      // 每源在途 read 的 promise（宽限判定用）
      function step(s, i) {
        if (s.done || s.err || s.skip) return Promise.resolve();
        const p = s.reader.read().then(function (r) {
          pending[i] = null;
          if (s.skip) return; // 判挂死后才迟到的数据：放弃（连接已掐）
          if (r.done) { s.done = true; return; }
          s.chunks.push(r.value);
          s.got += r.value.length;
          reportEval();
          if (Date.now() - t0 < EVAL_MS) return step(s, i); // 窗口内继续读
        }, function (e) {
          pending[i] = null;
          if (!s.skip) s.err = e || true;
        });
        pending[i] = p;
        return p;
      }
      // Each response starts streaming as soon as its headers arrive. Waiting
      // for Promise.all(fetches) here let one stalled mirror freeze every source.
      const opened = Promise.all(remaining.map(async function (u) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const request = { url: u, reader: null, cancel: null };
        requests.push(request);
        let timer;
        try {
          const res = await new Promise(function (resolve, reject) {
            request.cancel = function () {
              if (controller) controller.abort();
              reject(new Error('下载源连接超时'));
            };
            timer = setTimeout(request.cancel, 10000);
            fetch(u, { cache: 'default', headers: headers, signal: controller ? controller.signal : undefined })
              .then(resolve, reject);
          });
          clearTimeout(timer);
          const ver = versionId(res);
          const versionMismatch = chunksGot > 0 && raceVer && ver !== raceVer;
          const contentType = res.headers && res.headers.get ? String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() : '';
          const errorPage = /^(text\/html|application\/(xhtml\+xml|json|problem\+json))$/.test(contentType);
          if (!accepting || !res.ok || errorPage || (chunksGot > 0 && res.status !== 206) || versionMismatch) {
            if (controller) controller.abort();
            if (res.body && res.body.cancel) Promise.resolve(res.body.cancel()).catch(function () {});
            return;
          }
          const reader = res.body && res.body.getReader ? res.body.getReader() : null;
          request.reader = reader;
          const s = { reader: reader, response: res, url: u, got: 0, chunks: [], done: false, err: null, skip: false };
          const i = st.push(s) - 1;
          const len = resLen(res);
          if (!expectTotal && len > 0) expectTotal = len;
          if (!t0) t0 = Date.now();
          announceReady();
          if (reader) await step(s, i);
        } catch (e) { /* 本轮其余源继续，全部失败时统一报错 */ }
        finally { clearTimeout(timer); }
      }));
      await Promise.race([firstReady, opened]);
      if (!st.length) throw new Error('所有下载源都不可用');
      // Legacy browsers without streaming bodies still reuse the open response.
      if (!st[0].reader) {
        accepting = false;
        for (const req of requests) if (req.url !== st[0].url && req.cancel) req.cancel();
        const bytes = new Uint8Array(await st[0].response.arrayBuffer());
        onProgress && onProgress(chunksGot + bytes.length);
        return new Blob(chunks.concat([bytes]));
      }
      await Promise.race([
        opened,
        new Promise(function (res) { setTimeout(res, EVAL_MS); }) // 窗口到点
      ]);
      accepting = false;
      for (const req of requests) if (!req.reader && req.cancel) req.cancel();
      // 窗口结束：对仍在途的 read 并行限时宽限（settled 标记保证先落地的源
      // 不会被 3 秒后仍然到点的超时回调误杀——race 的输家回调照样会执行）
      await Promise.all(st.map(function (s, i) {
        if (s.done || s.err || s.skip || !pending[i]) return null;
        let settled = false;
        return Promise.race([
          pending[i].then(function () { settled = true; }),
          new Promise(function (res) { setTimeout(res, EVAL_GRACE_MS); }).then(function () {
            if (settled || s.done || s.err || s.skip) return;
            s.skip = true; // 宽限期内没落地：read 挂死
            try { s.reader.cancel(); } catch (e) { /* ignore */ }
          })
        ]);
      }));
      let best = -1;
      for (let i = 0; i < st.length; i++) {
        if (st[i].skip) continue; // 挂死源：reader 上还有在途 read，接管会错位丢数据
        if (st[i].err && st[i].got === 0) continue; // 一字节没到手就报错的源不值得留
        if (best < 0 || st[i].got > st[best].got) best = i;
      }
      if (best < 0) throw new Error('所有下载源都不可用');
      const leader = st[best];
      /* R205-04：expectTotal 以前是「最先返回响应头的源」报的长度。镜像/CDN 报的
         Content-Length 可能和真正贡献字节的 leader 不是同一份文件：leader 中途结束时，
         chunksGot >= 那个偏小的总长会提前判完成，把截断包当好包交给调用方。
         以 leader 自己的响应长度为准（206 取 Content-Range 的总长）。 */
      const leaderLen = resLen(leader.response);
      if (leaderLen > 0) expectTotal = leaderLen;
      if (!raceVer) raceVer = versionId(leader.response);
      const others = remaining.filter(function (u) { return u !== leader.url; });
      for (const req of requests) {
        if (req.url === leader.url) continue;
        if (req.reader) Promise.resolve(req.reader.cancel()).catch(function () {});
        if (req.cancel) req.cancel();
      }
      chunks = chunks.concat(leader.chunks);
      chunksGot += leader.got;
      onProgress && onProgress(chunksGot);
      function settle(failErr, knownDone) {
        if (expectTotal && chunksGot >= expectTotal) return new Blob(chunks);
        if (!expectTotal && knownDone) return new Blob(chunks); // 服务器没报总长：正常读到结尾按完成处理
        if (others.length) { remaining = others; return round(); }
        if (failErr) throw (failErr instanceof Error ? failErr : new Error(String(failErr)));
        throw new Error('下载不完整：' + chunksGot + (expectTotal ? '/' + expectTotal : '') + '，所有源都已用尽');
      }
      if (leader.done || leader.err) return settle(leader.err || undefined, leader.done);
      // 主循环：读领先源；卡死/出错就带着已收字节换源续传
      const reader = leader.reader;
      for (;;) {
        const readP = reader.read();
        const r = await Promise.race([
          readP.catch(function (e) { return { __err: e || true }; }),
          new Promise(function (res) { setTimeout(function () { res(null); }, STALL_MS); })
        ]);
        if (r === null) { // 卡死：掐掉，换源续传
          try { reader.cancel(); } catch (e) { /* ignore */ }
          if (!others.length) throw new Error('下载中断：所有源都无响应');
          remaining = others;
          return round();
        }
        if (r.__err) {
          try { reader.cancel(); } catch (e) { /* ignore */ }
          return settle(r.__err);
        }
        if (r.done) return settle(undefined, true);
        chunks.push(r.value);
        chunksGot += r.value.length;
        onProgress && onProgress(chunksGot);
      }
    }
    return round();
  }

  /* 下载进度显示：UI 自己每 200ms 重绘（转圈 + 百分比 + 速度），不依赖下载内核多久回调一次。
     多卷包以前看着就是「一整卷下完才跳一格」——内核只报整卷边界时，界面照样在动。 */
  let shapeDlTick = null;
  function shapeDlProgressStart(btn, totalBytes, label) {
    shapeDlProgressStop();
    /* label：这段既用于「下载」，也用于「读取本地已下好的包」，文案要分开，
       否则读 216MB 文件时用户看到的是「下载中」，以为还在下。
       total 允许传 0/未知：paint 里用 max(total, got) 兜底，绝不出现分母小于分子。 */
    const st = { got: 0, total: Number(totalBytes) > 0 ? Number(totalBytes) : 0,
      label: label || '下载中', t0: Date.now(), frame: 0, timer: null };
    const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
    function paint() {
      if (!btn || btn.isConnected === false) { shapeDlProgressStop(); return; }
      const secs = Math.max(1, (Date.now() - st.t0) / 1000);
      const mb = st.got / 1048576;
      const rate = mb / secs;
      /* 分母兜底：total 可能是精简档的 32MB，而实际读/下的是 216MB 原图包。
         以前直接除，结果「206.0/32MB」—— 百分比早就 100%，数字却自相矛盾。 */
      /* total 未知（0，例如读本地包时还没拿到长度）也要有分母：用已读字节兜底，
         否则百分比整段消失，只剩「206.0MB」，看不出进度。 */
      const totalMB = Math.max(Math.ceil((st.total || 0) / 1048576), Math.ceil(mb), 0);
      const pct = totalMB > 0 ? Math.min(100, Math.floor(mb * 100 / totalMB)) : 0;
      const size = totalMB > 0 ? mb.toFixed(1) + '/' + totalMB + 'MB' : mb.toFixed(1) + 'MB';
      btn.textContent = spin[st.frame++ % spin.length] + ' ' + st.label + ' ' + (totalMB > 0 ? pct + '% · ' : '') + size + ' · ' + rate.toFixed(rate >= 10 ? 0 : 1) + 'MB/s…';
    }
    st.set = function (n) { n = Number(n) || 0; if (n > st.got) st.got = n; };
    st.paint = paint;
    shapeDlTick = st;
    paint();
    st.timer = setInterval(paint, 200);
    return st;
  }
  function shapeDlProgressStop() {
    const st = shapeDlTick;
    shapeDlTick = null;
    if (st && st.timer !== null && st.timer !== undefined) clearInterval(st.timer); // 定时器 id 可能是 0
    return st;
  }
  async function downloadShapeLibPack(btn, pack) {
    pack = pack || SHAPE_LIB_PACKS.lite;
    if (shapeLibDlBusy) return;
    if (state.shapeLib && state.shapeLibPackKey === 'full' && pack.key === 'lite') { toast('已加载原图高清图库包，无需再下载精简版', 4000); return; }
    if (state.shapeLib && state.shapeLibPackKey === pack.key) { toast('这个图库包已经加载过了，无需重复下载', 4000); return; }
    if (isBusy()) { toast('正在转换，稍后再下载图库包', 5000); return; }
    shapeLibDlBusy = true;
    const label = btn.textContent;
    try {
      btn.disabled = true;
      const totalBytes = pack.totalMB * 1048576;
      // 安卓 App：原生下载（接口存在时优先），完成后再从私有目录读字节导入
      if (window.BrushNative && typeof window.BrushNative.shapeLibDownloadStart === 'function') {
        // 单卷、多卷都交给原生：写盘 + Range 续传，关掉进程再点接着下（原神同款行为）
        // 原生失败（例如 CDN 乱发 gzip 触发的 ID1ID2）不要就此停住：清掉 .part，退回下面网页内下载重试
        try {
          await nativeShapeLibDownload(pack.parts.map(shapeLibUrl), btn, pack.totalMB);
          btn.textContent = '正在导入图库…';
          const got = await bundledShapeLibBytes();
          // AUDIT-20261111-01：先读通再写 IndexedDB（原生侧落盘前已做 ZIP 结构校验）
          const upgrade = !!(state.shapeLib && state.shapeLibPackKey !== pack.key);
          await loadShapeLibraryBytes(got.bytes, pack.label, upgrade);
          state.shapeLibPackKey = pack.key;
          // 安卓也存一份到 IndexedDB：它也是 App 数据（卸载会删），但能当私有目录的安全网——
          // 万一某次更新后 files/ 里的图库读不到，启动时能立即从缓存恢复，不用重下 32MB。
          try {
            if (got.bytes.length <= 120 * 1048576) {
              const cachedNative = await ShapeLibStore.put(got.bytes, pack.key);
              pushLog(cachedNative ? '图库同时存进 App 数据（' + got.bytes.length + 'B），更新后可直接恢复' : '图库缓存失败（不影响使用）');
            }
          } catch (e) { /* 缓存失败不影响本次使用 */ }
          btn.textContent = pack.doneText;
          toast('图库包已下载到 App 内（下次启动自动加载，卸载会一起删）', 5000);
          pushLog('图库包已通过原生下载保存：' + got.bytes.length + 'B');
          refreshShapeLibStoreUI();
          render();
          return;
        } catch (nativeErr) {
          const nativeMsg = (nativeErr && nativeErr.message) || String(nativeErr);
          pushLog('原生下载失败，改用网页内下载重试：' + nativeMsg);
          toast('正在换个方式重新下载…', 5000);
          try { if (typeof window.BrushNative.shapeLibDownloadAbort === 'function') window.BrushNative.shapeLibDownloadAbort(); } catch (e) { /* ignore */ }
          btn.disabled = false;
          if (btn.dataset && btn.dataset.label) btn.textContent = btn.dataset.label;
        }
      }
      let blob;
      shapeDlProgressStart(btn, totalBytes); // 网页内下载：进度由本地定时器驱动，始终在动
      if (pack.parts.length === 1) {
        // 先试多连接分段（镜像限速时能叠加吞吐），拿不到再退回单连接多源竞速
        const singleUrls = shapeLibSourceUrls(pack.parts[0]);
        blob = await parallelRangeBlob(singleUrls, function (n) {
          if (shapeDlTick) shapeDlTick.set(n);
        });
        if (!blob) blob = await raceDownloadBlob(singleUrls, function (n) {
          if (shapeDlTick) shapeDlTick.set(n);
        });
      } else {
        // 多卷包：逐卷竞速下载，跨卷累计进度，最后在浏览器里合并成一个 zip
        const chunks = [];
        let got = 0;
        for (const part of pack.parts) {
          const partUrls = shapeLibSourceUrls(part);
          let partBlob = await parallelRangeBlob(partUrls, function (n) {
            if (shapeDlTick) shapeDlTick.set(got + n);
          });
          if (!partBlob) partBlob = await raceDownloadBlob(partUrls, function (n) {
            if (shapeDlTick) shapeDlTick.set(got + n); // 跨卷累加：每卷都从上一卷的字节数接着走
          });
          chunks.push(new Uint8Array(await partBlob.arrayBuffer()));
          got += partBlob.size;
        }
        blob = new Blob(chunks);
      }
      shapeDlProgressStop();
      btn.textContent = '正在导入图库…';
      const packBytes = new Uint8Array(await blob.arrayBuffer());
      /* AUDIT-20261111-01：先在内存里把图库完整读一遍（ZIP + 资源），通过了才写任何持久化存储。
         以前是先写 App 私有目录 / IndexedDB / 桌面程序目录，再解析——坏包一来三处旧图库全被覆盖，
         页面报失败也回不去，下次启动还会读到坏缓存。loadShapeLibraryBytes 失败会抛错，落到下面 catch。
         精简→原图升级时已有笔刷不缺 tip，需要强制重建才能换上高清笔尖。 */
      const isUpgrade = !!(state.shapeLib && state.shapeLibPackKey !== pack.key);
      await loadShapeLibraryBytes(packBytes, pack.label, isUpgrade);
      state.shapeLibPackKey = pack.key;
      // 原神式落盘：写进 App 私有目录（外部优先），下次启动直接加载，升级安装不丢，卸载才删
      const savedNative = await nativePersistLibBytes(packBytes, true);
      if (packBytes.length <= 120 * 1048576) {
        // 小包再存一份 App 数据缓存（216MB 原图不存：内存和磁盘都翻倍，还容易 OOM）
        const cached = await ShapeLibStore.put(packBytes, pack.key);
        if (cached) pushLog('图库包已存入 App 数据（' + pack.key + '，' + Math.round(packBytes.length / 1048576) + 'MB）');
      }
      if (savedNative) window.__shapeLibCacheText = '已存进 App 私有目录（' + Math.round(packBytes.length / 1048576) + 'MB，升级不丢，卸载一起删）';
      else if (packBytes.length <= 120 * 1048576) window.__shapeLibCacheText = '已缓存 ' + Math.round(packBytes.length / 1048576) + 'MB（升级不丢，卸载一起删）';
      // 桌面版：顺手把包存到程序目录，下次启动自动加载（不用再下）
      if (window.BrushDesktop && typeof window.BrushDesktop.saveShapeLib === 'function') {
        try {
          const saved = await window.BrushDesktop.saveShapeLib(packBytes, pack.key === 'full' ? 'Procreate内置笔尖图库_原图.zip' : 'Procreate内置笔尖图库_精简512.zip');
          if (saved && saved.ok) {
            pushLog('图库包已存到程序目录：' + saved.path);
            toast('图库包已下载并保存到程序目录，下次启动自动加载：' + (saved.path || ''), 6000);
          } else if (saved) {
            pushLog('图库包保存失败：' + (saved.error || ''));
          }
        } catch (e) { pushLog('图库包保存异常：' + ((e && e.message) || e)); }
      }
      btn.textContent = pack.doneText;
      syncShapeLibDownloadButtons();
      refreshShapeLibStoreUI(); // 下完让「图库已装载」与删除按钮立即可见
      render(); // 刷新所有卡片：缺图提示里的下载按钮随图库就位一并消失
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      toast('图库下载失败，请重试；多次失败可在「高级选项」里手动选择图库文件', 9000);
      pushLog('图库包下载失败：' + msg);
      btn.disabled = false;
      // 失败原因留在按钮上，别静默还原——用户至少要看到为什么没下成（点一下就是重试）
      btn.textContent = '下载失败，点这里重试';
      btn.title = msg;
    } finally {
      shapeDlProgressStop();
      shapeLibDlBusy = false;
      syncShapeLibDownloadButtons(); // 下完/失败都把按钮状态摆正（已安装就灰掉）
    }
  }

  (function initShapeLib() {
    const input = $('#shapeLibInput');
    const btn = $('#btnShapeLib');
    const dirInput = $('#shapeLibDirInput');
    const dirBtn = $('#btnShapeLibDir');
    if (btn && input) btn.addEventListener('click', () => input.click());
    // #282：<input type=file> 选不了文件夹，必须另开 webkitdirectory 的入口（Windows 文件对话框里没有「选文件夹」）
    if (dirBtn && dirInput) dirBtn.addEventListener('click', () => dirInput.click());
    /* 把手动选的图库 ZIP 存进 App 私有目录：以前只存在内存，重启就「图库包没读到」，
       用户只能重选或重下 32MB（截图上就是这个状态）。 */
    async function persistPickedLib(files) {
      const native = window.BrushNative;
      if (!native || typeof native.shapeLibSaveBegin !== 'function') return false;
      const list = Array.prototype.slice.call(files || []);
      if (list.length !== 1 || !/\.zip$/i.test(list[0].name || '')) {
        toast('图库已加载。想下次启动自动加载，请用图库 ZIP（文件夹/散图不保存）', 6000);
        return false;
      }
      try {
        const bytes = new Uint8Array(await list[0].arrayBuffer());
        if (!bytes.length) return false;
        // 和下载落盘共用同一份分块写入实现（nativePersistLibBytes）
        const ok = await nativePersistLibBytes(bytes, true);
        if (!ok) throw new Error('写入失败');
        toast('已保存到 App 内，下次启动自动加载（卸载会一并删除）', 5000);
        return true;
      } catch (e) {
        pushLog('保存图库到 App 内失败：' + ((e && e.message) || e));
        toast('图库已加载，但保存失败（下次启动需重选）：' + ((e && e.message) || e), 6000);
        return false;
      }
    }
    async function takeFiles(el) {
      if (isBusy()) { el.value = ''; toast('正在转换，稍后再加载图库', 5000); return; }
      const picked = el.target.files;
      /* R205-02：只有本次完整装载成功才落盘。以前只看 state.shapeLib 非空——
         已经加载过图库的用户再选一个坏 ZIP，半包替换内存图库后，原始坏包照样写进
         App 私有目录/程序目录，下次启动又把坏缓存恢复出来。 */
      const loaded = await loadShapeLibrary(picked);
      el.value = '';
      if (loaded && state.shapeLib && state.shapeLib.size) await persistPickedLib(picked);
    }
    if (input) input.addEventListener('change', takeFiles);
    if (dirInput) dirInput.addEventListener('change', takeFiles);
    updateShapeLibText();
    // 网页版 / 安卓 App / 桌面：选项区常驻两档下载按钮（原生壳靠 shapeLibUrl() 走站点绝对地址；桌面下完会自动存回程序目录）
    if (/^https?:/.test(location.protocol) || window.BrushNative || window.BrushDesktop) {
      const dlBtn = $('#btnShapeLibDownload');
      if (dlBtn) {
        dlBtn.hidden = false;
        dlBtn.dataset.label = dlBtn.textContent; // 原始文案：下载失败/取消后要还原
        dlBtn.addEventListener('click', function () { downloadShapeLibPack(dlBtn, SHAPE_LIB_PACKS.lite); });
      }
      const dlFull = $('#btnShapeLibDownloadFull');
      if (dlFull) {
        dlFull.hidden = false;
        /* 原图分 3 卷：空闲时先做一次 HEAD 预检（异步，不阻塞界面），
           拿到每卷体积与是否支持 Range，点击时就能立刻开下，少一次握手等待 */
        (function preflightLibrary() {
          const n = window.BrushNative;
          if (!n || typeof n.shapeLibPreflightAsync !== 'function') return;
          const urls = SHAPE_LIB_PACKS.full.parts.map(shapeLibUrl);
          try { n.shapeLibPreflightAsync(urls.join('|')); } catch (e) { return; }
          if (typeof n.shapeLibPreflightState !== 'function') return;
          let tries = 0;
          const poll = function () {
            tries++;
            let info = null;
            try { const raw = String(n.shapeLibPreflightState() || ''); if (raw) info = JSON.parse(raw); } catch (e) { /* 还没好 */ }
            if (!info || !(info.total > 0)) {
              if (tries < 8) setTimeout(poll, 700);
              return;
            }
            window.__shapeLibPreflight = info;
            const mb = (info.total / 1048576).toFixed(1);
            if (!shapeLibDlBusy && dlFull.dataset.label && dlFull.textContent === dlFull.dataset.label) {
              dlFull.textContent = '下载高清图库包（' + mb + 'MB）';
              dlFull.dataset.label = dlFull.textContent;
            }
            pushLog('图库预检：' + mb + 'MB，断点续传 ' + (info.ranges ? '可用' : '不可用（整卷重下）'));
          };
          setTimeout(poll, 500);
        })();
        dlFull.dataset.label = dlFull.textContent;
        dlFull.addEventListener('click', function () { downloadShapeLibPack(dlFull, SHAPE_LIB_PACKS.full); });
      }
      // 释放图库空间（用户问「卸载时要把图库一并卸载」——这里也能主动删）
      const clearBtn = $('#btnShapeLibClear');
      if (clearBtn) {
        clearBtn.addEventListener('click', async function () {
          const n = window.BrushNative;
          const desk = window.BrushDesktop;
          const canNative = !!(n && typeof n.shapeLibDownloadClear === 'function');
          const canDesk = !!(desk && typeof desk.clearShapeLib === 'function');
          if (!canNative && !canDesk) return;
          try {
            let ok = false;
            if (canNative) ok = Boolean(n.shapeLibDownloadClear());
            if (canDesk) {
              const r = await desk.clearShapeLib();
              if (r && r.ok) ok = true;
              else throw new Error((r && r.errors && r.errors[0]) || (r && r.error) || '删除失败');
              // 记住这次是用户主动删的：下次启动不要再自动下载
              setShapeLibUserCleared(true);
            }
            // App 数据里的缓存（可能是原图 216MB）也要删，不然「释放空间」是假的
            const cacheCleared = await ShapeLibStore.clear();
            if (ok || cacheCleared) {
              state.shapeLib = null;
              state.shapeLibPackKey = null;
              window.__shapeLibCacheText = null;
              // 原生侧已被叫停，这里把按钮文案也还原，别停在「下载中」
              shapeLibDlBusy = false;
              ['#btnShapeLibDownload', '#btnShapeLibDownloadFull'].forEach(function (sel) {
                const b = $(sel);
                if (!b) return;
                b.disabled = false;
                if (b.dataset && b.dataset.label) b.textContent = b.dataset.label;
              });
              // 安卓删完回落到当前安装包内置图库；桌面没有内置包，删完就是空着
              let fellBack = 0;
              if (canNative) {
                try {
                  const r = await loadBundledShapeLib();
                  fellBack = r && r.ok ? (r.count || 0) : 0;
                } catch (e) { /* 内置也没有就真的空着 */ }
              }
              updateShapeLibText();
              refreshShapeLibStoreUI();
              render();
              toast(fellBack > 0
                ? '已删除下载的图库和缓存，已加载安装包内置的' + (state.shapeLibPackKey === 'full' ? '原图' : '精简') + '图库（' + fellBack + ' 张）；内置部分随安装包保留'
                : '已删除图库和缓存（占用的空间已释放），下次要用再下载或导入', 6000);
            } else toast('删除失败：可能没有存储权限', 5000);
          } catch (e) { toast('删除失败：' + ((e && e.message) || e), 5000); }
        });
      }
    }
    refreshShapeLibStoreUI();
    // 桌面 / 安卓：图库包就在程序目录（或 APK 内置），启动就加载，用户什么都不用点（网页版要先下 32MB，改成用到才下）
    // 小包版 / 网页：如果上次下过精简图库（IndexedDB 缓存），直接恢复，不用每次重下 32MB
    async function restoreCachedShapeLib() {
      if (state.shapeLib) return;
      if (window.BrushDesktop) return; // 桌面走程序目录
      // An original library on disk or in the APK must win over an old lite
      // IndexedDB cache; otherwise an upgrade still reopens the lite library.
      try {
        const native = window.BrushNative;
        if (native && typeof native.shapeLibLength === 'function') {
          const bytes = Number(native.shapeLibLength());
          const original = bytes > 120 * 1048576;
          const custom = bytes > 0 && bytes !== 33146896 && typeof native.shapeLibSource === 'function' && native.shapeLibSource() === 'file';
          if (original || custom) return;
        }
      } catch (e) { /* a usable browser cache remains a fallback */ }
      try {
        // 原图档优先（用户下过原图就说明想要高清），其次精简档
        // 原图档不从 IndexedDB 恢复（太大）：它落在 App 私有目录里，启动时由 loadBundledShapeLib 读
        for (const key of ['lite']) {
          const cached = await ShapeLibStore.get(key);
          if (!cached) continue;
          const size = cached.size || cached.byteLength || 0;
          if (!size) continue;
          const name = key === 'full' ? SHAPE_LIB_PACKS.full.zipName : SHAPE_LIB_PACKS.lite.zipName;
          const file = new File([cached], name, { type: 'application/zip' });
          const loaded = await loadShapeLibrary([file], key === 'full' ? '上次下载的原图图库（已缓存）' : '上次下载的精简图库（已缓存）', false, true);
          if (loaded && state.shapeLib && state.shapeLib.size) {
            state.shapeLibPackKey = key;
            window.__shapeLibCacheText = 'App 数据已缓存下载过的图库（' + Math.round(size / 1048576) + 'MB，升级安装不丢，卸载一起删）';
            pushLog('启动时从 App 数据恢复图库 ' + key + '：' + state.shapeLib.size + ' 张 / ' + size + 'B');
            toast('已恢复上次下载的图库（' + state.shapeLib.size + ' 张），不用重新下载', 5000);
            return;
          }
        }
      } catch (e) { pushLog('恢复缓存图库失败：' + ((e && e.message) || e)); }
    }
    if (!state.shapeLib && (window.BrushDesktop || window.BrushNative)) {
      // 先看 App 数据里有没有用户下载过的图库（原图优先），没有再退回安装包内置的精简档
      restoreCachedShapeLib().then(function () {
        if (state.shapeLib) return null;
        return loadBundledShapeLib();
      }).then(function (r) {
        if (r && r.ok) pushLog('启动时已加载图库包 ' + r.count + ' 张');
      }).then(function () { refreshShapeLibStoreUI(); });
    } else {
      restoreCachedShapeLib().then(function () { refreshShapeLibStoreUI(); });
    }
    /* 导入笔刷/Activity 重建后：原生下载可能还在跑（现在是 static 状态），
       启动时先把界面接回去——否则用户看到的就是「下载被打断」。 */
    (function resumeNativeDownload() {
      const n = window.BrushNative;
      if (!n || typeof n.shapeLibDownloadStatus !== 'function') return;
      let st = 'idle';
      try { st = String(n.shapeLibDownloadStatus() || 'idle|0|-1').split('|')[0]; } catch (e) { return; }
      /* 【第181轮】done 不再"接管"。原生 dlState 是 static 的，下载完成（或覆盖安装）
         之后一直返回 done；旧代码把 done 也当未完成任务，于是每次启动都重新走一遍
         "接管→导入 216MB"，按钮还长期停在「下载中 141.0/32MB」（用户实测）。
         已完成就清掉原生状态直接返回——注意用 Abort（只清 .part）而不是 Clear（会删图库）。 */
      if (st === 'done') {
        try { if (typeof n.shapeLibDownloadAbort === 'function') n.shapeLibDownloadAbort(); } catch (e) { /* ignore */ }
        return;
      }
      if (st !== 'running') return;
      const dlBtn = $('#btnShapeLibDownloadFull') || $('#btnShapeLibDownload');
      if (!dlBtn) return;
      dlBtn.hidden = false;
      shapeLibDlBusy = true;
      const originalLabel = dlBtn.textContent;   // 接管失败时恢复，别把「下载中」留在界面上
      let resumed = false;
      (async function () {
        try {
          dlBtn.disabled = true;
          await nativeShapeLibDownload('', dlBtn, 0, true);
          dlBtn.textContent = '正在导入图库…';
          const got = await bundledShapeLibBytes();
          const recoveredPack = got.bytes.length > 120 * 1048576 ? SHAPE_LIB_PACKS.full : SHAPE_LIB_PACKS.lite;
          await loadShapeLibraryBytes(got.bytes, recoveredPack.label, false);
          state.shapeLibPackKey = recoveredPack.key;
          dlBtn.textContent = recoveredPack.doneText;
          resumed = true;
          toast('上次没下完的图库包已接上并完成（不用重新下载）', 5000);
          pushLog('启动时接管了未完成的图库下载：' + got.bytes.length + 'B');
        } catch (e) {
          pushLog('接管图库下载失败：' + ((e && e.message) || e));
        } finally {
          shapeLibDlBusy = false;
          if (dlBtn) dlBtn.disabled = false;
          /* 没接管成功就把按钮文案还原成进入前的样子，避免界面停在「下载中…」 */
          if (dlBtn && !resumed) dlBtn.textContent = originalLabel;
          refreshShapeLibStoreUI();
        }
      })();
    })();
  })();

  /* 手机竖屏：顶栏随上划逐渐收起（#307 / #308）
     —— 标题行和「转换并下载」始终钉住不动；
     —— 上面那层（「全选笔刷 / 参数对比」，data-nav-row=1）**先**消失，
        然后才是「分享保存 / 清空」（data-nav-row=2）；
     —— 跟手：进度 = 滚动位置的纯函数，起点只有 8px、180px 收完；触摸位移直接驱动（不等 scroll 事件）；
     —— 不重叠：每行只在自己的高度里收缩，不互相压盖；
     —— 收高与淡出同时进行（收高稍晚 15%），极端情况下允许行内裁剪，避免「卡一下再跳」。 */
  (function initMobileTopbarCollapse() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const rows = Array.prototype.slice.call(bar.querySelectorAll('.nav-row'));
    if (!rows.length) return;
    const mq = window.matchMedia ? window.matchMedia('(max-width: 640px)') : null;
    const isMobile = function () { return mq ? mq.matches : window.innerWidth <= 640; };
    const scrollTop = function () {
      const se = document.scrollingElement || document.documentElement;
      return (window.scrollY || window.pageYOffset || 0) || (se && se.scrollTop) || (document.body && document.body.scrollTop) || 0;
    };
    const clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
    // 收起顺序：行号小的先收（1 = 全选/参数对比 → 2 = 分享/清空）
    const order = rows.slice().sort(function (a, b) {
      return Number(a.getAttribute('data-nav-row') || 0) - Number(b.getAttribute('data-nav-row') || 0);
    });
    const START = 44, DIST = 300;   // 降低灵敏度：先划 44px 再开始收，300px 内收完（1:1 跟随）
    let bases = [];
    const resetRow = function (el) {
      el.style.height = '';
      el.style.opacity = '';
      el.style.transform = '';
      el.style.marginTop = '';
      el.style.pointerEvents = '';
    };
    const measure = function () {
      order.forEach(resetRow);
      if (!isMobile()) { bases = []; return; }
      bases = order.map(function (el) { return el.offsetHeight; });
      apply(scrollTop());
    };
    const apply = function (y) {
      if (!isMobile()) { order.forEach(resetRow); return; }
      const p = clamp01((y - START) / DIST);
      const n = order.length;
      order.forEach(function (el, i) {
        const from = i / n, span = 1 / n;
        const seg = clamp01((p - from) / span);
        /* 高度与滚动 1:1 收缩（滚多少收多少，最跟手），不位移所以不会压到下一行；
           透明度在每段前 40% 就归零，之后收的那截是透明的，基本看不到被裁的半截按钮。 */
        const fade = clamp01(seg / 0.4);
        const h = bases[i] || 0;
        el.style.opacity = String(1 - fade);
        el.style.transform = 'none';
        el.style.height = (h * (1 - seg)).toFixed(1) + 'px';
        el.style.marginTop = (8 * (1 - seg)).toFixed(1) + 'px';
        el.style.pointerEvents = fade > 0.5 ? 'none' : '';
      });
    };
    measure();
    window.addEventListener('load', measure);            // 字体/布局就绪后校准
    window.addEventListener('orientationchange', measure);
    if (mq && mq.addEventListener) mq.addEventListener('change', measure);
    else window.addEventListener('resize', measure);
    let ticking = false;
    let virtY = 0;
    const onScroll = function () {
      if (ticking) return;
      ticking = true;
      (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () {
        ticking = false;
        const y = scrollTop();
        // 安卓/夸克：滚动时 scrollY 可能一直是 0；这种情况下不要用它把触摸累积量冲掉
        if (y > 0 || virtY === 0) virtY = y;
        apply(virtY);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    /* 触摸位移直接驱动进度（不等 scroll 事件），保证「跟手」 */
    let touchY = 0;
    window.addEventListener('touchstart', function (e) {
      if (!isMobile() || !e.touches || !e.touches.length) return;
      touchY = e.touches[0].clientY;
      virtY = Math.max(virtY, scrollTop());
    }, { passive: true });
    window.addEventListener('touchmove', function (e) {
      if (!isMobile() || !e.touches || !e.touches.length) return;
      const dy = touchY - e.touches[0].clientY;     // >0 = 手指上移 = 向下翻内容
      touchY = e.touches[0].clientY;
      if (!dy) return;
      const st = scrollTop();
      virtY = Math.max(0, (st > 0 ? st : virtY) + dy);
      apply(virtY);
    }, { passive: true });
    apply(scrollTop());
  })();

  /* SAI2 笔刷文件夹：桌面版启动时检测一次，按钮可重新检测/手动指定 */
  (function initSai2DirUi() {
    if (!sai2Desktop()) return;
    const el = sai2DirEls();
    if (el.detect) el.detect.addEventListener('click', function () { refreshSai2Folder(); });
    if (el.choose) el.choose.addEventListener('click', function () { chooseSai2Folder(); });
    refreshSai2Folder();
  })();

  /* 画世界内置笔尖库：设置区按钮 + 首次状态渲染 */
  (function initHsjLibUi() {
    renderHsjLibState();
    const btn = document.getElementById('btnHsjDownload');
    if (!btn) return;
    btn.addEventListener('click', function () { downloadHsjLib(btn); });
    /* 已内置的包直接置 ready，省得用户白点 */
    if (BC.hsjShapes) { hsjLibState = 'ready'; renderHsjLibState(); return; }
    if (typeof ShapeLibStore !== 'undefined' && ShapeLibStore && typeof ShapeLibStore.get === 'function') {
      ShapeLibStore.get(HSJ_LIB_KEY).then(function (cached) {
        if (!cached || BC.hsjShapes) return;
        return loadHsjFromBlob(cached).then(function (ok) {
          if (ok) {
            hsjLibState = 'ready';
            renderHsjLibState();
            if (typeof backfillHsjShapesInFiles === 'function') backfillHsjShapesInFiles();
          }
        });
      }).catch(function () { /* 忽略缓存读取异常 */ });
    }
  })();

  /* 【第187轮】纹理库初始化：随 App 内置的包直接置 ready；只有 IndexedDB 里已有缓存时才
     静默载入。31MB 一律不主动联网——必须用户自己点按钮，避免开页面就吃流量。 */
  (function initHsjTextures() {
    const btn = document.getElementById('btnHsjTexDownload');
    if (!btn) return;
    btn.addEventListener('click', function () { downloadHsjTexLib(btn); });
    if (BC.hsjTextures) { hsjTexState = 'ready'; renderHsjTexState(); return; }
    if (typeof ShapeLibStore !== 'undefined' && ShapeLibStore && typeof ShapeLibStore.get === 'function') {
      ShapeLibStore.get(HSJ_TEX_KEY).then(function (cached) {
        if (!cached || BC.hsjTextures) return;
        return loadScriptFromBytes(cached).then(function () {
          if (BC.hsjTextures) { hsjTexState = 'ready'; renderHsjTexState(); }
        });
      }).catch(function () { /* 忽略缓存读取异常 */ });
    }
  })();

  /* ---------- 设置分组（第197轮）----------
     高级设置里的「格式专属」面板跟随目标格式显示；两个折叠组标题右侧显示当前取值摘要；
     改过默认值的组标「已改 N 项」，底部「恢复默认」。只改显示，不改任何选项的 id 与取值。 */
  (function initOptionGroups() {
    const root = $('#options');
    const target = $('#optTarget');
    if (!root || !target) return;
    // 参与计数/恢复默认的设置项；目标格式本身不算
    const fields = Array.prototype.slice.call(root.querySelectorAll('select[id^="opt"], input[id^="opt"]'))
      .filter(function (el) { return el.id !== 'optTarget'; });
    function defaultOf(el) {
      if (el.tagName === 'SELECT') {
        for (let i = 0; i < el.options.length; i++) if (el.options[i].defaultSelected) return el.options[i].value;
        return el.options.length ? el.options[0].value : '';
      }
      return el.defaultValue;
    }
    const defaults = new Map(fields.map(function (el) { return [el, defaultOf(el)]; }));
    function isChanged(el) { return el.value !== defaults.get(el); }
    function shortText(id) {
      const el = document.getElementById(id);
      if (!el || el.selectedIndex < 0) return '';
      return el.options[el.selectedIndex].text.replace(/[（(].*$/, '').trim();
    }
    function setHidden(el, hide) { if (el && el.hidden !== hide) el.hidden = hide; }
    function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }

    function update() {
      const t = target.value;
      const names = [];
      root.querySelectorAll('.fmt-panel').forEach(function (p) {
        const wanted = (p.getAttribute('data-for') || '').split(/\s+/).indexOf(t) >= 0;
        // 面板里的行可能被别处隐藏（如 SAI2 文件夹只在桌面版出现）；一行都不显示时整块不显示
        let anyRow = false;
        p.querySelectorAll('.opt-row > .opt').forEach(function (r) { if (!r.hidden) anyRow = true; });
        const show = wanted && anyRow;
        setHidden(p, !show);
        if (show) names.push(p.querySelector('.fmt-title').textContent.replace(/\s*专属$/, ''));
      });
      setHidden($('#fmtNone'), names.length > 0);

      // 「按来源分文件夹」只在每支单独文件时生效
      const single = $('#optMode') && $('#optMode').value === 'single';
      const grp = $('#optGroup');
      if (grp) {
        grp.dataset.depOff = single ? '' : '1';
        grp.disabled = !single || isBusy();
      }
      setHidden($('#optGroupHint'), !!single);

      setText($('#advSum'), (names.length ? names.join(' / ') + ' 专属 · ' : '') + '还原与近似 · 素材库');
      setText($('#outSum'), [shortText('optMode'), shortText('optPack'), shortText('optBatchN')].filter(Boolean).join(' · '));

      root.querySelectorAll('.opt-group').forEach(function (g) {
        const n = fields.filter(function (el) { return g.contains(el) && isChanged(el); }).length;
        const badge = g.querySelector('.og-changed');
        setText(badge, '已改 ' + n + ' 项');
        setHidden(badge, n === 0);
      });
      const total = fields.filter(isChanged).length;
      setText($('#optChangedText'), '有 ' + total + ' 项不是默认值');
      setHidden($('#optFoot'), total === 0);
    }

    const reset = $('#btnOptReset');
    if (reset) reset.addEventListener('click', function () {
      if (isBusy()) return;
      fields.forEach(function (el) {
        if (!isChanged(el)) return;
        el.value = defaults.get(el);
        // 让 app.js 里监听这些选项的逻辑（按钮文案、预检等）跟着刷新
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      update();
      toast('已恢复默认设置');
    });
    root.addEventListener('change', update);
    root.addEventListener('input', update);
    // 其它代码切换某行的 hidden（SAI2 文件夹/列表）时同步面板；update 只在值变化时才写，不会自激
    if (typeof MutationObserver === 'function') {
      new MutationObserver(update).observe(root, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
    }
    update();
  })();

  $('#ver').textContent = 'v' + APP_VERSION;
  render();
})();
