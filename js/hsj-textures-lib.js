/* 画世界内置纹理库访问层（第187轮）
 *
 * `core/hsj-textures.js` 里 156 张纹理是 base64 的**原始图片字节**（143 JPEG + 13 PNG，
 * 全灰度、无损坏、无重复）。本模块负责「按 ptN 取 → 解码 → 转灰度 → 缓存」，
 * 供 convert.js 的 textureGray() 作为**第四级来源**使用。
 *
 * 为什么需要它：画世界 BRU 的纹理字段 f6 只存资源 id（`ptN`），不含像素。
 * 这类笔刷转到 ABR / Procreate / Krita / GoPaint / SAI2 / SUT 时，过去一律按
 * 「缺纹理原图」降级，纹理被静默丢掉（用户反馈过「网点笔刷变成半透明气枪」那类）。
 * 有了本模块就能用 App 自带的那张纹理补位。
 *
 * 优先级不能变（用户的素材永远高于内置库）：
 *   _patternPixels（ABR patt / 用户图案）> _grainRgba（Procreate Grain）
 *   > grain（GoPaint 解码）> 内置库(texAssetId) > null
 *
 * 已知限制：库里的 JPEG 有一部分是 progressive(SOF2)，而 `core/jpeg.js` 只支持
 * baseline(SOF0)。构建期会把它们重编码为 baseline 灰度（tools/reencode_hsj_textures.py）。
 * 解不开的 id 一律返回 null —— 不抛错、不重试、由各格式按原逻辑降级。
 */
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';

  function dep(nodeName, bcName, req) {
    if (isNode) { try { return require(req); } catch (e) { return null; } }
    return (root.BC && root.BC[bcName]) || null;
  }
  const jpeg = dep('jpeg', 'jpeg', './jpeg.js');
  const png = dep('png', 'png', './png.js');

  /* 纹理库本身必须**惰性**取：网页端是懒加载的——用户在界面上点了「下载纹理库」
     之后才把 hsj-textures.js 注入 root.BC。如果在模块初始化时就把它抓进常量，
     懒加载完成后这里仍是 null，网页端就永远用不上（桌面端因为 require 在启动时
     就绪，看不出这个问题）。Node 端的 require 有模块缓存，每帧调用的开销可忽略。 */
  function srcRef() {
    if (isNode) { try { return require('./hsj-textures.js'); } catch (e) { return null; } }
    return (root.BC && root.BC.hsjTextures) || null;
  }

  /* 512² 灰度 = 256KB/张，全缓存 156 张约 40MB，不能全留；8 条足够覆盖
     「一次导出里反复取同一两张纹理」的实际访问模式。 */
  const CACHE_MAX = 8;
  const cache = new Map();   /* id -> {w,h,gray}；Map 的插入序就是 LRU 序 */
  const broken = new Set();  /* 解不开的 id，避免每次导出都重试解码 */

  function b64ToBytes(b64) {
    if (isNode) return new Uint8Array(Buffer.from(b64, 'base64'));
    const bin = root.atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* 解码结果统一成 {w,h,gray}（与 convert.js 的 textureGray 契约一致）。
     全库都是灰度，但 JPEG 解出来仍可能带三通道，所以按亮度合成；
     透明像素按白处理——纹理是遮罩语义，透明处应当是「满」而不是「黑」。 */
  function toGray(img) {
    if (!img) return null;
    const w = (img.width | 0) || (img.w | 0);
    const h = (img.height | 0) || (img.h | 0);
    if (!(w > 0 && h > 0)) return null;
    const rgba = img.rgba || img.data || null;
    if (!rgba) return null;
    const n = w * h;
    const gray = new Uint8Array(n);
    if (rgba.length === n) {                 /* 已经是单通道 */
      gray.set(rgba.subarray ? rgba.subarray(0, n) : rgba.slice(0, n));
      return { w: w, h: h, gray: gray };
    }
    if (rgba.length < n * 4) return null;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const a = rgba[o + 3] / 255;
      const inv = 1 - a;
      const r = rgba[o] * a + 255 * inv;
      const g = rgba[o + 1] * a + 255 * inv;
      const b = rgba[o + 2] * a + 255 * inv;
      /* 整数近似（0.299/0.587/0.114 → 77/151/28 / 256），避免每像素浮点乘 */
      gray[i] = Math.round((r * 77 + g * 151 + b * 28) / 256);
    }
    return { w: w, h: h, gray: gray };
  }

  function decodeOne(id) {
    const src = srcRef();
    if (!src || typeof src.get !== 'function') return null;
    const b64 = src.get(id);
    if (!b64 || typeof b64 !== 'string' || b64.length < 24) return null;
    const bytes = b64ToBytes(b64);
    if (bytes.length < 16) return null;
    let img = null;
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      if (!jpeg) return null;
      img = typeof jpeg.decode === 'function' ? jpeg.decode(bytes) : jpeg.parse(bytes);
    } else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      if (!png) return null;
      img = png.decode(bytes);
    } else {
      return null;
    }
    return toGray(img);
  }

  function normId(id) {
    const key = String(id === null || id === undefined ? '' : id).trim();
    return /^pt\d+$/.test(key) ? key : null;
  }

  /** 取一张内置纹理的灰度像素。命中返回 {w,h,gray}，任何情况下取不到都返回 null。 */
  function gray(id) {
    const key = normId(id);
    if (!key) return null;
    if (cache.has(key)) {
      const v = cache.get(key);
      cache.delete(key); cache.set(key, v);      /* 刷新 LRU 序 */
      return v;
    }
    if (broken.has(key)) return null;
    let got = null;
    try { got = decodeOne(key); } catch (e) { got = null; }
    if (!got) { broken.add(key); return null; }
    cache.set(key, got);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return got;
  }

  /** 是否真能取到像素（含缓存与已判死的 id），供 UI/报告判断要不要提示「需下载纹理库」。 */
  function has(id) {
    const key = normId(id);
    if (!key) return false;
    return cache.has(key) || (!broken.has(key) && !!gray(key));
  }

  /* 内容指纹缓存：反查时要把 156 张全算一遍 md5（每张 10–30ms 解码），
     算过一次就记住，后续单次反查只剩查表 + 一次 md5。 */
  const sigCache = new Map();   /* id -> 'WxH:md5' */

  function md5Of(bytes) {
    const util = isNode ? require('./util.js') : (root.BC && root.BC.util);
    if (!util || typeof util.md5 !== 'function') return null;
    return util.md5(bytes);
  }

  function sigOf(id) {
    if (sigCache.has(id)) return sigCache.get(id);
    const g = gray(id);
    if (!g || !g.gray) { sigCache.set(id, null); return null; }
    const h = md5Of(g.gray);
    const sig = h ? (g.w + 'x' + g.h + ':' + h) : null;
    sigCache.set(id, sig);
    return sig;
  }

  /** 按灰度像素反查库里有没有同一张纹理，命中返回 ptN，否则 null。
   *  用于 BRU 写 f6：源笔刷的纹理若是画世界内置的那张，就该写回它自己的编号，
   *  而不是一律写死 'pt24'。 */
  function matchId(w, h, grayArr) {
    const W = w | 0, H = h | 0;
    if (!(W > 0 && H > 0) || !grayArr || grayArr.length !== W * H) return null;
    const target = md5Of(grayArr);
    if (!target) return null;
    const want = W + 'x' + H + ':' + target;
    const total = (srcRef() && srcRef().count) || 0;
    for (let i = 1; i <= total; i++) {
      const id = 'pt' + i;
      if (sigOf(id) === want) return id;
    }
    return null;
  }

  /** 库里的 id 清单（不触发解码）。 */
  function ids() {
    const out = [];
    const src = srcRef();
    if (!src || typeof src.get !== 'function') return out;
    const total = src.count || 0;
    for (let i = 1; i <= total; i++) {
      const id = 'pt' + i;
      if (src.get(id)) out.push(id);
    }
    return out;
  }

  function clearCache() { cache.clear(); broken.clear(); sigCache.clear(); }

  const api = {
    gray: gray,
    has: has,
    matchId: matchId,
    ids: ids,
    clearCache: clearCache,
    get count() { const s = srcRef(); return (s && s.count) || 0; },
    cacheSize: function () { return cache.size; },
    brokenIds: function () { return Array.from(broken); }
  };

  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { hsjTextureLib: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
