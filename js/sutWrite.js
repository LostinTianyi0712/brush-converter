/* .sut writer — rebuild a Clip Studio Paint brush material database from a template.

   A .sut is a plain SQLite 3 file:
     Manager / Node / Variant / MaterialFile / sqlite_sequence
   MaterialFile.FileData stores a (PAX/ustar) tar archive whose members are
   catalog.zip, data/material.layer (encrypted C2F), icedata/layerData.xml,
   info.zip and thumbnail/thumbnail.png (a readable 1024x1024 RGBA PNG).

   This module keeps every table row as close to the template as possible
   (raw record values, rowids, schema SQL, sqlite_sequence) and only repacks
   the tar inside selected MaterialFile rows after swapping
   thumbnail/thumbnail.png.  The whole SQLite file is then rebuilt with the
   template page size, one table b-tree per table (leaf pages + interior
   root pages + overflow chains for large BLOBs).

   Pure JS: all input/output is Uint8Array, no Node fs/Buffer usage, so it
   runs both in the Electron app and in a browser bundle.
   API:
     buildSut(templateBytes, overrides) -> Uint8Array
     overrides: [{ materialUuid? , index?, thumbnailPng: Uint8Array,
                   params?: {Variant列名: 值}, variantIndex?,
                   nodeName?: string, nodeIndex? }]
   `index` is the 0-based row position in MaterialFile (ordered by _PW_ID).
   `params` / `nodeName` 不需要 material 定位字段；variantIndex/nodeIndex 缺省时
   应用到全部 Variant / Node 行（CSP 模板的 Variant 行是同一子工具的参数副本）。 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const sqlite = isNode ? require('./sqlite.js') : root.BC.sqlite;

  const TAR_BLOCK = 512;
  const TAR_RECORD = 10240; // libarchive/bsdtar default blocking factor

  /* ------------------------------ byte helpers ------------------------------ */
  function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function w16(b, o, v) { b[o] = (v >>> 8) & 0xff; b[o + 1] = v & 0xff; }
  function w32(b, o, v) { b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff; }
  function zeros(n) { return new Uint8Array(n); }
  function pad512(n) { return (TAR_BLOCK - (n % TAR_BLOCK)) % TAR_BLOCK; }

  /* SQLite varint length. Values here are payload sizes / rowids (<= 2^53). */
  function varintLen(v) {
    v = Math.floor(v);
    if (!(v > 0)) return 1;
    let len = 0;
    while (v > 0 && len < 9) { len++; v = Math.floor(v / 128); }
    return len;
  }

  function writeVarint(v, buf, off) {
    const digits = [];
    v = Math.floor(v);
    if (v < 0) v = 0;
    do { digits.push(v % 128); v = Math.floor(v / 128); } while (v > 0);
    // Big-endian groups: every byte except the last (least significant) one
    // carries the continuation bit.  (Reversing the low-first groups without
    // fixing the bits is the classic varint bug this replaces.)
    for (let i = digits.length - 1; i >= 0; i--) {
      buf[off++] = i === 0 ? digits[i] : (digits[i] | 0x80);
    }
    return off;
  }

  /* UTF-8 byte length without allocating (matches util.utf8Encode/TextEncoder). */
  function utf8ByteLen(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length &&
               s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /* --------------------------- SQLite record codec --------------------------- */
  /* Serial types: 0 null, 1..6 ints, 7 float, 8/9 constant 0/1,
     12+2n blob, 13+2n text. */
  function valueSerialType(v) {
    if (v === null || v === undefined) return 0;
    if (v instanceof Uint8Array) return 12 + 2 * v.length;
    if (typeof v === 'string') return 13 + 2 * utf8ByteLen(v);
    if (typeof v === 'number') {
      if (!isFinite(v)) throw new Error('sutWrite: 不能编码 NaN/Infinity');
      if (Number.isInteger(v)) {
        if (v === 0) return 8;
        if (v === 1) return 9;
        if (v >= -128 && v <= 127) return 1;
        if (v >= -32768 && v <= 32767) return 2;
        if (v >= -8388608 && v <= 8388607) return 3;
        if (v >= -2147483648 && v <= 2147483647) return 4;
        if (v >= -140737488355328 && v <= 140737488355327) return 5;
        return 6;
      }
      return 7;
    }
    if (typeof v === 'boolean') return v ? 9 : 8;
    throw new Error('sutWrite: 无法编码的值类型 ' + typeof v);
  }

  function serialDataLen(t) {
    if (t === 0 || t === 8 || t === 9) return 0;
    if (t >= 1 && t <= 4) return t;
    if (t === 5) return 6;
    if (t === 6 || t === 7) return 8;
    return (t - 12) >> 1; // text / blob
  }

  /* Two's-complement integer bytes.  No BigInt / BigInt literals: the bundle
     must stay parseable by Chrome 61 (ES2017), like core/bru.js. */
  function encodeInteger(v, t) {
    const size = serialDataLen(t);
    if (!size) return null; // constant 0/1 serial types carry no payload
    const out = new Uint8Array(size);
    if (size <= 4) {
      let u = v;
      if (u < 0) u += Math.pow(2, size * 8); // exact: all values fit in 53 bits
      for (let i = size - 1; i >= 0; i--) { out[i] = u % 256; u = Math.floor(u / 256); }
      return out;
    }
    if (size === 6) { // 48-bit two's complement
      let u = v < 0 ? v + 281474976710656 : v;
      for (let i = 5; i >= 0; i--) { out[i] = u % 256; u = Math.floor(u / 256); }
      return out;
    }
    // 64-bit two's complement via two 32-bit halves (JS numbers are exact
    // integers up to 2^53, which covers every value SQLite would round-trip).
    let lo, hi;
    if (v >= 0) {
      lo = v % 4294967296;
      hi = Math.floor(v / 4294967296);
    } else {
      const neg = -v;
      const negLo = neg % 4294967296;
      const negHi = Math.floor(neg / 4294967296);
      lo = negLo === 0 ? 0 : 4294967296 - negLo;
      hi = (4294967296 - negHi - (negLo === 0 ? 0 : 1)) % 4294967296;
    }
    out[0] = (hi >>> 24) & 0xff; out[1] = (hi >>> 16) & 0xff;
    out[2] = (hi >>> 8) & 0xff; out[3] = hi & 0xff;
    out[4] = (lo >>> 24) & 0xff; out[5] = (lo >>> 16) & 0xff;
    out[6] = (lo >>> 8) & 0xff; out[7] = lo & 0xff;
    return out;
  }

  function encodeRecord(values) {
    const types = [];
    const parts = [];
    let dataLen = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      const t = valueSerialType(v);
      types.push(t);
      let data = null;
      if (t >= 12) data = (v instanceof Uint8Array) ? v : util.utf8Encode(v);
      else if (t === 7) {
        data = new Uint8Array(8);
        new DataView(data.buffer, data.byteOffset, 8).setFloat64(0, v, false);
      } else if (t >= 1 && t <= 6) data = encodeInteger(v, t);
      if (data) { parts.push(data); dataLen += data.length; }
    }
    let typeLen = 0;
    for (const t of types) typeLen += varintLen(t);
    let fieldLen = 1;
    let headerLen;
    for (;;) {
      headerLen = fieldLen + typeLen;
      const next = varintLen(headerLen);
      if (next === fieldLen) break;
      fieldLen = next;
    }
    const payload = new Uint8Array(headerLen + dataLen);
    let p = writeVarint(headerLen, payload, 0);
    for (const t of types) p = writeVarint(t, payload, p);
    for (const d of parts) { payload.set(d, p); p += d.length; }
    return payload;
  }

  /* Payload byte length without building the payload (used for page packing). */
  function recordSize(values) {
    let typeLen = 0;
    let dataLen = 0;
    for (let i = 0; i < values.length; i++) {
      const t = valueSerialType(values[i]);
      typeLen += varintLen(t);
      dataLen += serialDataLen(t);
    }
    let fieldLen = 1;
    for (;;) {
      const total = fieldLen + typeLen;
      const next = varintLen(total);
      if (next === fieldLen) return total + dataLen;
      fieldLen = next;
    }
  }

  /* Bytes of the payload stored on the b-tree page (rest goes to overflow). */
  function localSize(total, usable) {
    const maxLocal = usable - 35;
    if (total <= maxLocal) return total;
    const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
    let k = minLocal + ((total - minLocal) % (usable - 4));
    if (k > maxLocal) k = minLocal;
    return k;
  }

  /* --------------------------------- tar I/O --------------------------------- */
  function tarCString(b, off, len) {
    let end = off;
    const stop = Math.min(off + len, b.length);
    while (end < stop && b[end] !== 0) end++;
    return util.utf8Decode(b.subarray(off, end));
  }

  function tarNumber(b, off, len) {
    if (b[off] & 0x80) { // GNU base-256 encoding (only non-negative sizes matter)
      let n = b[off] & 0x7f;
      for (let i = 1; i < len; i++) n = n * 256 + b[off + i];
      return n;
    }
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = b[off + i];
      if (c === 0 || c === 0x20) break;
      s += String.fromCharCode(c);
    }
    const n = parseInt(s, 8);
    return isNaN(n) ? 0 : n;
  }

  function writeTarNumber(h, off, len, value) {
    const maxOctal = Math.pow(8, len - 1) - 1;
    if (value > maxOctal) { // GNU base-256 for absurdly large members
      let n = value;
      for (let i = len - 1; i >= 0; i--) { h[off + i] = n % 256; n = Math.floor(n / 256); }
      h[off] |= 0x80;
      return;
    }
    const digits = len - 1;
    const s = Math.floor(value).toString(8);
    for (let i = 0; i < digits; i++) h[off + i] = 0x30;
    for (let i = 0; i < s.length; i++) h[off + digits - s.length + i] = s.charCodeAt(i);
    h[off + len - 1] = 0;
  }

  function writeTarChecksum(h) {
    for (let i = 148; i < 156; i++) h[i] = 0x20;
    let sum = 0;
    for (let i = 0; i < TAR_BLOCK; i++) sum += h[i];
    const s = sum.toString(8).padStart(6, '0');
    for (let i = 0; i < 6; i++) h[148 + i] = s.charCodeAt(i);
    h[154] = 0;
    h[155] = 0x20;
  }

  function tarEntryName(h) {
    let name = tarCString(h, 0, 100);
    const magic = util.ascii(h, 257, 6).replace(/\u0000/g, '');
    if (magic === 'ustar') {
      const prefix = tarCString(h, 345, 155);
      if (prefix) name = prefix + '/' + name;
    }
    return name;
  }

  /* PAX records look like "<len> key=value\n".
     长度前缀是**字节**数（POSIX tar 规范），不是字符数：值里出现中文/日文路径时
     按字符串下标切分会整体错位（#275）。这里全程在字节层面分帧与计数。 */
  function parsePaxRecords(data) {
    const out = [];
    const n = data.length;
    let p = 0;
    while (p < n) {
      let sp = -1;
      for (let i = p; i < n && i < p + 24; i++) { if (data[i] === 0x20) { sp = i; break; } }
      if (sp < 0) break;
      let len = 0;
      let digits = true;
      for (let i = p; i < sp; i++) {
        const c = data[i];
        if (c < 0x30 || c > 0x39) { digits = false; break; }
        len = len * 10 + (c - 0x30);
      }
      if (!digits || !len || p + len > n) break;
      const recEnd = p + len;
      let vEnd = recEnd;
      if (vEnd > sp + 1 && data[vEnd - 1] === 0x0a) vEnd--;
      let eq = -1;
      for (let i = sp + 1; i < vEnd; i++) { if (data[i] === 0x3d) { eq = i; break; } }
      if (eq >= 0) {
        out.push({
          key: util.utf8Decode(data.subarray(sp + 1, eq)),
          value: util.utf8Decode(data.subarray(eq + 1, vEnd))
        });
      }
      p = recEnd;
    }
    return out;
  }

  function paxRecord(key, value) {
    const body = util.utf8Encode(' ' + key + '=' + value + '\n');
    let total = body.length + 1;
    for (let i = 0; i < 10; i++) {
      const next = body.length + String(total).length;
      if (next === total) break;
      total = next;
    }
    const head = util.utf8Encode(String(total));
    const rec = new Uint8Array(head.length + body.length);
    rec.set(head, 0);
    rec.set(body, head.length);
    return rec;
  }

  function formatPaxRecords(records) {
    const parts = [];
    let total = 0;
    for (const r of records) { const part = paxRecord(r.key, r.value); parts.push(part); total += part.length; }
    const out = new Uint8Array(total);
    let off = 0;
    for (const part of parts) { out.set(part, off); off += part.length; }
    return out;
  }

  /* Parse a tar archive (ustar + PAX). Returns entries in original order.
     Each entry: {kind:'pax'|'file', header:Uint8Array(512), data, name?, records?} */
  function parseTar(bytes) {
    const entries = [];
    let pos = 0;
    let pendingPax = [];
    while (pos + TAR_BLOCK <= bytes.length) {
      const h = bytes.subarray(pos, pos + TAR_BLOCK);
      if (!tarCString(h, 0, 100)) break; // zero block -> end of archive
      const size = tarNumber(h, 124, 12);
      const type = h[156] || 0x30;
      const dataStart = pos + TAR_BLOCK;
      if (size < 0 || dataStart + size > bytes.length) throw new Error('sutWrite: tar 成员长度越界');
      const data = bytes.subarray(dataStart, dataStart + size);
      if (type === 0x78 || type === 0x67) { // 'x' / 'g' PAX header
        const item = { kind: 'pax', header: h.slice(), data: data, type: type, records: parsePaxRecords(data) };
        entries.push(item);
        pendingPax.push(item);
      } else {
        let name = tarEntryName(h);
        for (const p of pendingPax) {
          for (const r of p.records) if (r.key === 'path') name = r.value;
        }
        entries.push({ kind: 'file', header: h.slice(), data: data, type: type, name: name });
        pendingPax = [];
      }
      pos = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    }
    return { entries: entries, logicalEnd: pos };
  }

  function isThumbnailName(name) {
    const n = String(name || '').replace(/^\.\//, '');
    return /^thumbnail\/thumbnail\.png$/i.test(n) || /(^|\/)thumbnail\.png$/i.test(n);
  }

  function tarEntryNames(parsed) {
    return parsed.entries.filter(function (e) { return e.kind === 'file'; }).map(function (e) { return e.name; });
  }

  /* Replace thumbnail/thumbnail.png (and any *[slash]thumbnail.png member) in a tar
     archive, preserving member order, headers and PAX metadata. */
  function replaceTarThumbnail(tarBytes, pngBytes) {
    const parsed = parseTar(tarBytes);
    const parts = [];
    let pending = [];
    let found = 0;

    function flushPax(target, newLen) {
      for (const p of pending) {
        let data = p.data;
        let header = p.header;
        if (target) {
          let sawSize = false;
          const recs = [];
          for (const r of p.records) {
            if (r.key === 'size') { recs.push({ key: 'size', value: String(newLen) }); sawSize = true; }
            else recs.push({ key: r.key, value: r.value });
          }
          if (sawSize) {
            data = formatPaxRecords(recs);
            header = p.header.slice();
            writeTarNumber(header, 124, 12, data.length);
            writeTarChecksum(header);
          }
        }
        parts.push(header, data, zeros(pad512(data.length)));
      }
      pending = [];
    }

    for (const item of parsed.entries) {
      if (item.kind === 'pax') { pending.push(item); continue; }
      const target = isThumbnailName(item.name);
      const data = target ? pngBytes : item.data;
      flushPax(target, pngBytes.length);
      let header = item.header;
      if (target) {
        header = item.header.slice();
        writeTarNumber(header, 124, 12, pngBytes.length);
        writeTarChecksum(header);
        found++;
      }
      parts.push(header, data, zeros(pad512(data.length)));
    }
    flushPax(false, 0);
    if (!found) {
      throw new Error('sutWrite: tar 里没有 thumbnail/thumbnail.png（成员: ' +
        tarEntryNames(parsed).join(', ') + '）');
    }
    parts.push(zeros(2 * TAR_BLOCK)); // end of archive
    const blocking = (tarBytes.length % TAR_RECORD === 0 && tarBytes.length >= TAR_RECORD) ? TAR_RECORD : TAR_BLOCK;
    const total = util.concat(parts);
    if (total.length % blocking) return util.concat([total, zeros(blocking - (total.length % blocking))]);
    return total;
  }

  /* ---------------------------- input normalisation --------------------------- */
  function isPngBytes(b) {
    return !!b && b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  }

  /* override 支持三类（可任意组合在同一对象里，也可分开传）：
       1) 缩略图替换：{ index? | materialUuid?, thumbnailPng: Uint8Array }
       2) Variant 参数覆写：{ params: {列名: 值}, variantIndex?: number }
          —— variantIndex 缺省时应用到全部 Variant 行（CSP 模板的多个 Variant 是
             同一子工具的参数副本，Node.NodeVariantID 会引用其中特定行，全部覆写
             才能保证读回一致）
       3) Node 重命名：{ nodeName: string, nodeIndex?: number }
     纯参数/重命名的 override 不需要 material 定位字段。 */
  function normalizeOverrides(overrides) {
    if (overrides === null || overrides === undefined) return [];
    const list = Array.isArray(overrides) ? overrides : [overrides];
    return list.map(function (o, i) {
      if (!o || typeof o !== 'object') throw new Error('sutWrite: overrides[' + i + '] 不是对象');
      const hasThumb = o.thumbnailPng !== undefined;
      const hasParams = o.params !== undefined;
      const hasName = o.nodeName !== undefined;
      if (!hasThumb && !hasParams && !hasName) {
        throw new Error('sutWrite: overrides[' + i + '] 需要 thumbnailPng / params / nodeName 之一');
      }
      if (hasThumb) {
        if (!isPngBytes(o.thumbnailPng)) throw new Error('sutWrite: overrides[' + i + '].thumbnailPng 不是 PNG');
        if (o.index !== undefined && (!Number.isInteger(o.index) || o.index < 0)) {
          throw new Error('sutWrite: overrides[' + i + '].index 必须是非负整数');
        }
        // 无定位字段时默认替换全部 MaterialFile 行（CSP 读哪行都拿到新缩略图）
        o._allMaterials = (o.materialUuid === undefined && o.index === undefined);
      }
      if (hasParams) {
        if (!o.params || typeof o.params !== 'object' || Array.isArray(o.params)) {
          throw new Error('sutWrite: overrides[' + i + '].params 必须是 {列名: 值} 对象');
        }
        if (o.variantIndex !== undefined && (!Number.isInteger(o.variantIndex) || o.variantIndex < 0)) {
          throw new Error('sutWrite: overrides[' + i + '].variantIndex 必须是非负整数');
        }
      }
      if (hasName) {
        if (typeof o.nodeName !== 'string' || !o.nodeName.length) {
          throw new Error('sutWrite: overrides[' + i + '].nodeName 必须是非空字符串');
        }
        if (o.nodeIndex !== undefined && (!Number.isInteger(o.nodeIndex) || o.nodeIndex < 0)) {
          throw new Error('sutWrite: overrides[' + i + '].nodeIndex 必须是非负整数');
        }
      }
      return o;
    });
  }

  /* CSP stores the material UUID inside CatalogPath/OriginalPath strings that
     look like ".:12:45:a3386b6092-144c-..."; MaterialUuid itself is often empty.
     Compare UUIDs ignoring dashes/prefixes. */
  function normalizeUuid(v) {
    return String(v === null || v === undefined ? '' : v).toLowerCase().replace(/[^0-9a-f]/g, '');
  }

  function resolveMaterialRow(rows, columns, override, label) {
    const iUuid = columns.indexOf('MaterialUuid');
    if (override.materialUuid !== undefined && override.materialUuid !== null) {
      const want = normalizeUuid(override.materialUuid);
      if (want) {
        let hits = [];
        if (iUuid >= 0) {
          for (let i = 0; i < rows.length; i++) {
            if (normalizeUuid(rows[i].values[iUuid]) === want) hits.push(i);
          }
        }
        if (!hits.length) {
          // fallback: UUID embedded in CatalogPath / OriginalPath
          const pathCols = ['CatalogPath', 'OriginalPath']
            .map(function (c) { return columns.indexOf(c); })
            .filter(function (i) { return i >= 0; });
          for (let i = 0; i < rows.length; i++) {
            for (const ci of pathCols) {
              const blob = normalizeUuid(rows[i].values[ci]);
              if (blob && blob.indexOf(want) >= 0) { hits.push(i); break; }
            }
          }
        }
        if (hits.length === 1) return rows[hits[0]];
        if (hits.length > 1) {
          throw new Error('sutWrite: materialUuid=' + override.materialUuid +
            ' 匹配到多行 MaterialFile（' + hits.join(', ') + '），请改用 index');
        }
      }
      throw new Error('sutWrite: 模板里没有 materialUuid=' + override.materialUuid +
        ' 的材质行（可用 index 指定行号）');
    }
    const idx = override.index;
    if (idx >= rows.length) {
      throw new Error('sutWrite: MaterialFile 只有 ' + rows.length + ' 行，index=' + idx + ' 越界');
    }
    return rows[idx];
  }

  /* --------------------------------- builder --------------------------------- */
  function buildSut(templateBytes, overrides) {
    if (!(templateBytes instanceof Uint8Array)) throw new Error('sutWrite: templateBytes 必须是 Uint8Array');
    if (!sqlite.isSqlite(templateBytes)) throw new Error('sutWrite: 模板不是 SQLite 数据库（.sut）');
    const db = sqlite.read(templateBytes);
    const pageSize = db.pageSize;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
      throw new Error('sutWrite: 不支持的 SQLite 页大小 ' + pageSize);
    }
    const reserved = templateBytes[20] || 0;
    const usable = pageSize - reserved;
    if (usable < 480) throw new Error('sutWrite: 页可用空间太小');
    if (db.encoding !== 1) {
      throw new Error('sutWrite: 暂只支持 UTF-8 文本编码的模板（encoding=' + db.encoding + '）');
    }
    if (!Array.isArray(db.master) || !db.master.length) throw new Error('sutWrite: 模板缺少 sqlite_master');

    /* --- clone tables from raw records (keeps every stored value + rowid) --- */
    const tables = db.tables.map(function (t) {
      const raw = (t.rawRows && t.rawRows.length !== undefined) ? t.rawRows : (t.rows || []);
      return {
        name: t.name,
        sql: t.sql,
        columns: t.columns || [],
        rootPage: t.rootPage,
        rows: raw.map(function (r) {
          if (r.values) return { rowid: r.rowid, values: r.values.slice() };
          // fallback for older sqlite.js: rows keyed by column name
          return { rowid: r._rowid, values: (t.columns || []).map(function (c) { return r[c]; }) };
        })
      };
    });
    const tableByName = {};
    for (const t of tables) tableByName[t.name] = t;

    /* --- replace thumbnails inside MaterialFile.FileData --- */
    const material = tableByName.MaterialFile;
    if (!material) throw new Error('sutWrite: 模板里没有 MaterialFile 表');
    const colData = material.columns.indexOf('FileData');
    if (colData < 0) throw new Error('sutWrite: MaterialFile 没有 FileData 列');
    const list = normalizeOverrides(overrides);
    const replaced = [];
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o.thumbnailPng === undefined) continue; // 纯 params / nodeName 覆写
      if (o._allMaterials) {
        for (const row of material.rows) {
          const oldTar = row.values[colData];
          if (!(oldTar instanceof Uint8Array)) continue;
          row.values[colData] = replaceTarThumbnail(oldTar, o.thumbnailPng);
          replaced.push({ rowid: row.rowid, index: material.rows.indexOf(row) });
        }
        continue;
      }
      const row = resolveMaterialRow(material.rows, material.columns, o, 'overrides[' + i + ']');
      const oldTar = row.values[colData];
      if (!(oldTar instanceof Uint8Array)) throw new Error('sutWrite: 目标 MaterialFile 行没有 FileData');
      row.values[colData] = replaceTarThumbnail(oldTar, o.thumbnailPng);
      replaced.push({ rowid: row.rowid, index: material.rows.indexOf(row) });
    }

    /* --- Variant 参数覆写（应用到全部 Variant 行，或 variantIndex 指定行） --- */
    const variantTable = tableByName.Variant;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (!o.params) continue;
      if (!variantTable) throw new Error('sutWrite: 模板里没有 Variant 表，无法覆写参数');
      const rows = (o.variantIndex === undefined)
        ? variantTable.rows
        : [variantTable.rows[o.variantIndex]];
      for (const row of rows) {
        if (!row) throw new Error('sutWrite: variantIndex=' + o.variantIndex + ' 越界');
        for (const col in o.params) {
          const ci = variantTable.columns.indexOf(col);
          if (ci < 0) throw new Error('sutWrite: Variant 表没有列 ' + col);
          row.values[ci] = o.params[col];
        }
      }
    }

    /* --- Node 重命名（应用到全部 Node 行，或 nodeIndex 指定行） --- */
    const nodeTable = tableByName.Node;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o.nodeName === undefined) continue;
      if (!nodeTable) throw new Error('sutWrite: 模板里没有 Node 表，无法重命名');
      const ni = nodeTable.columns.indexOf('NodeName');
      if (ni < 0) throw new Error('sutWrite: Node 表没有 NodeName 列');
      const rows = (o.nodeIndex === undefined)
        ? nodeTable.rows
        : [nodeTable.rows[o.nodeIndex]];
      for (const row of rows) {
        if (!row) throw new Error('sutWrite: nodeIndex=' + o.nodeIndex + ' 越界');
        row.values[ni] = o.nodeName;
      }
    }

    /* --- verify every table has a supported rowid b-tree root --- */
    for (const t of tables) {
      if (!t.rootPage) throw new Error('sutWrite: 表 ' + t.name + ' 没有 b-tree 根页（WITHOUT ROWID 暂不支持）');
      const off = (t.rootPage - 1) * pageSize + (t.rootPage === 1 ? 100 : 0);
      const type = templateBytes[off];
      if (type !== 0x0d && type !== 0x05) {
        throw new Error('sutWrite: 表 ' + t.name + ' 的根页不是 rowid 表 b-tree（WITHOUT ROWID/WAL 暂不支持）');
      }
    }
    for (const obj of db.master) {
      if (obj.type === 'index') {
        throw new Error('sutWrite: 模板含索引 ' + obj.name + '，暂不支持重建（CSP .sut 一般没有索引）');
      }
    }

    /* --- page pool: page 1 is reserved for sqlite_master --- */
    const pages = [new Uint8Array(pageSize)];
    function allocPage() { pages.push(new Uint8Array(pageSize)); return pages.length; }

    function prepareRow(row) {
      const payloadLen = recordSize(row.values);
      const local = localSize(payloadLen, usable);
      const cellSize = varintLen(payloadLen) + varintLen(row.rowid) + local +
        (local < payloadLen ? 4 : 0);
      return { rowid: row.rowid, values: row.values, payloadLen: payloadLen, local: local, cellSize: cellSize };
    }

    /* Pack rows into leaf pages: cell pointer array (2 bytes/cell) + cell bytes. */
    function partitionRows(rows, pageCapacity) {
      const groups = [];
      let cur = [];
      let used = 0;
      for (const row of rows) {
        const need = row.cellSize + 2;
        if (cur.length && used + need > pageCapacity) { groups.push(cur); cur = []; used = 0; }
        if (!cur.length && need > pageCapacity) {
          throw new Error('sutWrite: 页太小，放不下一行记录（pageSize=' + pageSize + '）');
        }
        cur.push(row);
        used += need;
      }
      if (cur.length) groups.push(cur);
      return groups;
    }

    /* Group child nodes into interior pages. The capacity is the PAGE-1
       capacity (usable-112) for every level, which is 100 bytes more
       conservative than needed for normal pages but guarantees the root of
       sqlite_master fits on page 1. */
    function groupInteriors(nodes) {
      const cap = usable - 112;
      const groups = [];
      let cur = [];
      let cost = 4; // right-most child pointer
      for (const node of nodes) {
        if (!cur.length) { cur = [node]; cost = 4; continue; }
        const add = 4 + varintLen(cur[cur.length - 1].maxKey) + 2; // previous last becomes a cell
        if (cost + add <= cap) { cur.push(node); cost += add; }
        else { groups.push(cur); cur = [node]; cost = 4; }
      }
      if (cur.length) groups.push(cur);
      // A trailing group with a single child would create a 0-cell interior
      // page; move one child from the previous group.
      while (groups.length > 1 && groups[groups.length - 1].length < 2) {
        const prev = groups[groups.length - 2];
        if (prev.length > 2) groups[groups.length - 1].unshift(prev.pop());
        else { prev.push.apply(prev, groups.pop()); }
      }
      for (const g of groups) {
        if (g.length < 2) throw new Error('sutWrite: 内部页子节点不足');
      }
      return groups;
    }

    function makeLevel(nodes) {
      return groupInteriors(nodes).map(function (group) {
        return { kind: 'interior', children: group, maxKey: group[group.length - 1].maxKey };
      });
    }

    /* Build a table b-tree plan. master=true means the root must end up on
       page 1 (a leaf if everything fits, otherwise an interior page). */
    function buildTree(preparedRows, master) {
      let leafGroups;
      if (!preparedRows.length) {
        leafGroups = [[]];
      } else if (master) {
        let need = 0;
        for (const r of preparedRows) need += r.cellSize + 2;
        if (need <= usable - 108) leafGroups = [preparedRows];
        else leafGroups = partitionRows(preparedRows, usable - 8);
      } else {
        leafGroups = partitionRows(preparedRows, usable - 8);
      }
      let nodes = leafGroups.map(function (rows) {
        return { kind: 'leaf', rows: rows, maxKey: rows.length ? rows[rows.length - 1].rowid : 0 };
      });
      if (nodes.length === 1) return nodes[0];
      while (nodes.length > 1) nodes = makeLevel(nodes);
      return nodes[0];
    }

    function assignPages(node, pageNo) {
      node.pageNo = pageNo;
      if (node.kind === 'interior') {
        for (const child of node.children) assignPages(child, allocPage());
      }
    }

    /* ---- plan all tables, then master rows (their rootpage fields change) ---- */
    const plans = tables.map(function (t) {
      const prepared = t.rows.slice().sort(function (a, b) { return a.rowid - b.rowid; }).map(prepareRow);
      return { table: t, tree: buildTree(prepared, false) };
    });
    for (const plan of plans) {
      const rootPage = allocPage();
      plan.table.rootPage = rootPage;
      assignPages(plan.tree, rootPage);
    }

    const masterRows = db.master.map(function (obj) {
      let root = 0;
      if (obj.type === 'table') {
        const t = tableByName[obj.name];
        if (!t) throw new Error('sutWrite: sqlite_master 里的表 ' + obj.name + ' 没有数据');
        root = t.rootPage;
      } else if (obj.type !== 'view' && obj.type !== 'trigger') {
        throw new Error('sutWrite: 不支持的 sqlite_master 对象类型 ' + obj.type);
      }
      return { rowid: obj.rowid, values: [obj.type, obj.name, obj.tblName, root, obj.sql] };
    });
    const masterPrepared = masterRows.map(prepareRow);
    const masterTree = buildTree(masterPrepared, true);
    assignPages(masterTree, 1);

    /* ------------------------------ page writers ------------------------------ */
    function writeOverflowChain(data) {
      const chunk = usable - 4;
      const count = Math.ceil(data.length / chunk);
      const nums = [];
      for (let i = 0; i < count; i++) nums.push(allocPage());
      for (let i = 0; i < count; i++) {
        const buf = pages[nums[i] - 1];
        buf.fill(0);
        w32(buf, 0, i + 1 < count ? nums[i + 1] : 0);
        const off = i * chunk;
        const take = Math.min(chunk, data.length - off);
        buf.set(data.subarray(off, off + take), 4);
      }
      return nums[0];
    }

    function writeCellStart(buf, hdr, pos) {
      // For 65536-byte pages the 2-byte field uses 0 to mean 65536.
      w16(buf, hdr + 5, pos === 65536 ? 0 : pos);
    }

    function writeLeaf(node) {
      const buf = pages[node.pageNo - 1];
      buf.fill(0);
      const hdr = node.pageNo === 1 ? 100 : 0;
      const ptrs = [];
      let content = usable;
      const rows = node.rows;
      for (const row of rows) {
        const payload = encodeRecord(row.values);
        if (payload.length !== row.payloadLen) {
          throw new Error('sutWrite: 内部记录长度不一致 (' + payload.length + ' != ' + row.payloadLen + ')');
        }
        const local = localSize(payload.length, usable);
        let firstOverflow = 0;
        if (local < payload.length) firstOverflow = writeOverflowChain(payload.subarray(local));
        const cellLen = varintLen(payload.length) + varintLen(row.rowid) + local +
          (local < payload.length ? 4 : 0);
        const cellOff = content - cellLen;
        let p = writeVarint(payload.length, buf, cellOff);
        p = writeVarint(row.rowid, buf, p);
        buf.set(payload.subarray(0, local), p);
        p += local;
        if (local < payload.length) w32(buf, p, firstOverflow);
        content = cellOff;
        ptrs.push(cellOff);
      }
      buf[hdr] = 0x0d;
      w16(buf, hdr + 1, 0);       // first freeblock
      w16(buf, hdr + 3, rows.length);
      writeCellStart(buf, hdr, content);
      buf[hdr + 7] = 0;           // fragmented free bytes
      for (let i = 0; i < ptrs.length; i++) w16(buf, hdr + 8 + i * 2, ptrs[i]);
    }

    function writeInterior(node) {
      const buf = pages[node.pageNo - 1];
      buf.fill(0);
      const hdr = node.pageNo === 1 ? 100 : 0;
      const children = node.children;
      const n = children.length - 1; // cells; last child is the right-most pointer
      const ptrs = [];
      let content = usable;
      for (let i = 0; i < n; i++) {
        const child = children[i];
        const cellLen = 4 + varintLen(child.maxKey);
        const cellOff = content - cellLen;
        w32(buf, cellOff, child.pageNo);
        writeVarint(child.maxKey, buf, cellOff + 4);
        content = cellOff;
        ptrs.push(cellOff);
      }
      buf[hdr] = 0x05;
      w16(buf, hdr + 1, 0);
      w16(buf, hdr + 3, n);
      writeCellStart(buf, hdr, content);
      buf[hdr + 7] = 0;
      w32(buf, hdr + 8, children[children.length - 1].pageNo);
      for (let i = 0; i < ptrs.length; i++) w16(buf, hdr + 12 + i * 2, ptrs[i]);
    }

    function writeTree(node) {
      if (node.kind === 'leaf') { writeLeaf(node); return; }
      for (const child of node.children) writeTree(child);
      writeInterior(node);
    }

    for (const plan of plans) writeTree(plan.tree);
    writeTree(masterTree);

    /* ------------------------------- assemble file ---------------------------- */
    const out = new Uint8Array(pages.length * pageSize);
    for (let i = 0; i < pages.length; i++) out.set(pages[i], i * pageSize);

    // SQLite file header: keep template values, fix bookkeeping fields.
    out.set(templateBytes.subarray(0, 100), 0);
    out[18] = 1; // file format write version (rollback journal)
    out[19] = 1; // file format read version
    const changeCounter = (u32(templateBytes, 24) + 1) >>> 0;
    w32(out, 24, changeCounter);
    w32(out, 28, pages.length); // database size in pages
    w32(out, 32, 0);            // first freelist trunk page
    w32(out, 36, 0);            // number of freelist pages
    w32(out, 52, 0);            // largest root b-tree page
    w32(out, 92, changeCounter); // version-valid-for
    return out;
  }

  const api = {
    buildSut: buildSut,
    parseTar: parseTar,
    replaceTarThumbnail: replaceTarThumbnail,
    isThumbnailName: isThumbnailName,
    isPngBytes: isPngBytes,
    buildSutVersion: 1
  };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { sutWrite: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
