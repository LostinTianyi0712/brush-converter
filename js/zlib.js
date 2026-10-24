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
    deflate: function (bytes, level) { return getPako().deflate(bytes, { level: level === undefined ? 9 : level }); },
    inflateRaw: function (bytes) { return getPako().inflateRaw(bytes); },
    deflateRaw: function (bytes, level) { return getPako().deflateRaw(bytes, { level: level === undefined ? 9 : level }); }
  };

  if (isNode) module.exports = z;
  else root.BC = Object.assign(root.BC || {}, { zlib: z });
})(typeof globalThis !== 'undefined' ? globalThis : this);

