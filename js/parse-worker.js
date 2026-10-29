/* 解析 Worker：把大文件解析放到后台线程，避免界面卡死
   路径兼容两种布局：
   - 网页版/小工具包：js/parse-worker.js 与 core 文件同目录
   - 开发目录：app/parse-worker.js 与 ../core/*.js
*/
'use strict';
var CORE = [
  'pako.min.js', 'util.js', 'zlib.js', 'png.js', 'zip.js', 'plist.js',
  'descriptor.js', 'bplist.js', 'procreateDefaults.js',
  'sqlite.js', 'csp.js', 'sutWrite.js', 'udongmanTemplate.js', 'medibang.js', 'medibangIni.js', 'infpainter.js', 'gobrush.js', 'gobrushWrite.js',
  'gimp.js', 'kritaPreview.js', 'kritaPresetTemplate.js', 'sai2.js', 'sai2read.js', 'mypaint.js', 'krita.js',
  'jpeg.js', 'jpegEncode.js', 'genericbrush.js', 'painterlib.js',
  'abrUuidPool.js', 'abrPatternTemplate.js', 'pat.js', 'patRead.js', 'abr.js',
  'procreate.js', 'bru.js', 'convert.js'
];

var loaded = false;
function loadCore() {
  if (loaded) return;
  var bases = ['', '../core/'];
  var lastErr = null;
  for (var bi = 0; bi < bases.length; bi++) {
    try {
      for (var i = 0; i < CORE.length; i++) importScripts(bases[bi] + CORE[i]);
      loaded = true;
      return;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('core scripts failed to load');
}

self.onmessage = function (ev) {
  var msg = ev.data || {};
  var id = msg.id;
  try {
    loadCore();
    var bytes = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes);
    var parsed = BC.convert.parseFile(msg.name, bytes, msg.opts || {});
    self.postMessage({ id: id, ok: true, result: parsed });
  } catch (e) {
    self.postMessage({ id: id, ok: false, error: (e && e.message) || String(e) });
  }
};
