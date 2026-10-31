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
    importToken: 0, importing: 0, lastWarnings: [] };
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
      if (audit && (audit.noTip.length || audit.grainOnly.length) && el.style.display !== 'none') {
        const parts = [];
        if (audit.noTip.length) parts.push(audit.noTip.length + ' 支没有笔尖(shape)图、会用参数生成笔尖');
        if (audit.grainOnly.length) parts.push(audit.grainOnly.length + ' 支只有纹理(grain)图当笔尖');
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
    document.querySelectorAll('#options input, #options select').forEach(function (el) { el.disabled=busy; });
    filesEl.classList.toggle('locked', busy);
    // 转换/保存期间卡片内的勾选框也要禁用：pointer-events 只挡鼠标，Tab+空格仍能改状态，
    // 会让输出结果随按键漂移（#259）。
    filesEl.querySelectorAll('input').forEach(function (el) { el.disabled = busy; });
    dz.setAttribute('aria-disabled', String(busy));
    btnConvert.textContent = total
      ? outText + '（已选 ' + total + ' 支 · ' + fmtLabel + '）'
      : (allBrushes.length ? '请至少勾选 1 支笔刷' : outText);
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
    if (b.hasGrain) tags.push('<span class="tag gray">纹理略</span>');
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
    toggle.querySelector('input').disabled = isBusy();
    toggle.querySelector('input').onchange = e => {
      b.enabled = e.target.checked;
      item.classList.toggle('off', !e.target.checked);
      updateConvertButton();
      refreshSelAllLabel();
    };
    item.appendChild(tipCv);
    item.appendChild(info);
    item.appendChild(toggle);
    const uiKey = (rec.pkgId || ('f' + fi)) + ':' + bi;
    state.__brushUI.set(uiKey, { item: item, input: toggle.querySelector('input'), brush: b });
    return item;
  }

  function appendBrushItems(grid, rec, fi, start, count) {
    const end = Math.min(rec.brushes.length, start + count);
    for (let bi = start; bi < end; bi++) grid.appendChild(makeBrushItem(rec, rec.brushes[bi], bi, fi));
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

    state.files.forEach((rec, fi) => {
      const card = document.createElement('div');
      card.className = 'file-card card';
      const head = document.createElement('div');
      head.className = 'file-head';
      head.innerHTML = `
        <div class="fname" title="${esc(rec.name)}">${esc(rec.name)}</div>
        <div class="badge ${rec.error ? 'err' : (rec.kind || 'parsing')}">${rec.error ? '无法识别' : (rec.kind ? (rec.kindLabel || rec.kind) : (rec.parsing ? '解析中…' : '待解析'))}</div>
        <div class="fmeta">${rec.sizeBytes ? fmtSize(rec.sizeBytes) : (rec.bytes ? fmtSize(rec.bytes.length) : '')}</div>
        <div class="fmeta">${rec.brushes ? rec.brushes.length + ' 支笔刷' : (rec.error ? '出错' : '解析中…')}${rec.parseMs ? ' · ' + (rec.parseMs >= 1000 ? (rec.parseMs / 1000).toFixed(1) + 's' : rec.parseMs + 'ms') : ''}</div>
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
        rec.brushes.forEach(b => { b.enabled = true; });
        syncSelectionUI();
      };
      if (head.querySelector('.selnone')) head.querySelector('.selnone').onclick = () => {
        rec.brushes.forEach(b => { b.enabled = false; });
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
        const grid = document.createElement('div');
        grid.className = 'grid';
        const LIMIT = 60;
        // #273：展开状态记在记录上，任何 render（改目标格式、勾选等）都不会把它折叠回 60 支
        let shown = Math.max(LIMIT, Math.min(rec.brushes.length, rec._shown || LIMIT));
        appendBrushItems(grid, rec, fi, 0, shown);
        card.appendChild(grid);
        if (rec.brushes.length > shown) {
          const more = document.createElement('button');
          more.className = 'btn ghost show-more';
          const upd = function () {
            more.textContent = '显示更多（已显示 ' + shown + ' / ' + rec.brushes.length + ' 支）';
            if (shown >= rec.brushes.length) more.style.display = 'none';
          };
          upd();
          more.onclick = function () {
            const next = Math.min(rec.brushes.length, shown + 80);
            appendBrushItems(grid, rec, fi, shown, next - shown);
            shown = next;
            rec._shown = next;
            upd();
          };
          card.appendChild(more);
        }
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
    rec.sizeBytes = bytes ? bytes.length : 0;
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
    rec.parseName = displayName || rec.name;
    // 原始字节只在解析时需要：释放它，几百支的批量解析能省下大量内存。
    // 例外：Procreate 包里有「引用了内置 shape 但包里没这张图」的笔刷时留一份，
    // 这样用户之后才加载内置笔尖图库时能立刻原地补回（#282），不必重新导入。
    const waitingShape = parsed.kind === 'procreate' && parsed.brushes.some(function (b) { return !b.tip && b.bundledShapePath; });
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
  function parseViaWorker(name, bytes, opts) {
    return new Promise(function (resolve, reject) {
      if (!window.Worker || workerBroken) return reject(new Error('worker unavailable'));
      try {
        if (!worker) worker = new Worker(workerUrl());
      } catch (e) { workerBroken = true; return reject(e); }
      const id = ++workerSeq;
      const timer = setTimeout(function () { cleanup(); reject(new Error('worker timeout')); }, 180000);
      function cleanup() {
        clearTimeout(timer);
        worker.removeEventListener('message', onMsg);
        worker.removeEventListener('error', onErr);
      }
      function onMsg(ev) {
        const m = ev.data || {};
        if (m.id !== id) return;
        cleanup();
        if (m.ok) resolve(m.result); else reject(new Error(m.error || '解析失败'));
      }
      function onErr(ev) {
        cleanup();
        workerBroken = true;
        try { worker.terminate(); } catch (e) { /* ignore */ }
        worker = null;
        reject(new Error('worker error: ' + (ev.message || 'unknown')));
      }
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', onErr);
      const copy = bytes.slice ? bytes.slice() : new Uint8Array(bytes);
      worker.postMessage({ id: id, name: name, bytes: copy, opts: opts || {} }, [copy.buffer]);
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

  async function parseRecord(rec, displayName, bytes, opts) {
    try {
      // 内置笔尖图库只存在于主线程内存里，Worker 拿不到；加载了图库就不走后台解析
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
          const parsed = await parseViaWorker(displayName, bytes, opts);
          setProgress(null);
          adoptParsed(rec, bytes, parsed, displayName);
          return;
        } catch (e) {
          // #266：以前这里静默回退，用户盯着「后台解析」几分钟后界面又冻结却不知道发生了什么。
          pushLog('WORKER 回退：' + (e && e.message ? e.message : e));
          toast('后台解析未能完成，已改为主线程重新解析（大文件会短暂卡顿）：' + friendlyError(e && e.message ? e.message : e), 9000);
        }
        setProgress(null);
      }
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
      rec.error = friendlyError(e.message);
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
      // #267：全站错误都走 friendlyError，唯独 ZIP 把裸英文丢给用户
      rec.error = friendlyError(e && e.message ? e.message : e) || '压缩包解析失败';
      rec.kindLabel = '压缩包';
      render();
      return 0;
    }
    let added = 0;
    for (const inner of res.files) {
      const rec = makeRecord(name + ' / ' + inner.name, inner.bytes);
      const innerOpts = inner.decrypted ? { decrypted: inner.decrypted } : null;
      // 大文件会走 Worker/异步分块解析：必须 await 后重新 render，否则卡片停在「解析中」
      // 且首次导入时转换按钮一直禁用。
      rec.parsing = true;
      render();
      await parseRecord(rec, inner.name, inner.bytes, innerOpts);
      rec.parsing = false;
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
    if (!arr.length) return;
    // #262 导入中再拖/再选：不静默失败，也不允许两批交错塞卡片
    if (isImporting() || isBusy()) { toast(isBusy() ? '正在转换，完成后再添加文件' : '正在导入上一个文件，稍等'); return; }
    const token = ++state.importToken;
    state.importing++;
    updateConvertButton();
    try {
    for (const f of arr) {
      // #262 用户点了「清空」/单卡✕：token 变了就停手，不再往新列表里 push
      if (token !== state.importToken) break;
      let rec = null;
      try {
        const bytes = await readFileBytes(f).catch(function (e) { return null; });
        if (!bytes) {
          rec = makeRecord(f.name, null);
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
            await addZip(f.name, bytes, 0);
            setProgress(null);
          } catch (e) {
            rec = makeRecord(f.name, null);
            rec.error = friendlyError(e.message) || '压缩包解析失败';
            render();
          }
          continue;
        }
        // 先建卡片再解析：大文件解析要一会儿，界面能立刻看到进度
        rec = makeRecord(f.name, null);
        rec.sizeBytes = bytes.length;
        rec.parsing = true;
        render();
        await sleep(0);
        if (!kind) {
          rec.parsing = false;
          rec.error = '无法识别的文件格式（支持 .abr/.bru/.brush/.brushset/.sut/.mtd/.gobrush/.gbr/.gih/.myb/.kpp/.bundle/.brushcategory、toolnrm 等，或包含笔刷的 ZIP）';
          render();
          continue;
        }
        const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        setProgress(null, '解析中：' + f.name + (mb > 100 ? '（大文件，请稍候…）' : ''));
        await sleep(0);
        await parseRecord(rec, f.name, bytes, opts);
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
    const bruTexAsset = $('#optBruTex') ? $('#optBruTex').value : 'off';
    const bruDensity = $('#optBruDensity') ? $('#optBruDensity').value : 'auto';
    const scatterScale = $('#optScatterScale') ? Number($('#optScatterScale').value) / 100 : 0.15;
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
      case 'udongman': return '优动漫笔刷';
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
    // ABR 目标：把源笔刷的真实纹理导出为 PNG，用户可在 PS「编辑→定义图案」后手动指定（可调纹理）
    if (opts.target === 'abr' || opts.target === 'all') {
      try {
        const seenTex = {};
        const textureNames = new Set();
        let texIndex = 0;
        for (const rec of records) {
          const list = rec.brushes || [];
          for (const b of list) {
            if (!b || b.enabled === false || !b.hasTexture) continue;
            const tex = BC.convert.makeTexturePng(b);
            if (!tex) continue;
            const key = tex.w + 'x' + tex.h + ':' + BC.util.md5(tex.bytes);
            if (seenTex[key]) continue;
            seenTex[key] = 1;
            texIndex++;
            const texBase = BC.convert.sanitizeName(b.name, texIndex - 1).slice(0, 54) + '_纹理';
            let texName = texBase, suffix = 2;
            while (textureNames.has(texName.toLowerCase())) texName = texBase + ' (' + suffix++ + ')';
            textureNames.add(texName.toLowerCase());
            outFiles.push({ name: texName + '.png', data: tex.bytes });
          }
        }
        if (texIndex) warnings.push('已导出 ' + texIndex + ' 张纹理 PNG：在 PS 里「编辑→定义图案」后可手动指定给画笔纹理（可调深度/缩放）');
      } catch (e) { warnings.push('纹理导出失败：' + e.message); }
    }
    let commonPat = null;
    // 图案文件模式：所有带纹理笔刷的纹理去重后打成**一个**多图案 .pat，
    // ABR 里每支笔刷引用各自纹理对应的图案 id
    let commonPatRefs = null;
    if (opts.textureMode === 'pattern' && (opts.target === 'abr' || opts.target === 'all')) {
      try {
        const texBrushes = [];
        for (const rec of records) {
          for (const b of rec.brushes) {
            if (b && b.enabled !== false && b.hasTexture) texBrushes.push(b);
          }
        }
        if (!texBrushes.length) {
          warnings.push('本次没有带纹理的笔刷，未生成 .pat（普通笔刷只需 .abr）');
        } else {
          const pat = BC.convert.makePatternFile(texBrushes, { size: 256 });
          commonPatRefs = pat.refs;
          outFiles.push({ name: '纹理图案_导入PS图案面板.pat', data: pat.bytes });
          warnings.push('已生成含 ' + pat.count + ' 张纹理的 .pat：先在 PS 图案面板导入它，再导入 ABR，纹理才可调');
        }
      } catch (e) { warnings.push('图案生成失败：' + e.message); }
    }
    // 纹理丢失提示：ABR 源保留纹理引用但本次没带 .pat 时，目标 PS 没有同名图案就会没纹理
    if ((opts.target === 'abr' || opts.target === 'all') && opts.textureMode !== 'pattern') {
      let refCount = 0;
      for (const rec of records) {
        for (const b of rec.brushes) {
          if (b && b.enabled !== false && b.hasTexture && (b.source === 'abr' || b._rawPreset)) refCount++;
        }
      }
      if (refCount > 0) warnings.push('ABR 里保留了 ' + refCount + ' 支笔刷的纹理引用：目标 Photoshop 需要先有同名图案，否则纹理不显示（高级设置改「纹理处理=图案文件」可自动附带 .pat）');
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
    const ALL_FORMATS = ['bru', 'abr', 'udongman', 'gopaint', 'gopaint_set', 'gopaint_abr', 'brushset', 'brush', 'gbr', 'gih',
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
        textureMode: opts.textureMode === 'pattern' ? 'pattern' : undefined,
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
      if (opts.dualCompanion !== false && targets.indexOf('bru') >= 0) {
        const dualList = list.filter(function (b) { return b.dualOn; });
        if (dualList.length) {
          try {
            const made = BC.convert.makeAbrPack(dualList, Object.assign({}, commonOpts(rec), { maxTipSize: opts.tipSize }));
            // 多个输入文件各带双笔刷时，固定文件名会在 ZIP 里产生重复条目；
            // 这里走 uniqueFile，并按前缀/分组命名，避免互相覆盖。
            const compFolder = opts.groupBySource && rec.baseName ? BC.convert.sanitizeName(rec.baseName, 0) + '/' : '';
            const compBase = compFolder + BC.convert.sanitizeName((opts.prefix || '') + '双笔刷_可直接导入画世界Pro3.0', 0);
            outFiles.push({ name: uniqueFile(compBase, '.abr'), data: made.bytes });
            warnings.push('含 ' + dualList.length + ' 支双笔刷：已额外附带 .abr（画世界Pro 3.0 可直接导入，保留原生双重笔刷）');
          } catch (e) { warnings.push('双笔刷 ABR 附带失败：' + e.message); }
        }
      }
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
            } else if (fmt === 'mbini') {
              for (const b of list) {
                const made = BC.convert.makeMediBangIniPack([b], commonOpts(rec));
                const bname = BC.convert.sanitizeName(opts.prefix + (b.name || 'medibang'), 0);
                outFiles.push({ name: uniqueFile(bname + '_MediBang云笔刷', '.zip'), data: made.bytes });
              }
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
            } else if (fmt === 'udongman') {
              const made = BC.convert.makeUdongmanPack(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base + '_优动漫', '.abr'), data: made.bytes });
              outFiles.push({ name: uniqueFile(base + '_优动漫导入说明', '.txt'), data: BC.util.utf8Encode(made.importGuide) });
              warnings.push(...made.warnings);
            } else if (fmt === 'udongman_sut') {
              const made = BC.convert.makeUdongmanSutPack(list, commonOpts(rec));
              const dir = base + '_优动漫SUT/';
              for (const f of made.files) outFiles.push({ name: dir + f.name, data: f.data });
              outFiles.push({ name: uniqueFile(base + '_优动漫SUT导入说明', '.txt'), data: BC.util.utf8Encode(made.importGuide) });
              warnings.push(...made.warnings);
            } else if (fmt === 'udongman_mtd') {
              const made = BC.convert.makeUdongmanMtdPack(list, commonOpts(rec));
              outFiles.push({ name: uniqueFile(base, '.mtd'), data: made.bytes });
              outFiles.push({ name: uniqueFile(base + '_优动漫MTD导入说明', '.txt'), data: BC.util.utf8Encode(made.importGuide) });
              warnings.push(...made.warnings);
            } else if (fmt === 'abr') {
              // 源就是 .abr 且整包导出时：原样透传，100% 保留文件夹分组 / 动态 / 计算画笔
              const isAbrSource = /^abr$/i.test(rec.kind || '') || /\.abr$/i.test(rec.name || '');
              const allSelected = rec.brushes && list.length === rec.brushes.length;
              const unchangedSettings=opts.sizeScale===1 && !(opts.spacingOverride>0) && opts.pressureMode==='auto' && opts.fidelity!==false;
              const unchangedBrushes=list.every(function(b){return b._rawBrushState && b._rawBrushState===BC.util.brushFingerprint(b);});
              if (isAbrSource && allSelected && unchangedSettings && unchangedBrushes) {
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
            if (fmt === 'bru' && opts.bruEmbed !== false && b.dualTip && BC.convert.makeBru) {
              const made = BC.convert.makeBru(b, Object.assign({}, co, { embedSubTip: true }));
              outFiles.push({ name: folder + uniqueFile(base, '.bru'), data: made.bytes });
              warnings.push(b.dualOn ? '双笔刷已按画世界原生 3.0 单支内嵌副笔尖写出（一个文件=一支笔刷）' : '已内嵌缓存副笔尖，双笔刷保持关闭');
              continue;
            }
            if (fmt === 'bru' && opts.dualPair !== false && b.dualOn && b.dualTip && BC.convert.makeBruDualPair) {
              const pair = BC.convert.makeBruDualPair(b, co);
              if (pair) {
                outFiles.push({ name: folder + uniqueFile(base + '_双笔刷对', '.bru'), data: pair.bytes });
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
              : fmt === 'gopaint' ? BC.convert.makeGoPaintBrush(b, co)
              : fmt === 'gopaint_abr' ? BC.convert.makeGoPaintAbr([b], co)
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
            outFiles.push({ name: folder + uniqueFile(base, extOut), data: made.bytes });
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

    setProgress(0.99, opts.packOut === false ? '正在保存文件…' : '正在准备输出文件…');
    await sleep(10);
    const onlyAux = outFiles.length > 0 && outFiles.every(function (f) {
      return /^(安装\/|转换报告\.txt$|参数对比\.html$|纹理图案_|优动漫导入说明\.txt$|优动漫SUT导入说明\.txt$|优动漫MTD导入说明\.txt$|.*_优动漫导入说明\.txt$|.*_参数\.txt$)/.test(f.name);
    });
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
    if (opts.packOut === false) {
      payload = outFiles;
    } else {
      // 默认（整包）模式：只有一个笔刷文件时直接输出该文件本身（.abr/.brushset/.bru…），
      // 不再套一层 ZIP 壳，导入软件前不用先解压；随附的导入说明等小文件一起直接输出。
      // 只有多个笔刷文件（如全部格式/单独文件模式/多输入合并）才打包 ZIP。
      const isAuxOut = function (f) {
        return /^(安装\/|转换报告\.txt$|参数对比\.html$|纹理图案_|优动漫导入说明\.txt$|.*_优动漫导入说明\.txt$|优动漫SUT导入说明\.txt$|优动漫MTD导入说明\.txt$|.*_参数\.txt$)/.test(f.name);
      };
      const brushOut = outFiles.filter(function (f) { return !isAuxOut(f); });
      const mobileWeb = !window.BrushNative && !window.BrushDesktop && window.BCSaver &&
        window.BCSaver.isMobileBrowser && window.BCSaver.isMobileBrowser();
      if (brushOut.length === 1 && !onlyAux && !mobileWeb) {
        payload = outFiles.slice();
      } else {
      const ts = new Date();
      const pad = n => String(n).padStart(2, '0');
      const stamp = ts.getFullYear() + pad(ts.getMonth() + 1) + pad(ts.getDate()) + '_' + pad(ts.getHours()) + pad(ts.getMinutes());
      const bundleName = outputBundleLabel(opts.target);
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
          return { name: bundleName + '_' + stamp + '_' + (i + 1) + 'of' + vols.length + '.zip', data: BC.zip.write(files) };
        });
        warnings.push('输出较大，已自动分成 ' + vols.length + ' 个 ZIP（每卷约 120MB）');
      } else {
        payload = [{ name: bundleName + '_' + stamp + '.zip', data: BC.zip.write(outFiles) }];
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
    // 同名 ZIP 加序号
    const seen = new Map();
    all.forEach(function (f) {
      const key = f.name;
      const k = (seen.get(key) || 0) + 1;
      seen.set(key, k);
      if (k > 1) {
        const m = f.name.match(/^(.*?)(\.[^.]+)$/);
        if (m) f.name = m[1] + '_' + k + m[2];
      }
    });
    const warns = [];
    let done = 0, failedCount = 0, files = 0;
    sink.forEach(function (r) {
      r.warnings.forEach(function (w) { if (warns.indexOf(w) < 0) warns.push(w); });
      done += r.doneCount || 0;
      failedCount += (r.failed || []).length;
      files += r.fileCount || 0;
    });
    if (warns.length) toast(warns[0], 6000);
    state.converting = false;
    setProgress(null);
    render();
    try {
      const packOutMode = $('#optPack') ? $('#optPack').value !== 'files' : true;
      let outAll = all;
      // 打包模式下多批结果合并：只有 1 个笔刷文件时直接输出该文件本身（与单批一致）；
      // 多个文件重新打成一个 ZIP，保持「打包」语义。
      if (packOutMode && all.length > 1) {
        const ts = new Date();
        const pad = n => String(n).padStart(2, '0');
        const stamp = ts.getFullYear() + pad(ts.getMonth() + 1) + pad(ts.getDate()) + '_' + pad(ts.getHours()) + pad(ts.getMinutes());
        const bundleName = outputBundleLabel($('#optTarget') ? $('#optTarget').value : '');
        outAll = [{ name: bundleName + '_' + stamp + '.zip', data: BC.zip.write(all) }];
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

  /* ---------------- 首次打开公告弹窗 ---------------- */
  const APP_VERSION = '2.6.21';
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
        if (f) out.push(f);
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
  (async function checkVersion() {
    // 安卓 App 跑在 file:///android_asset 下，fetch 本地文件会报 “URL scheme file is not supported”，直接跳过
    if (window.BrushNative) return;
    try {
      const r = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.version && j.version !== APP_VERSION) toast('发现新版本 ' + j.version + '（当前 ' + APP_VERSION + '），刷新页面即可更新', 8000);
    } catch (e) { /* 离线/本地文件忽略 */ }
  })();
  const btnShare = $('#btnShare');
  const btnShareResult = $('#btnShareResult');
  [btnShare, btnShareResult].filter(Boolean).forEach(function (button) {
    if (!(navigator.canShare && navigator.share)) { button.style.display = 'none'; return; }
    button.hidden = false;
    button.addEventListener('click', async function () {
      if (!lastSavedFiles || !lastSavedFiles.length) { toast('还没有可分享的转换结果'); return; }
      try {
        if (!preparedShare) { toast('这个浏览器不支持分享，请点「下载ZIP」', 3000); return; }
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
  function updateShapeLibText() {
    const el = $('#shapeLibText');
    if (!el) return;
    if (state.shapeLib && state.shapeLib.size) {
      const label = state.shapeLibLabel || (state.shapeLibBuiltIn ? '内置图库包' : '自选图库');
      const mb = state.shapeLibBytes ? ' · ' + Math.round(state.shapeLibBytes / 1048576) + 'MB' : '';
      el.textContent = (state.shapeLibBuiltIn ? '图库包已加载：' : '已加载 ') + state.shapeLib.size + ' 张' + mb +
        '（' + label + '）；缺 shape 的笔刷已按内置资源名补回真图';
    } else {
      // 安卓壳 / 网页版都能直接下（安卓壳走站点绝对地址），把入口写在提示里，别让用户找按钮
      const canDownload = window.BrushNative || window.BrushDesktop || /^https?:/.test(location.protocol);
      if (state.shapeLibBuiltIn === false && state.shapeLibError) {
        el.textContent = canDownload
          ? '图库包没读到（' + state.shapeLibError + '）：点下面「下载图库包（精简512 · 32MB）」或「原图高清 216MB」，也可以手动选图库文件夹'
          : '图库包没读到（' + state.shapeLibError + '）：可以点「选择图库文件夹」手动指定';
      } else {
        el.textContent = canDownload
          ? '未加载：缺图时只能用合成圆头。可点下面两档下载：精简512（32MB）或原图高清（216MB）'
          : '未加载：把「Procreate 内置笔尖图库」的 zip 放到程序旁边，或点「选择图库 ZIP / 图片」';
      }
    }
  }
  /* ===== 内置笔尖图库包（单独分发，不塞进安装包）=====
     资源包来自 assets/shape-lib.zip（精简 512）或另做的「原图」包：292 张 Procreate IPA 内置 Shape。
     桌面版启动时去程序目录找这个 zip（主进程读文件 → IPC 传字节），找不到就等用户手动选。
     内存策略见 loadShapeLibrary：只留原始字节，core 用到才解码。 */
  let bundledLoading = null;
  function shapeLibFromZipBytes(bytes) {
    const map = new Map();
    let index = null;
    const entries = BC.zip.read(new Uint8Array(bytes));
    for (const e of entries) {
      const base = String(e.name || '').split(/[\\/]/).pop().toLowerCase();
      if (base === 'index.json') {
        try { index = JSON.parse(BC.util.utf8Decode(e.data())); } catch (err) { index = null; }
        continue;
      }
      if (!/\.(png|jpe?g)$/i.test(base)) continue;
      map.set(base, e.data());
    }
    return { map: map, index: index };
  }
  async function bundledShapeLibBytes() {
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
        const CHUNK = 3 * 1024 * 1024;
        for (let off = 0; off < total; off += CHUNK) {
          const b64 = native.shapeLibChunk(off, Math.min(CHUNK, total - off));
          if (!b64) throw new Error('内置图库分块读取失败（offset ' + off + '）');
          const bin = atob(b64);
          const n = Math.min(bin.length, total - off);
          for (let i = 0; i < n; i++) bytes[off + i] = bin.charCodeAt(i);
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
    }
    if (typeof fetch === 'function') {
      // 网页版：同源 shape-lib.zip；安卓/桌面（file:// 壳）：本地取不到时改从站点拉
      const urls = ['shape-lib.zip'];
      if (window.BrushNative || window.BrushDesktop) urls.push(SITE_BASE + 'shape-lib.zip');
      let lastErr = null;
      for (const u of urls) {
        try {
          const res = await fetch(u, { cache: 'force-cache' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return { bytes: new Uint8Array(await res.arrayBuffer()), name: 'shape-lib.zip', path: u };
        } catch (e) { lastErr = e; }
      }
      throw (lastErr || new Error('图库包下载失败'));
    }
    throw new Error('当前环境读不到内置图库');
  }
  async function loadBundledShapeLib(opts) {
    if (bundledLoading) return bundledLoading;
    bundledLoading = (async function () {
      try {
        if (opts && opts.onStart) opts.onStart();
        const got = await bundledShapeLibBytes();
        const parsed = shapeLibFromZipBytes(got.bytes);
        const map = parsed.map;
        if (!map.size) throw new Error('内置图库为空');
        const idx = parsed.index || {};
        const variant = idx.variant === 'original' ? '原始分辨率' : (idx.maxEdge ? idx.maxEdge + 'px 精简' : '');
        state.shapeLib = map;
        state.shapeLibBuiltIn = true;
        state.shapeLibLabel = [got.name || '图库包', variant].filter(Boolean).join(' · ');
        state.shapeLibBytes = got.bytes.length;
        updateShapeLibText();
        const fixed = await reparseWithShapeLib();
        pushLog('图库包已加载 ' + map.size + ' 张 / ' + Math.round(got.bytes.length / 1048576) + 'MB / ' + state.shapeLibLabel);
        if (fixed) toast('图库已生效：已给现有笔刷补回 ' + fixed + ' 支真图笔尖', 8000);
        if (got.bytes.length > 120 * 1048576) {
          toast('已加载原图库包（' + Math.round(got.bytes.length / 1048576) + 'MB）。内存紧张时（手机/低配）请改用「精简512」包', 12000);
        }
        // 安卓 App 已经内置精简图库：把「下载精简512」按钮收起来，避免用户再去联网拉 32MB（手机上会很慢）
        if (window.BrushNative) {
          const liteBtn = document.getElementById('btnShapeLibDownload');
          if (liteBtn && state.shapeLibBuiltIn) liteBtn.hidden = true;
        }
        return { ok: true, count: map.size, fixed: fixed, label: state.shapeLibLabel };
      } catch (e) {
        state.shapeLibError = e && e.message ? e.message : String(e);
        state.shapeLibBuiltIn = false;
        updateShapeLibText();
        pushLog('图库包加载失败：' + state.shapeLibError);
        return { ok: false, error: state.shapeLibError };
      } finally { bundledLoading = null; }
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
  async function loadShapeLibrary(fileList, libLabel, forceReparse) {
    const list = Array.prototype.slice.call(fileList || []);
    if (!list.length) return;
    toast('正在读取图库…', 8000);
    const map = new Map();
    let undecoded = 0;
    const undecodedNames = [];
    let converted = 0;
    /* 关键：不要整包解成 RGBA 常驻（292 张原图 = 1GB+ 会直接崩）。
       PNG 与 baseline JPEG 只存原始字节，core 用到时才同步解码；
       只有 progressive JPEG 必须在这解一次，解完烘成灰度 PNG 存起来（同样不常驻 RGBA）。 */
    async function addOne(name, bytes) {
      const base = String(name || '').split(/[\\/]/).pop().toLowerCase();
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
          undecoded++;
          undecodedNames.push(base);
        }
      }
      map.set(base, entry);
    }
    for (const f of list) {
      try {
        if (/\.zip$/i.test(f.name)) {
          const entries = BC.zip.read(new Uint8Array(await f.arrayBuffer()));
          for (const e of entries) await addOne(e.name, e.data());
        } else {
          await addOne(f.name, new Uint8Array(await f.arrayBuffer()));
        }
      } catch (e) { pushLog('图库读取失败 ' + f.name + '：' + e.message); }
    }
    if (!map.size) { toast('图库里没有 PNG/JPG：请选择包含内置笔尖图的 ZIP 或文件夹', 8000); return; }
    if (converted) pushLog('图库里有 ' + converted + ' 张 progressive JPEG 已用 canvas 解出并转存为灰度 PNG');
    if (undecoded) pushLog('图库有 ' + undecoded + ' 张解不开：' + undecodedNames.slice(0, 12).join(', '));
    state.shapeLib = map;
    state.shapeLibBuiltIn = false; // 用户自己选的图库优先于内置（通常是原始高分辨率图）
    state.shapeLibLabel = libLabel || '自选图库';
    updateShapeLibText();
    const fixed = await reparseWithShapeLib(forceReparse);
    toast('图库已加载 ' + map.size + ' 张' + (fixed ? '；已给现有笔刷补回 ' + fixed + ' 支真图笔尖'
      : (forceReparse ? '；现有笔刷的笔尖已按新图库重建' : '；缺 shape 的笔刷重新导入后会补回真图')), 12000);
  }

  /* #282：图库是后加载的，用户不该为此重新导入一遍笔刷——
     把「当时留着原始字节的 Procreate 记录」原地重新解析一次，卡片立刻从合成圆头变成图库补回。 */
  let relibRunning = false;
  async function reparseWithShapeLib(force) {
    if (relibRunning || !state.shapeLib) return 0;
    const targets = state.files.filter(function (rec) {
      return rec.bytes && rec.brushes && rec.brushes.some(function (b) {
        // force（图库升级精简→原图）：凡引用内置资源的都重建，不管现在缺不缺 tip
        return b.bundledShapePath && (force || !b.tip);
      });
    });
    if (!targets.length) return 0;
    relibRunning = true;
    let fixed = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        const rec = targets[i];
        const before = rec.brushes.filter(function (b) { return !b.tip; }).length;
        setProgress(0.05 + 0.9 * (i / targets.length), '用图库补回笔尖：' + rec.name);
        await sleep(0);
        rec.warnings = (rec.warnings || []).filter(function (w) { return String(w).indexOf('内置笔尖原图') < 0; });
        rec.brushes = null;
        try {
          await parseRecord(rec, rec.parseName || rec.name, rec.bytes);
        } catch (e) {
          pushLog('图库重解析失败 ' + rec.name + '：' + (e && e.message ? e.message : e));
        }
        const after = (rec.brushes || []).filter(function (b) { return !b.tip; }).length;
        fixed += Math.max(0, before - after);
        render();
      }
    } finally {
      relibRunning = false;
      setProgress(null);
    }
    updateShapeLibText();
    return fixed;
  }
  /* #301：网页版一键下载图库包并自动导入。
     选项区的常驻按钮和缺图笔刷提示里的指引按钮共用这一个流程：
     流式显示下载进度 → 喂给 loadShapeLibrary → 自动 reparse 补回真笔尖。
     #303：精简512（32MB 单文件，推荐）与原图高清（216MB 分 3 卷，浏览器自动合并）两档可选。 */
  /* 图库包跨会话记忆：小包版/网页每次重开都要重下 32MB 太浪费，下过一次就存 IndexedDB。
     只存精简档（32MB）；原图 216MB 不存，避免撑爆配额。 */
  const ShapeLibStore = (function () {
    const DB_NAME = 'brushconv-shapelib', STORE = 'packs', KEY = 'lite';
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
    async function get() {
      try {
        const db = await open();
        return await new Promise(function (resolve, reject) {
          const tx = db.transaction(STORE, 'readonly');
          const r = tx.objectStore(STORE).get(KEY);
          r.onsuccess = function () { resolve(r.result || null); };
          r.onerror = function () { reject(r.error); };
        });
      } catch (e) { return null; }
    }
    async function put(bytes) {
      try {
        const db = await open();
        await new Promise(function (resolve, reject) {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(bytes, KEY);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        });
        return true;
      } catch (e) { pushLog('图库缓存写入失败：' + ((e && e.message) || e)); return false; }
    }
    async function clear() {
      try { const db = await open(); const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(KEY); } catch (e) { /* ignore */ }
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
  function shapeLibUrl(name) {
    const enc = encodeURI(name);
    if (/^(https?:)?\/\//.test(name)) return name;
    return (window.BrushNative || window.BrushDesktop) ? SITE_BASE + enc : enc;
  }
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
    const clear = document.getElementById('btnShapeLibClear');
    if (!box) return;
    const info = nativeShapeLibInfo();
    if (!info) { box.hidden = true; if (clear) clear.hidden = true; return; }
    const mb = function (b) { return (b / 1048576).toFixed(1) + 'MB'; };
    const parts = [];
    if (info.privateBytes > 0) {
      let when = '';
      if (info.mtime) {
        try {
          const d = new Date(Number(info.mtime));
          when = '，' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ' 下载';
        } catch (e) { /* ignore */ }
      }
      parts.push('App 内副本 ' + mb(info.privateBytes) + '（files/shape-lib.zip' + when + '）');
    } else if (info.source === 'asset') parts.push('图库在安装包里（assets）');
    if (info.privateBytes > 0) {
      const b0 = document.getElementById('btnShapeLibBackup');
      if (b0) b0.hidden = false;
    } else {
      const b1 = document.getElementById('btnShapeLibBackup');
      if (b1) b1.hidden = true;
    }
    if (!parts.length) { box.hidden = true; if (clear) clear.hidden = true; return; }
    box.hidden = false;
    box.textContent = parts.join('；') + '。图库不进安装包（APK 只读），也不计入「应用大小」；卸载 App 时它会和图库一起被删掉。';
    if (clear) clear.hidden = !(info.privateBytes > 0);
  }
  window.__refreshShapeLibStoreUI = refreshShapeLibStoreUI;
  /* 安卓：走原生下载（WebView 自己 fetch 32MB 实测卡在 0/32MB），下载完直接读 App 私有目录。
     resume=true 时不重新发起下载，只接管已有任务（导入笔刷 / Activity 重建后进度不丢）。 */
  async function nativeShapeLibDownload(url, btn, totalMB, resume) {
    const native = window.BrushNative;
    btn.textContent = '下载中 0/' + totalMB + 'MB…';
    if (!resume && !native.shapeLibDownloadStart(url)) throw new Error('已有下载在进行');
    const started = Date.now();
    for (;;) {
      await new Promise(function (r) { setTimeout(r, 400); });
      const raw = String(native.shapeLibDownloadStatus() || 'idle|0|-1');
      const parts = raw.split('|');
      const st = parts[0], got = Number(parts[1]) || 0, total = Number(parts[2]) || 0;
      if (st === 'done') { btn.textContent = '下载完成，正在导入…'; return; }
      if (st.indexOf('error') === 0) throw new Error(st.slice(6) || '下载失败');
      btn.textContent = '下载中 ' + Math.round(got / 1048576) + '/' + (total > 0 ? Math.round(total / 1048576) : totalMB) + 'MB…';
      if (Date.now() - started > 15 * 60 * 1000) throw new Error('下载超时');
    }
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
      if (window.BrushNative && typeof window.BrushNative.shapeLibDownloadStart === 'function' && pack.parts.length === 1) {
        await nativeShapeLibDownload(shapeLibUrl(pack.parts[0]), btn, pack.totalMB);
        btn.textContent = '正在导入图库…';
        const got = await bundledShapeLibBytes();
        const nativeFile = new File([got.bytes], pack.zipName, { type: 'application/zip' });
        // 安卓也存一份到 IndexedDB：它也是 App 数据（卸载会删），但能当私有目录的安全网——
        // 万一某次更新后 files/ 里的图库读不到，启动时能立即从缓存恢复，不用重下 32MB。
        if (pack.key === 'lite') {
          try {
            const cachedNative = await ShapeLibStore.put(got.bytes);
            pushLog(cachedNative ? '图库同时缓存到 App 数据（IndexedDB）' + got.bytes.length + 'B，更新后可直接恢复' : '图库缓存失败（不影响使用）');
          } catch (e) { /* 缓存失败不影响本次使用 */ }
        }
        const upgrade = !!(state.shapeLib && state.shapeLibPackKey !== pack.key);
        await loadShapeLibrary([nativeFile], pack.label, upgrade);
        state.shapeLibPackKey = pack.key;
        btn.textContent = pack.doneText;
        toast('图库包已下载到 App 内（下次启动自动加载，卸载会一起删）', 5000);
        pushLog('图库包已通过原生下载保存：' + got.bytes.length + 'B');
        refreshShapeLibStoreUI();
        render();
        return;
      }
      let blob;
      if (pack.parts.length === 1) {
        const resp = await fetch(shapeLibUrl(pack.parts[0]));
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const total = Number(resp.headers.get('content-length')) || totalBytes;
        if (resp.body && resp.body.getReader) {
          // 流式读，按 MB 显示进度（几十 MB 也要几秒，别让用户干等）
          const reader = resp.body.getReader();
          const chunks = [];
          let got = 0;
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            chunks.push(r.value);
            got += r.value.length;
            btn.textContent = '下载中 ' + Math.round(got / 1048576) + '/' + Math.round(total / 1048576) + 'MB…';
          }
          blob = new Blob(chunks);
        } else {
          blob = await resp.blob();
        }
      } else {
        // 多卷包：依次下载，跨卷累计进度，最后在浏览器里合并成一个 zip
        const chunks = [];
        let got = 0;
        for (const part of pack.parts) {
          const resp = await fetch(shapeLibUrl(part));
          if (!resp.ok) throw new Error(part + ' HTTP ' + resp.status);
          if (!(resp.body && resp.body.getReader)) throw new Error('浏览器不支持流式下载，请改用手动选择图库文件');
          const reader = resp.body.getReader();
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            chunks.push(r.value);
            got += r.value.length;
            btn.textContent = '下载中 ' + Math.round(got / 1048576) + '/' + Math.round(totalBytes / 1048576) + 'MB…';
          }
        }
        blob = new Blob(chunks);
      }
      btn.textContent = '正在导入图库…';
      const packBytes = new Uint8Array(await blob.arrayBuffer());
      // 跨会话记忆：精简档存 IndexedDB（小包版/网页下次重开不用重下）
      if (pack.key === 'lite') {
        const cached = await ShapeLibStore.put(packBytes);
        if (cached) pushLog('图库包已缓存到 IndexedDB（' + packBytes.length + 'B）');
      }
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
      const file = new File([packBytes], pack.zipName, { type: 'application/zip' });
      // 精简→原图升级时已有笔刷不缺 tip，需要强制重建才能换上高清笔尖
      const isUpgrade = !!(state.shapeLib && state.shapeLibPackKey !== pack.key);
      await loadShapeLibrary([file], pack.label, isUpgrade);
      state.shapeLibPackKey = pack.key;
      btn.textContent = pack.doneText;
      render(); // 刷新所有卡片：缺图提示里的下载按钮随图库就位一并消失
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      toast('图库包下载失败：' + msg + '。也可以在「高级选项」里点「选择图库 ZIP / 图片」手动导入', 12000);
      pushLog('图库包下载失败：' + msg);
      btn.disabled = false;
      btn.textContent = label;
    } finally {
      shapeLibDlBusy = false;
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
        if (!native.shapeLibSaveBegin()) throw new Error('无法创建文件');
        const CHUNK = 3 * 1024 * 1024;
        for (let off = 0; off < bytes.length; off += CHUNK) {
          const part = bytes.subarray(off, Math.min(CHUNK, bytes.length - off) + off);
          let bin = '';
          for (let i = 0; i < part.length; i++) bin += String.fromCharCode(part[i]);
          if (!native.shapeLibSaveChunk(btoa(bin))) { native.shapeLibSaveAbort(); throw new Error('写入失败'); }
        }
        const res = String(native.shapeLibSaveEnd() || '');
        if (res.indexOf('ok:') !== 0) throw new Error(res.slice(6) || '保存失败');
        pushLog('手动选的图库已保存到 App 内：' + res.slice(3) + 'B（下次启动自动加载）');
        toast('已保存到 App 内，下次启动自动加载（卸载会一并删除）', 5000);
        refreshShapeLibStoreUI();
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
      await loadShapeLibrary(picked);
      el.value = '';
      if (state.shapeLib) await persistPickedLib(picked);
    }
    if (input) input.addEventListener('change', takeFiles);
    if (dirInput) dirInput.addEventListener('change', takeFiles);
    updateShapeLibText();
    // 网页版 / 安卓 App / 桌面：选项区常驻两档下载按钮（原生壳靠 shapeLibUrl() 走站点绝对地址；桌面下完会自动存回程序目录）
    if (/^https?:/.test(location.protocol) || window.BrushNative || window.BrushDesktop) {
      const dlBtn = $('#btnShapeLibDownload');
      if (dlBtn) {
        dlBtn.hidden = false;
        dlBtn.addEventListener('click', function () { downloadShapeLibPack(dlBtn, SHAPE_LIB_PACKS.lite); });
      }
      const dlFull = $('#btnShapeLibDownloadFull');
      if (dlFull) {
        dlFull.hidden = false;
        dlFull.addEventListener('click', function () { downloadShapeLibPack(dlFull, SHAPE_LIB_PACKS.full); });
      }
      // 释放图库空间（用户问「卸载时要把图库一并卸载」——这里也能主动删）
      const clearBtn = $('#btnShapeLibClear');
      if (clearBtn) {
        clearBtn.addEventListener('click', function () {
          const n = window.BrushNative;
          if (!n || typeof n.shapeLibDownloadClear !== 'function') return;
          try {
            const ok = Boolean(n.shapeLibDownloadClear());
            if (ok) {
              state.shapeLib = null;
              state.shapeLibPackKey = null;
              updateShapeLibText();
              refreshShapeLibStoreUI();
              toast('已删除 App 内图库副本与共享备份，下次要用再下（32MB）', 5000);
            } else toast('删除失败：可能没有存储权限', 5000);
          } catch (e) { toast('删除失败：' + ((e && e.message) || e), 5000); }
        });
      }
      // 手动备份：只在用户点「存一份图库到 下载」时才写公共目录（机型更新后被系统清数据时可一键装回）
      const backupBtn = $('#btnShapeLibBackup');
      if (backupBtn) {
        backupBtn.addEventListener('click', function () {
          const n = window.BrushNative;
          if (!n || typeof n.shapeLibBackupToDownloads !== 'function') return;
          try {
            const res = String(n.shapeLibBackupToDownloads() || '');
            if (res.indexOf('ok:') === 0) {
              toast('已备份到「' + res.slice(3) + '」。更新后万一丢了，用「选择图库 ZIP」选它就能装回（不用重下）', 7000);
              pushLog('图库已手动备份到：' + res.slice(3));
            } else toast('备份失败：' + (res.slice(6) || res), 6000);
          } catch (e) { toast('备份失败：' + ((e && e.message) || e), 6000); }
        });
      }
    }
    refreshShapeLibStoreUI();
    // 桌面 / 安卓：图库包就在程序目录（或 APK 内置），启动就加载，用户什么都不用点（网页版要先下 32MB，改成用到才下）
    // 小包版 / 网页：如果上次下过精简图库（IndexedDB 缓存），直接恢复，不用每次重下 32MB
    async function restoreCachedShapeLib() {
      if (state.shapeLib) return;
      if (window.BrushDesktop) return; // 桌面走程序目录
      try {
        const cached = await ShapeLibStore.get();
        if (!cached || !cached.length || state.shapeLib) return;
        const file = new File([cached], 'Procreate内置笔尖图库_精简512.zip', { type: 'application/zip' });
        await loadShapeLibrary([file], '上次下载的精简图库（缓存）', false);
        if (state.shapeLib && state.shapeLib.size) {
          state.shapeLibPackKey = 'lite';
          pushLog('启动时从 IndexedDB 恢复图库 ' + state.shapeLib.size + ' 张 / ' + cached.length + 'B');
          toast('已恢复上次下载的图库包（' + state.shapeLib.size + ' 张），不用重新下载', 5000);
        }
      } catch (e) { pushLog('恢复缓存图库失败：' + ((e && e.message) || e)); }
    }
    if (!state.shapeLib && (window.BrushDesktop || window.BrushNative)) {
      loadBundledShapeLib().then(function (r) {
        if (r && r.ok) pushLog('启动时已加载图库包 ' + r.count + ' 张');
        else restoreCachedShapeLib();
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
      if (st !== 'running' && st !== 'done') return;
      const dlBtn = $('#btnShapeLibDownload');
      if (!dlBtn) return;
      dlBtn.hidden = false;
      shapeLibDlBusy = true;
      (async function () {
        try {
          dlBtn.disabled = true;
          await nativeShapeLibDownload('', dlBtn, SHAPE_LIB_PACKS.lite.totalMB, true);
          dlBtn.textContent = '正在导入图库…';
          const got = await bundledShapeLibBytes();
          await loadShapeLibrary([new File([got.bytes], SHAPE_LIB_PACKS.lite.zipName, { type: 'application/zip' })], SHAPE_LIB_PACKS.lite.label, false);
          state.shapeLibPackKey = 'lite';
          dlBtn.textContent = SHAPE_LIB_PACKS.lite.doneText;
          toast('上次没下完的图库包已接上并完成（不用重新下载）', 5000);
          pushLog('启动时接管了未完成的图库下载：' + got.bytes.length + 'B');
        } catch (e) {
          pushLog('接管图库下载失败：' + ((e && e.message) || e));
        } finally {
          shapeLibDlBusy = false;
          if (dlBtn) dlBtn.disabled = false;
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

  $('#ver').textContent = 'v' + APP_VERSION + ' · 修复 Procreate / Photoshop / 画世界Pro 参数与双笔刷互转 · 纯本地';
  render();
})();
