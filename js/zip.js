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
    // 从尾部往前找「自洽」的 EOCD：注释长度不能越过文件末尾，中央目录必须落在它前面。
    // 这样既能容忍 EOCD 之后被追加的垃圾字节（网盘/店铺水印、传输尾巴），
    // 又不会被注释里恰好出现的 0x06054b50 骗到。
    let eocd = -1, looseEocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (le32(i) !== 0x06054b50) continue;
      const tailEnd = i + 22 + le16(i + 20);
      if (tailEnd > bytes.length) continue;
      const cdS = le32(i + 12), cdO = le32(i + 16), n = le16(i + 10);
      if (cdO === 0xffffffff || cdS === 0xffffffff || n === 0xffff) { looseEocd = i; continue; }
      // 空包后面还挂着字节：不像真的 EOCD（数据里常出现这种全零伪记录）
      if (!n) { if (tailEnd === bytes.length) { eocd = i; break; } continue; }
      if (cdS < 46 || cdO + cdS > i) { looseEocd = i; continue; }
      if (le32(cdO) !== 0x02014b50) { looseEocd = i; continue; } // 签名不对：中央目录被改坏了
      eocd = i;
      break;
    }
    if (eocd < 0) {
      // 找到 EOCD 但中央目录读不通：这是「坏包」，给准确一点的说法
      if (looseEocd >= 0) throw new Error('ZIP 中央目录损坏或条目不完整');
      // 有 PK 头却找不到自洽的 EOCD：多半是没下完整（网盘断点、传输截断），别只说「不是 ZIP」
      const looksZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
      throw new Error(looksZip ? '不是有效的 ZIP 文件（像是没下载完整）' : '不是有效的 ZIP 文件');
    }
    const count = le16(eocd + 10);
    const cdOff = le32(eocd + 16);
    const cdSize = le32(eocd + 12), cdEnd = cdOff + cdSize;
    if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new Error('暂不支持 ZIP64 压缩包');
    if (le16(eocd + 4) || le16(eocd + 6) || le16(eocd + 8) !== count) throw new Error('暂不支持 ZIP 分卷压缩包');
    if (cdEnd > eocd || (count && cdSize < 46)) throw new Error('ZIP 中央目录长度异常');
    const entries = [];
    let p = cdOff;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cdEnd || le32(p) !== 0x02014b50) throw new Error('ZIP 中央目录损坏或条目不完整');
      const flags = le16(p + 8);
      const method = le16(p + 10);
      const compSize = le32(p + 20);
      const size = le32(p + 24);
      const nameLen = le16(p + 28);
      const extraLen = le16(p + 30);
      const commentLen = le16(p + 32);
      const localOff = le32(p + 42);
      if (p + 46 + nameLen + extraLen + commentLen > cdEnd) throw new Error('ZIP 中央目录条目长度异常');
      if (compSize === 0xffffffff || size === 0xffffffff || localOff === 0xffffffff) throw new Error('暂不支持 ZIP64 条目');
      const crc = le32(p + 16);
      const name = util.utf8Decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries.push({ name, flags, method, compSize, size, localOff, crc, dir: name.endsWith('/') });
      p += 46 + nameLen + extraLen + commentLen;
    }
    /* 【第196轮】解压前的前置闸门（第189轮审查 P1-#4：100KB 的 zip 能展开成 1.36GB 常驻）。
       pako 不支持 maxOutputLength，所以只能在 inflate 之前用 ZIP 头声明的 size 拦：
       单条目 ≤512MB、全包合计 ≤1GB、单条目压缩比 ≤1000:1（笔刷纹理远低于此）。
       头里的 size 是攻击者可控的——正因如此不能照单分配，超限直接拒绝。 */
    const MAX_ENTRY = 512 * 1024 * 1024, MAX_TOTAL = 1024 * 1024 * 1024, MAX_RATIO = 1000;
    const spans = [];
    let totalSize = 0;
    for (const e of entries) {
      if (!(e.size >= 0) || !(e.compSize >= 0)) throw new Error('ZIP 条目长度非法: ' + e.name);
      if (e.size > MAX_ENTRY) throw new Error('ZIP 条目解压后过大（' + e.size + 'B）: ' + e.name);
      totalSize += e.size;
      if (totalSize > MAX_TOTAL) throw new Error('ZIP 解压总量超限（>1GB）: ' + e.name);
      if (e.size > 0 && e.compSize > 0 && e.size / e.compSize > MAX_RATIO) {
        throw new Error('ZIP 压缩比异常（' + Math.round(e.size / e.compSize) + ':1）: ' + e.name);
      }
    }
    for (const e of entries) {
      if (e.dir) continue;
      const lp = e.localOff;
      if (lp + 30 > cdOff || le32(lp) !== 0x04034b50) throw new Error('ZIP 局部头损坏: ' + e.name);
      if (e.flags & 1) throw new Error('暂不支持 ZIP 加密条目: ' + e.name);
      if (le16(lp + 8) !== e.method || (le16(lp + 6) & 1)) throw new Error('ZIP 局部头编码不一致: ' + e.name);
      const lnl = le16(lp + 26), lel = le16(lp + 28);
      const start = lp + 30 + lnl + lel;
      if (start + e.compSize > cdOff) throw new Error('ZIP 数据截断或长度异常: ' + e.name);
      spans.push([start, start + e.compSize, e.name]);
      e._raw = bytes.subarray(start, start + e.compSize);
      e.data = function () {
        let data;
        if (this.method === 0) data = this._raw;
        else if (this.method === 8) {
          try { data = zlib.inflateRaw(this._raw); }
          catch (err) { throw new Error('ZIP 解压失败: ' + this.name + ' (' + (err && err.message ? err.message : String(err)) + ')'); }
        }
        else throw new Error('不支持的 ZIP 压缩方式 ' + this.method + ' (' + this.name + ')');
        if (!data || data.length !== this.size) throw new Error('ZIP 解压后长度异常: ' + this.name);
        if (util.crc32(data) !== this.crc) throw new Error('ZIP 数据校验失败，文件可能已损坏: ' + this.name);
        return data;
      };
    }
    /* 条目数据区间不得互相重叠：12 个条目共用同一段 100MB 流时，逐个 inflate 会把同一块
       数据反复展开（第189轮反例 rss 1.36GB）。合法 zip 里不会出现重叠。 */
    spans.sort(function (a, b) { return a[0] - b[0]; });
    for (let i = 1; i < spans.length; i++) {
      if (spans[i][0] < spans[i - 1][1]) throw new Error('ZIP 条目数据重叠: ' + spans[i - 1][2] + ' 与 ' + spans[i][2]);
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


