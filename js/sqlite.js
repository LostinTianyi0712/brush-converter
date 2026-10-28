/* Minimal SQLite 3 reader/writer — enough for Clip Studio Paint .sut brushes.
   Reader supports single-table b-trees, interior pages and overflow payloads.
   Writer emits a valid SQLite file with one leaf page per table (+ overflow chains). */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;

  const MAGIC = 'SQLite format 3\u0000';

  function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function be32(n) { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }
  function be16(n) { return [(n >>> 8) & 0xff, n & 0xff]; }

  function isSqlite(bytes) {
    if (!bytes || bytes.length < 100) return false;
    return util.ascii(bytes, 0, 16).replace(/\u0000/g, '') === 'SQLite format 3';
  }

  function readVarint(bytes, pos) {
    let v = 0;
    for (let i = 0; i < 9; i++) {
      const c = bytes[pos + i];
      if (i === 8) return { value: v * 256 + c, next: pos + 9 };
      if (c < 0x80) return { value: v * 128 + c, next: pos + i + 1 };
      v = v * 128 + (c & 0x7f);
    }
    return { value: v, next: pos + 9 };
  }

  function writeVarint(n) {
    // big-endian 7-bit groups, at most 9 bytes (last one 8 bits)
    const groups = [];
    let v = n;
    for (let i = 0; i < 9; i++) {
      if (v < 0x80) { groups.push(v); break; }
      groups.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    return groups.reverse();
  }

  function serialSize(t) {
    if (t === 0 || t === 8 || t === 9) return 0;
    if (t >= 1 && t <= 4) return t;
    if (t === 5) return 6;
    if (t === 6 || t === 7) return 8;
    if (t >= 12) return (t - 12) >> 1;
    return 0;
  }

  function readValue(bytes, pos, t) {
    if (t === 0) return null;
    if (t === 8) return 0;
    if (t === 9) return 1;
    if (t === 1) return (bytes[pos] << 24) >> 24;
    if (t === 2) return ((bytes[pos] << 8) | bytes[pos + 1]) << 16 >> 16;
    if (t === 3) { const v = ((bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2]); return (v << 8) >> 8; }
    if (t === 4) return util.i32(bytes, pos);
    if (t === 5) return ((bytes[pos] << 8) | bytes[pos + 1]) * 4294967296 + u32(bytes, pos + 2);
    if (t === 6 || t === 7) {
      const sign = t === 6 ? -1 : 1;
      // big-endian double
      const b = bytes.subarray(pos, pos + 8);
      const dv = new DataView(b.buffer, b.byteOffset, 8);
      return dv.getFloat64(0, false);
    }
    if (t >= 12) {
      const len = (t - 12) >> 1;
      const data = bytes.subarray(pos, pos + len);
      if (t & 1) return util.utf8Decode(data); // text
      return new Uint8Array(data); // blob
    }
    return null;
  }

  function parseRecord(bytes, start, payloadLen) {
    const hs = readVarint(bytes, start);
    const headerEnd = start + hs.value;
    const types = [];
    let p = hs.next;
    while (p < headerEnd) {
      const t = readVarint(bytes, p);
      types.push(t.value);
      p = t.next;
    }
    const vals = [];
    let bp = headerEnd;
    for (const t of types) {
      vals.push(readValue(bytes, bp, t));
      bp += serialSize(t);
    }
    return vals;
  }

  /* ---------- page / b-tree reading ---------- */
  function readPayload(bytes, pageSize, usable, reserved, pageNo, cellPos, totalPayload) {
    const maxLocal = usable - 35;
    const minLocal = Math.floor((usable - 12) * 32 / 255) - 23;
    let local = totalPayload;
    let overflow = -1;
    if (totalPayload > maxLocal) {
      let k = minLocal + ((totalPayload - minLocal) % (usable - 4));
      if (k > maxLocal) k = minLocal;
      local = k;
      overflow = u32(bytes, cellPos + local);
    }
    const out = new Uint8Array(totalPayload);
    out.set(bytes.subarray(cellPos, cellPos + local), 0);
    let filled = local;
    let next = overflow;
    let guard = 0;
    while (next > 0 && filled < totalPayload && ++guard < 100000) {
      const pageOff = (next - 1) * pageSize;
      const isPage1 = next === 1;
      const hdr = pageOff + (isPage1 ? 100 : 0);
      const nextPage = u32(bytes, hdr);
      const take = Math.min(usable - 4, totalPayload - filled);
      out.set(bytes.subarray(hdr + 4, hdr + 4 + take), filled);
      filled += take;
      next = nextPage;
    }
    return out;
  }

  function readTableRows(bytes, pageSize, usable, reserved, rootPage) {
    const rows = [];
    const visited = {};
    (function walk(pageNo) {
      if (!pageNo || visited[pageNo] || rows.length > 200000) return;
      visited[pageNo] = 1;
      const pageOff = (pageNo - 1) * pageSize;
      const isPage1 = pageNo === 1;
      const hdr = pageOff + (isPage1 ? 100 : 0);
      const type = bytes[hdr];
      const interior = (type === 0x05 || type === 0x02);
      const cellCount = u16(bytes, hdr + 3);
      const ptrBase = hdr + (interior ? 12 : 8);
      const cells = [];
      for (let i = 0; i < cellCount; i++) cells.push(u16(bytes, ptrBase + i * 2));
      if (interior) {
        // interior: cells = [u32 child page][varint rowid]; last child at header+8
        // NOTE: cell pointer values are page-relative (not header-relative)
        for (const c of cells) walk(u32(bytes, pageOff + c));
        walk(u32(bytes, hdr + 8));
        return;
      }
      for (const c of cells) {
        const pos = pageOff + c;
        const payloadVar = readVarint(bytes, pos);
        const rowidVar = readVarint(bytes, payloadVar.next);
        const payloadStart = rowidVar.next;
        const payload = readPayload(bytes, pageSize, usable, reserved, pageNo, payloadStart, payloadVar.value);
        rows.push({ rowid: rowidVar.value, values: parseRecord(payload, 0, payload.length) });
      }
    })(rootPage);
    return rows;
  }

  function read(bytes) {
    if (!isSqlite(bytes)) throw new Error('不是 SQLite 数据库');
    let pageSize = u16(bytes, 16);
    // The header stores 1 for a 65536-byte page (0 is invalid).
    if (pageSize === 0 || pageSize === 1) pageSize = 65536;
    const reserved = bytes[20] || 0;
    const usable = pageSize - reserved;
    const encoding = u32(bytes, 56) || 1;
    const masterRows = readTableRows(bytes, pageSize, usable, reserved, 1);
    // Raw sqlite_master entries (tables, indexes, views, triggers) — the writer
    // needs the complete list so it can recreate a database from scratch.
    const master = masterRows.map(function (r) {
      return {
        rowid: r.rowid,
        type: r.values[0],
        name: r.values[1],
        tblName: r.values[2],
        rootPage: r.values[3],
        sql: r.values[4]
      };
    });
    const tables = [];
    for (const r of masterRows) {
      const v = r.values;
      if (v[0] !== 'table') continue;
      const table = {
        name: v[1],
        rootPage: v[3],
        sql: v[4],
        columns: [],
        rows: [],
        rawRows: []
      };
      if (v[4]) {
        const m = /\(([\s\S]*)\)/.exec(String(v[4]));
        if (m) {
          table.columns = m[1].split(',').map(function (s) {
            return s.trim().split(/\s+/)[0].replace(/["'`[\]]/g, '');
          }).filter(Boolean);
        }
      }
      if (table.rootPage) {
        table.rawRows = readTableRows(bytes, pageSize, usable, reserved, table.rootPage);
        table.rows = table.rawRows.map(function (row) {
          const obj = { _rowid: row.rowid };
          table.columns.forEach(function (col, i) { obj[col] = row.values[i]; });
          return obj;
        });
      }
      tables.push(table);
    }
    return { pageSize: pageSize, encoding: encoding, master: master, tables: tables };
  }

  /* Raw rows of one table b-tree: [{rowid, values:[...]}] in key order. */
  function readRows(bytes, rootPage) {
    let pageSize = u16(bytes, 16);
    if (pageSize === 0 || pageSize === 1) pageSize = 65536;
    const reserved = bytes[20] || 0;
    return readTableRows(bytes, pageSize, pageSize - reserved, reserved, rootPage);
  }

  function getTable(db, name) {
    for (const t of db.tables) if (t.name === name) return t;
    return null;
  }

  const api = { isSqlite, read, readRows, getTable, readRecord: parseRecord };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { sqlite: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
