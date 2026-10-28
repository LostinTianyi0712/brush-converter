/* Minimal ZIP reader/writer (store + deflate) */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const zlib = isNode ? require('./zlib.js') : root.BC.zlib;

  function isZip(bytes) {
    return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7);
  }

  /* List entries: [{name, data(), size, dir}] */
  function read(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const le16 = o => dv.getUint16(o, true);
    const le32 = o => dv.getUint32(o, true);
    // locate End of Central Directory
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 70000); i--) {
      if (le32(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
    const count = le16(eocd + 10);
    const cdOff = le32(eocd + 16);
    const entries = [];
    let p = cdOff;
    for (let i = 0; i < count; i++) {
      if (le32(p) !== 0x02014b50) break;
      const flags = le16(p + 8);
      const method = le16(p + 10);
      const compSize = le32(p + 20);
      const size = le32(p + 24);
      const nameLen = le16(p + 28);
      const extraLen = le16(p + 30);
      const commentLen = le16(p + 32);
      const localOff = le32(p + 42);
      const name = util.utf8Decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries.push({ name, flags, method, compSize, size, localOff, dir: name.endsWith('/') });
      p += 46 + nameLen + extraLen + commentLen;
    }
    for (const e of entries) {
      if (e.dir) continue;
      const lp = e.localOff;
      if (le32(lp) !== 0x04034b50) throw new Error('ZIP 局部头损坏: ' + e.name);
      const lnl = le16(lp + 26), lel = le16(lp + 28);
      const start = lp + 30 + lnl + lel;
      e._raw = bytes.subarray(start, start + e.compSize);
      e.data = function () {
        if (this.method === 0) return this._raw;
        if (this.method === 8) return zlib.inflateRaw(this._raw);
        throw new Error('不支持的 ZIP 压缩方式 ' + this.method + ' (' + this.name + ')');
      };
    }
    return entries;
  }

  function dosDateTime(d) {
    const year = d.getFullYear();
    const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    return { date, time };
  }

  /* Write zip: files: [{name, data: Uint8Array}] */
  function write(files) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const now = dosDateTime(new Date());
    for (const f of files) {
      const nameBytes = util.utf8Encode(f.name);
      const crc = util.crc32(f.data);
      const comp = zlib.deflateRaw(f.data, 9);
      const useDeflate = comp.length < f.data.length;
      const data = useDeflate ? comp : f.data;
      const method = useDeflate ? 8 : 0;
      const local = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true); // utf8
      dv.setUint16(8, method, true);
      dv.setUint16(10, now.time, true);
      dv.setUint16(12, now.date, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, f.data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      chunks.push(local, data);
      const cen = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, now.time, true);
      cv.setUint16(14, now.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, f.data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);
      offset += local.length + data.length;
    }
    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) { chunks.push(c); cdSize += c.length; }
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    chunks.push(eocd);
    return util.concat(chunks);
  }

  /* Write a zip the way 天生会画/GoPaint writes .gobrush archives:
     everything deflated, UTF-8 + data-descriptor flags (0x080A), data descriptors
     after each entry, create_version 45 in the central directory and the brush uuid
     as the archive comment. */
  function writeGopaint(files, comment) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const now = dosDateTime(new Date());
    const commentBytes = util.utf8Encode(comment || '');
    for (const f of files) {
      const nameBytes = util.utf8Encode(f.name);
      const crc = util.crc32(f.data);
      const data = zlib.deflateRaw(f.data, 9);
      const local = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x080a, true);
      dv.setUint16(8, 8, true);
      dv.setUint16(10, now.time, true);
      dv.setUint16(12, now.date, true);
      dv.setUint32(14, 0, true);
      dv.setUint32(18, 0, true);
      dv.setUint32(22, 0, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      const desc = new Uint8Array(16);
      const dd = new DataView(desc.buffer);
      dd.setUint32(0, 0x08074b50, true);
      dd.setUint32(4, crc, true);
      dd.setUint32(8, data.length, true);
      dd.setUint32(12, f.data.length, true);
      chunks.push(local, data, desc);
      const cen = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 45, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x080a, true);
      cv.setUint16(10, 8, true);
      cv.setUint16(12, now.time, true);
      cv.setUint16(14, now.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, f.data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);
      offset += local.length + data.length + desc.length;
    }
    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) { chunks.push(c); cdSize += c.length; }
    const eocd = new Uint8Array(22 + commentBytes.length);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    ev.setUint16(20, commentBytes.length, true);
    eocd.set(commentBytes, 22);
    chunks.push(eocd);
    return util.concat(chunks);
  }

  const api = { isZip, read, write, writeGopaint };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { zip: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);


