/* pako adapter: sync inflate/deflate available in browser and node */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  let pako = null;

  function getPako() {
    if (pako) return pako;
    if (root.pako) { pako = root.pako; return pako; }
    if (isNode) { pako = require('./pako.min.js'); return pako; }
    throw new Error('pako not loaded');
  }

  const z = {
    inflate: function (bytes) { return getPako().inflate(bytes); },
    // Fixed-size raster blocks must not expand an untrusted stream without a bound.
    inflateLimited: function (bytes, limit) {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid inflate limit');
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
    deflate: function (bytes, level) { return getPako().deflate(bytes, { level: level === undefined ? 9 : level }); },
    inflateRaw: function (bytes) { return getPako().inflateRaw(bytes); },
    deflateRaw: function (bytes, level) { return getPako().deflateRaw(bytes, { level: level === undefined ? 9 : level }); }
  };

  if (isNode) module.exports = z;
  else root.BC = Object.assign(root.BC || {}, { zlib: z });
})(typeof globalThis !== 'undefined' ? globalThis : this);

