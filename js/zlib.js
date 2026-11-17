/* pako adapter: sync inflate/deflate available in browser and node
 *
 * 【第280轮】Node 下优先走原生 zlib：
 *   · inflate / inflateRaw 是**确定性**的，输出与 pako 逐字节一致 → 直接换，零风险；
 *   · deflate / deflateRaw 压缩流字节会不同（同一份像素解出来一样），所以只在大图（≥512² 像素）
 *     上启用原生，避免打乱既有的小图黄金样本。实测 2048² RGBA 的 PNG 编码从 ~1.45s 降到 ~0.06s
 *     （吹石「质感叠加」单支 BRU 导出 3.24s → 0.4s）。
 * 浏览器端行为完全不变（拿不到 require('zlib')）。 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  let pako = null;
  let native = null;
  if (isNode) { try { native = require('zlib'); } catch (e) { native = null; } }

  function getPako() {
    if (pako) return pako;
    if (root.pako) { pako = root.pako; return pako; }
    if (isNode) { pako = require('./pako.min.js'); return pako; }
    throw new Error('pako not loaded');
  }

  function hasNative() { return !!(native && typeof native.inflateSync === 'function'); }
  /* 大图才走原生的 deflate：小图保留 pako 的字节输出，免得黄金样本对不上 */
  function nativeDeflateOk(bytes) { return hasNative() && bytes && bytes.length >= 512 * 512; }

  const z = {
    inflate: function (bytes) {
      if (hasNative()) { try { return new Uint8Array(native.inflateSync(Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength))); } catch (e) { /* 落到 pako */ } }
      return getPako().inflate(bytes);
    },
    // Fixed-size raster blocks must not expand an untrusted stream without a bound.
    inflateLimited: function (bytes, limit) {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid inflate limit');
      if (hasNative()) {
        try {
          const out = new Uint8Array(native.inflateSync(Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength), { maxOutputLength: limit }));
          if (out.length > limit) throw new Error('Inflated data exceeds limit');
          return out;
        } catch (e) {
          if (String(e && e.message).indexOf('exceeds limit') >= 0) throw e;
          /* 其它错误落到 pako，让它给出更具体的报错 */
        }
      }
      const decoder = new (getPako().Inflate)({ chunkSize: Math.min(32768, Math.max(1, limit + 1)) });
      let size = 0;
      const chunks = [];
      decoder.onData = function (chunk) {
        size += chunk.length;
        if (size > limit) throw new Error('Inflated data exceeds limit');
        chunks.push(chunk);
      };
      decoder.push(bytes, true);
      if (decoder.err || !decoder.ended) throw new Error(decoder.msg || 'Incomplete compressed data');
      const out = new Uint8Array(size);
      let offset = 0;
      chunks.forEach(function (chunk) { out.set(chunk, offset); offset += chunk.length; });
      return out;
    },
    deflate: function (bytes, level) {
      const lv = level === undefined ? 9 : level;
      if (nativeDeflateOk(bytes)) {
        try { return new Uint8Array(native.deflateSync(Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength), { level: lv })); } catch (e) { /* 落到 pako */ }
      }
      return getPako().deflate(bytes, { level: lv });
    },
    inflateRaw: function (bytes) {
      if (hasNative()) { try { return new Uint8Array(native.inflateRawSync(Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength))); } catch (e) { /* 落到 pako */ } }
      return getPako().inflateRaw(bytes);
    },
    deflateRaw: function (bytes, level) {
      const lv = level === undefined ? 9 : level;
      if (nativeDeflateOk(bytes)) {
        try { return new Uint8Array(native.deflateRawSync(Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength), { level: lv })); } catch (e) { /* 落到 pako */ }
      }
      return getPako().deflateRaw(bytes, { level: lv });
    }
  };

  if (isNode) module.exports = z;
  else root.BC = Object.assign(root.BC || {}, { zlib: z });
})(typeof globalThis !== 'undefined' ? globalThis : this);
