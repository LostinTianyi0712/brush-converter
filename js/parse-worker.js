/* 解析 Worker：把大文件解析放到后台线程，避免界面卡死
   路径兼容两种布局：
   - 网页版/小工具包：js/parse-worker.js 与 core 文件同目录
   - 开发目录：app/parse-worker.js 与 ../core/*.js
*/
'use strict';
var CORE = [
  'pako.min.js', 'util.js', 'zlib.js', 'png.js', 'zip.js', 'plist.js',
  'descriptor.js', 'bplist.js', 'procreateDefaults.js',
  'sqlite.js', 'sutWrite.js', 'udongmanTemplate.js', 'cspMaterialTemplate.js', 'cspMaterial.js', 'csp.js', 'medibang.js', 'medibangIni.js', 'infpainter.js', 'gobrush.js', 'gobrushWrite.js',
  'gimp.js', 'kritaPreview.js', 'kritaPresetTemplate.js', 'kritaPresetTemplatePencil.js', 'sai2.js', 'sai2read.js', 'sai2dat.js', 'sai2settings.js', 'mypaint.js', 'krita.js',
  'jpeg.js', 'jpegEncode.js', 'genericbrush.js', 'painterlib.js',
  'abrUuidPool.js', 'abrPatternTemplate.js', 'pat.js', 'patRead.js', 'abr.js', 'tplTemplate.js', 'tpl.js',
  'procreate.js', 'bru.js', 'hsj-textures-lib.js', 'convert.js', 'update.js'
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
    /* 【第182轮】回传零拷贝：解析结果里带着每支笔刷的笔尖像素（Uint8Array），
       原来不带 transfer 列表 = 结构化克隆整份复制。53 支 2048² 的 brushset
       就是 848MB 的搬运，主线程解析完还要卡好几秒，界面上点两下就没响应。
       收集所有视图的 buffer 一次性转移（Set 去重，同一 buffer 不能传两次）。 */
    var transfer = [];
    var seen = new Set();
    (function collect(o, depth) {
      if (!o || typeof o !== 'object' || depth > 6) return;
      if (ArrayBuffer.isView(o)) {
        var buf = o.buffer;
        if (buf && buf.byteLength > 0 && !seen.has(buf)) { seen.add(buf); transfer.push(buf); }
        return;
      }
      if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) collect(o[i], depth + 1); return; }
      for (var k in o) {
        if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
        collect(o[k], depth + 1);
      }
    })(parsed, 0);
    self.postMessage({ id: id, ok: true, result: parsed }, transfer);
  } catch (e) {
    self.postMessage({ id: id, ok: false, error: (e && e.message) || String(e) });
  }
};
