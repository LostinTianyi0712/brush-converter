/* BrushConv core utilities (browser + node) */
(function (root) {
  'use strict';
  const BC = root.BC = root.BC || {};

  function isNode() {
    return typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  }

  const u = {};

  u.isNode = isNode;

  /* ---------- byte helpers ---------- */
  u.u16 = function (b, o) { return (b[o] << 8) | b[o + 1]; };
  u.i16 = function (b, o) { const v = u.u16(b, o); return v >= 0x8000 ? v - 0x10000 : v; };
  u.u32 = function (b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; };
  u.i32 = function (b, o) { return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; };
  u.f32 = function (b, o) { return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true); };
  u.f64 = function (b, o) { return new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, false); };

  u.concat = function (chunks) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  };

  u.ascii = function (b, o, n) {
    let s = '';
    for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]);
    return s;
  };

  u.toHex = function (b) {
    let s = '';
    for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  };

  u.fromHex = function (s) {
    const n = s.length >> 1, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  };

  /* ---------- utf8 ---------- */
  u.utf8Encode = function (s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    if (isNode()) return new Uint8Array(Buffer.from(s, 'utf8'));
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const c2 = s.charCodeAt(++i);
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  };

  u.utf8Decode = function (b, start, end) {
    start = start || 0; end = end === undefined ? b.length : end;
    const slice = b.subarray(start, end);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(slice);
    if (isNode()) return Buffer.from(slice).toString('utf8');
    let s = '';
    for (let i = 0; i < slice.length;) {
      const c = slice[i++];
      if (c < 0x80) s += String.fromCharCode(c);
      else if (c < 0xe0) s += String.fromCharCode(((c & 31) << 6) | (slice[i++] & 63));
      else if (c < 0xf0) s += String.fromCharCode(((c & 15) << 12) | ((slice[i++] & 63) << 6) | (slice[i++] & 63));
      else {
        const cp = ((c & 7) << 18) | ((slice[i++] & 63) << 12) | ((slice[i++] & 63) << 6) | (slice[i++] & 63);
        const v = cp - 0x10000;
        s += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 1023));
      }
    }
    return s;
  };

  /* ---------- crc32 / md5 ---------- */
  let crcTable = null;
  u.crc32 = function (bytes, start, end) {
    start = start || 0; end = end === undefined ? bytes.length : end;
    if (!crcTable) {
      crcTable = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c;
      }
    }
    let crc = -1;
    for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  };

  u.md5 = function (bytes) {
    // minimal MD5 (RFC 1321) over Uint8Array -> hex lowercase
    function add32(a, b) { return (a + b) >>> 0; }
    function rol(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
    const msgLen = bytes.length;
    const withOne = new Uint8Array(((msgLen + 8) >> 6) * 64 + 64);
    withOne.set(bytes);
    withOne[msgLen] = 0x80;
    const totalBits = msgLen * 8;
    const dv = new DataView(withOne.buffer);
    const last = withOne.length;
    dv.setUint32(last - 8, totalBits >>> 0, true);
    dv.setUint32(last - 4, Math.floor(totalBits / 0x100000000), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
    const M = new Uint32Array(16);
    for (let off = 0; off < withOne.length; off += 64) {
      for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = add32(F, add32(A, add32(K[i], M[g])));
        A = D; D = C; C = B;
        B = add32(B, rol(F, S[i]));
      }
      a0 = add32(a0, A); b0 = add32(b0, B); c0 = add32(c0, C); d0 = add32(d0, D);
    }
    function w(x) {
      return [x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255];
    }
    return u.toHex(new Uint8Array([].concat(w(a0), w(b0), w(c0), w(d0))));
  };

  /* ---------- ids ---------- */
  function b64url(bytes) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += chars[b0 >> 2];
      out += chars[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
      if (b1 === undefined) break;
      out += chars[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
      if (b2 === undefined) break;
      out += chars[b2 & 63];
    }
    return out;
  }

  u.randomBytes = function (n) {
    const b = new Uint8Array(n);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(b);
    else if (isNode()) { const c = require('crypto'); b.set(c.randomBytes(n)); }
    else for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0;
    return b;
  };

  u.uid = function () { return b64url(u.randomBytes(16)); };

  /* ---------- byte reader ---------- */
  function Reader(bytes, pos) {
    this.b = bytes;
    this.p = pos || 0;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  Reader.prototype = {
    eof: function () { return this.p >= this.b.length; },
    left: function () { return this.b.length - this.p; },
    seek: function (p) { this.p = p; return this; },
    skip: function (n) { this.p += n; return this; },
    u8: function () { return this.b[this.p++]; },
    u16: function () { const v = this.dv.getUint16(this.p, false); this.p += 2; return v; },
    i16: function () { const v = this.dv.getInt16(this.p, false); this.p += 2; return v; },
    u32: function () { const v = this.dv.getUint32(this.p, false); this.p += 4; return v; },
    i32: function () { const v = this.dv.getInt32(this.p, false); this.p += 4; return v; },
    f32: function () { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; },
    f64be: function () { const v = this.dv.getFloat64(this.p, false); this.p += 8; return v; },
    bytes: function (n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; },
    str: function (n) { const v = u.ascii(this.b, this.p, n); this.p += n; return v; }
  };
  u.Reader = Reader;

  /* ---------- misc ---------- */
  u.clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  u.fmtSize = function (n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  };

  if (isNode()) module.exports = u;
  else root.BC = Object.assign(root.BC || {}, { util: u });
})(typeof globalThis !== 'undefined' ? globalThis : this);
