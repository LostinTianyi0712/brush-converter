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

  function downloadFile(name, bytes, mime) {
    var blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name.split('/').pop();
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 4000);
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
    supportsDirectory: function () {
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

      // 3) File System Access API (Chrome / Edge web version)
      if (typeof window.showDirectoryPicker === 'function' && (webFolder || !opts.packOut)) {
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
      for (i = 0; i < files.length; i++) {
        progress(i / files.length, '正在下载 ' + (i + 1) + '/' + files.length + '：' + files[i].name);
        downloadFile(files[i].name, files[i].data, 'application/octet-stream');
        await sleep(180);
      }
      return '已发起 ' + files.length + ' 个下载（浏览器可能询问是否允许多个下载）';
    }
  };
})();
