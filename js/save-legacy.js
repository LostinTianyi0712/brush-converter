/* Output saving for browser / Electron / Android builds.
   Delegated from app.js via window.BCSaver. */
(function () {
  'use strict';

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function base64FromBytes(bytes) {
    var s = '';
    var CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }

  /* 手机浏览器：即使 showDirectoryPicker 存在，用户手势/系统策略也常常直接抛错，
     之前一抛错就 return null（等于「点了没反应」）。手机一律走下载分支。 */
  function isMobileWeb() {
    try {
      var ua = navigator.userAgent || '';
      if (/Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua)) return true;
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function mimeFor(name) {
    var ext = String(name || '').toLowerCase().split('.').pop();
    var map = {
      zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      bundle: 'application/zip', mtd: 'application/zip',
      txt: 'text/plain;charset=utf-8', json: 'application/json'
    };
    return map[ext] || 'application/octet-stream';
  }

  /* 手机浏览器（夸克/UC/QQ 等）普遍不支持 blob: 下载：点了没有任何反应。
     小文件改用 data: URL（这些浏览器吃 data:），大文件仍用 blob，但 blob URL
     必须活得够久——以前 4 秒就 revoke，下载刚发起就被判失败。 */
  function clickAnchor(url, name) {
    var a = document.createElement('a');
    a.href = url;
    a.download = String(name || 'file').split('/').pop();
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { try { document.body.removeChild(a); } catch (e) { /* ignore */ } }, 8000);
  }

  function downloadFile(name, bytes, mime) {
    var mimeType = mime || mimeFor(name);
    if (bytes.length <= 8 * 1024 * 1024) {
      try {
        clickAnchor('data:' + mimeType + ';base64,' + base64FromBytes(bytes), name);
        return 'data';
      } catch (e) { /* 回退 blob */ }
    }
    var blob = new Blob([bytes], { type: mimeType });
    var url = URL.createObjectURL(blob);
    clickAnchor(url, name);
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 180000);
    return 'blob';
  }

  async function saveViaAndroid(name, bytes, mime, onChunk) {
    var BN = window.BrushNative;
    if (!BN) return null;
    try {
      if (typeof BN.beginFile === 'function') {
        if (!BN.beginFile(name, mime || 'application/octet-stream')) {
          if (typeof BN.abortFile === 'function') BN.abortFile();
          return 'ERROR: beginFile';
        }
        var CHUNK = 700000;
        for (var off = 0; off < bytes.length; off += CHUNK) {
          if (!BN.appendChunk(base64FromBytes(bytes.subarray(off, off + CHUNK)))) {
            if (typeof BN.abortFile === 'function') BN.abortFile();
            return 'ERROR: appendChunk';
          }
          if (onChunk) onChunk(Math.min(1, (off + CHUNK) / bytes.length));
          await sleep(0);
        }
        var result = BN.endFile();
        if ((!result || String(result).indexOf('ERROR') === 0) && typeof BN.abortFile === 'function') BN.abortFile();
        return result;
      }
      if (typeof BN.saveData === 'function' && bytes.length < 4 * 1024 * 1024) {
        return BN.saveData(name, base64FromBytes(bytes), mime || 'application/octet-stream');
      }
    } catch (e) {
      try { if (typeof BN.abortFile === 'function') BN.abortFile(); } catch (ignored) { }
      return 'ERROR: ' + e.message;
    }
    return null;
  }

  var webFolder = null;
  window.BCSaver = {
    /* 供「结果文件」面板在真实点按手势里重试下载：手机浏览器只肯在用户手势内接受下载，
       自动触发的那次经常被拦（夸克等）。 */
    downloadOne: function (file) {
      if (!file || !file.data || !file.data.length) return false;
      downloadFile(file.name, file.data, mimeFor(file.name));
      return true;
    },
    openOne: function (file) {
      if (!file || !file.data || !file.data.length) return false;
      if (file.data.length > 8 * 1024 * 1024) return false;
      try {
        var url = 'data:' + mimeFor(file.name) + ';base64,' + base64FromBytes(file.data);
        return !!window.open(url, '_blank');
      } catch (e) { return false; }
    },
    supportsDirectory: function () {
      if (isMobileWeb()) return false;
      return !!(window.BrushDesktop || (!window.BrushNative && typeof window.showDirectoryPicker === 'function'));
    },
    getDirectory: async function () {
      if (window.BrushDesktop && window.BrushDesktop.getOutputFolder) return window.BrushDesktop.getOutputFolder();
      return webFolder ? webFolder.name : null;
    },
    chooseDirectory: async function () {
      if (window.BrushDesktop) return window.BrushDesktop.chooseFolder();
      if (typeof window.showDirectoryPicker !== 'function') return null;
      try {
        var selected = await window.showDirectoryPicker({ mode: 'readwrite' });
        webFolder = selected;
        return selected.name;
      } catch (e) {
        if (e && e.name === 'AbortError') return null;
        throw e;
      }
    },
    save: async function (files, opts, hooks) {
      opts = opts || {};
      var progress = (hooks && hooks.progress) || function () {};
      var i;

      // 1) Android native bridge: save into Downloads/画世界笔刷
      if (window.BrushNative && typeof window.BrushNative.beginFile === 'function') {
        var last = '';
        for (i = 0; i < files.length; i++) {
          progress(i / files.length, '正在保存 ' + (i + 1) + '/' + files.length + '：' + files[i].name);
          var index = i;
          var res = await saveViaAndroid(files[i].name, files[i].data, 'application/octet-stream', function (p) {
            progress((index + p) / files.length, '正在保存 ' + (index + 1) + '/' + files.length + '：' + files[index].name);
          });
          if (!res) return 'ERROR: 原生保存不可用：' + files[i].name;
          if (String(res).indexOf('ERROR') === 0) {
            return 'ERROR: ' + files[i].name + '：' + String(res).replace(/^ERROR:\s*/, '');
          }
          last = res;
          await sleep(0);
        }
        return last ? '已保存到 ' + last.replace(/\/[^/]+$/, '/') : '已保存';
      }

      // Desktop ZIPs and loose files share one awaited native save operation.
      if (window.BrushDesktop && typeof window.BrushDesktop.chooseFolder === 'function') {
        var dir = window.BrushDesktop.getOutputFolder ? await window.BrushDesktop.getOutputFolder() : null;
        if (!dir) dir = await window.BrushDesktop.chooseFolder();
        if (!dir) return null;
        for (i = 0; i < files.length; i++) {
          progress(i / files.length, '正在写入 ' + (i + 1) + '/' + files.length + '：' + files[i].name);
          var bytes = files[i].data;
          if (typeof window.BrushDesktop.writeFileBytes === 'function') {
            var CHUNK = 1024 * 1024;
            for (var off = 0; off < bytes.length || off === 0; off += CHUNK) {
              var w = await window.BrushDesktop.writeFileBytes(dir, files[i].name, bytes.subarray(off, off + CHUNK), off > 0, off + CHUNK >= bytes.length);
              if (w !== 'OK') throw new Error(String(w || '文件写入未完成').replace(/^ERROR:\s*/, ''));
              progress((i + Math.min(1, (off + CHUNK) / Math.max(1, bytes.length))) / files.length, '正在写入：' + files[i].name);
              await sleep(0);
            }
          } else {
            var w = await window.BrushDesktop.writeFile(dir, files[i].name, base64FromBytes(bytes));
            if (w !== 'OK') throw new Error(String(w || '文件写入未完成').replace(/^ERROR:\s*/, ''));
          }
        }
        return '已保存到 ' + dir;
      }

      // 3) File System Access API (Chrome / Edge web version, desktop only)
      if (!isMobileWeb() && typeof window.showDirectoryPicker === 'function' && (webFolder || !opts.packOut)) {
        var dirHandle;
        try {
          dirHandle = webFolder || await window.showDirectoryPicker({ mode: 'readwrite' });
          if (dirHandle.queryPermission && await dirHandle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
            if (await dirHandle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('保存目录未授权，请重新选择保存目录');
          }
          webFolder = dirHandle;
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return null;
          throw e;
        }
        for (i = 0; i < files.length; i++) {
          progress(i / files.length, '正在写入 ' + (i + 1) + '/' + files.length + '：' + files[i].name);
          var parts = files[i].name.split('/');
          var cur = dirHandle;
          for (var d = 0; d < parts.length - 1; d++) {
            cur = await cur.getDirectoryHandle(parts[d], { create: true });
          }
          var fh = await cur.getFileHandle(parts[parts.length - 1], { create: true });
          var writable = await fh.createWritable();
          try {
            await writable.write(files[i].data);
            await writable.close();
          } catch (e) {
            try { await writable.abort(); } catch (ignored) { }
            throw e;
          }
        }
        return '已保存到所选文件夹';
      }

      // 4) fallback: browser downloads
      var bigOnMobile = false;
      for (i = 0; i < files.length; i++) {
        progress(i / files.length, '正在下载 ' + (i + 1) + '/' + files.length + '：' + files[i].name);
        downloadFile(files[i].name, files[i].data, mimeFor(files[i].name));
        if (isMobileWeb() && files[i].data.length > 8 * 1024 * 1024) bigOnMobile = true;
        await sleep(180);
      }
      if (bigOnMobile) return '已发起 ' + files.length + ' 个下载；其中有超过 8MB 的文件，手机浏览器常拦这种大文件，建议把输出改成「单独文件」再转一次';
      return '已发起 ' + files.length + ' 个下载；手机浏览器若没反应，请点下方「结果文件」里的保存按钮重试';
    }
  };
})();
