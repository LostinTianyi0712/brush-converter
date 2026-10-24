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

  function saveViaAndroid(name, bytes, mime) {
    var BN = window.BrushNative;
    if (!BN) return null;
    try {
      if (typeof BN.beginFile === 'function') {
        if (!BN.beginFile(name, mime || 'application/octet-stream')) return 'ERROR: beginFile';
        var CHUNK = 700000;
        for (var off = 0; off < bytes.length; off += CHUNK) {
          if (!BN.appendChunk(base64FromBytes(bytes.subarray(off, off + CHUNK)))) return 'ERROR: appendChunk';
        }
        return BN.endFile();
      }
      if (typeof BN.saveData === 'function' && bytes.length < 4 * 1024 * 1024) {
        return BN.saveData(name, base64FromBytes(bytes), mime || 'application/octet-stream');
      }
    } catch (e) {
      return 'ERROR: ' + e.message;
    }
    return null;
  }

  window.BCSaver = {
    save: async function (files, opts, hooks) {
      opts = opts || {};
      var progress = (hooks && hooks.progress) || function () {};
      var i;

      // 1) Android native bridge: save into Downloads/画世界笔刷
      if (window.BrushNative && typeof window.BrushNative.beginFile === 'function') {
        var last = '';
        for (i = 0; i < files.length; i++) {
          progress(i / files.length, '正在保存 ' + (i + 1) + '/' + files.length + '：' + files[i].name);
          var res = saveViaAndroid(files[i].name, files[i].data, 'application/octet-stream');
          if (res && String(res).indexOf('ERROR') !== 0) last = res;
          await sleep(0);
        }
        return last ? '已保存到 ' + last.replace(/\/[^/]+$/, '/') : '已保存';
      }

      // 2) Electron desktop bridge: native folder picker + fs write (direct file mode)
      if (window.BrushDesktop && typeof window.BrushDesktop.chooseFolder === 'function' && !opts.packOut) {
        var dir = await window.BrushDesktop.chooseFolder();
        if (!dir) return null;
        for (i = 0; i < files.length; i++) {
          progress(i / files.length, '正在写入 ' + (i + 1) + '/' + files.length + '：' + files[i].name);
          var w = await window.BrushDesktop.writeFile(dir, files[i].name, base64FromBytes(files[i].data));
          if (w && String(w).indexOf('ERROR') === 0) throw new Error(String(w).slice(6));
        }
        return '已保存到 ' + dir;
      }

      // 3) File System Access API (Chrome / Edge web version)
      if (typeof window.showDirectoryPicker === 'function' && !opts.packOut) {
        var dirHandle;
        try {
          dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
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
          await writable.write(files[i].data);
          await writable.close();
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
