/* Photoshop .pat 图案文件（v1）生成器
   结构（从 PS 导出样本 + ABR patt 记录规范共同确认）：
     '8BPT' + u16 版本(1) + u32 图案数量
     每个图案记录（无长度前缀）：
       u32 版本(1) + u32 色彩模式 + u16 高 + u16 宽
       u32 名称字符数(含结尾 NUL) + UTF-16BE 名称
       u8 ID长度(36) + ASCII UUID
       [模式2: 768B 调色板 + u16 256 + u16 255]
       u32 vma版本(3) + u32 列表长度
       rect: u32 top,left,bottom,right
       u32 通道槽数(固定写 24)
       每通道槽: u32 1 + u32 体长度 + [u32 8 + rect(4×u32) + u16 8 + u8 压缩(0=raw) + 像素]
     末尾: 8BIMphry 块(55B) */
(function (root) {
  'use strict';

  const VERSION = 1;
  const MODE_RGB = 3;
  const VMA_VERSION = 3;
  const CHANNEL_SLOTS = 24;
  const PHRY_HEX = '3842494d706872790000002b00000010000000010000000000006e756c6c0000000100000009686965726172636879566c4c7300000000';

  function bytesFromHex(hex) {
    const n = hex.length / 2, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  const PHRY_BLOCK = bytesFromHex(PHRY_HEX);

  function u16(v) { return new Uint8Array([(v >> 8) & 255, v & 255]); }
  function u32(v) { return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }
  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function asciiBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
    return out;
  }
  function utf16be(str) {
    const out = new Uint8Array((str.length + 1) * 2); // 末尾 NUL
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      out[i * 2] = (c >> 8) & 255;
      out[i * 2 + 1] = c & 255;
    }
    return out;
  }

  // PackBits（PS RLE）单行编码
  function packbitsRow(row) {
    const out = [];
    let i = 0;
    while (i < row.length) {
      let run = 1;
      while (i + run < row.length && row[i + run] === row[i] && run < 128) run++;
      if (run >= 2) { out.push(257 - run); out.push(row[i]); i += run; continue; }
      let lit = 1;
      while (i + lit < row.length && lit < 128) {
        if (i + lit + 1 < row.length && row[i + lit] === row[i + lit + 1]) break;
        lit++;
      }
      out.push(lit - 1);
      for (let k = 0; k < lit; k++) out.push(row[i + k]);
      i += lit;
    }
    return out;
  }

  function rlePlane(plane, w, h) {
    const counts = new Uint8Array(h * 2);
    const body = [];
    for (let y = 0; y < h; y++) {
      const row = plane.subarray(y * w, (y + 1) * w);
      const enc = packbitsRow(row);
      counts[y * 2] = (enc.length >> 8) & 255;
      counts[y * 2 + 1] = enc.length & 255;
      for (const v of enc) body.push(v);
    }
    return concat([counts, new Uint8Array(body)]);
  }

  function channelSlot(w, h, plane, useRle) {
    const data = useRle ? rlePlane(plane, w, h) : plane;
    const body = concat([
      u32(8),
      u32(0), u32(0), u32(h), u32(w),
      u16(8),
      new Uint8Array([useRle ? 1 : 0]),
      data
    ]);
    return concat([u32(1), u32(body.length), body]);
  }

  function buildPattern(name, w, h, planes, uuid, useRle) {
    const id = uuid || randomUuid();
    const nameBytes = utf16be(name || 'pattern');
    const nameUnits = nameBytes.length / 2;

    const slots = [];
    for (let i = 0; i < planes.length; i++) slots.push(channelSlot(w, h, planes[i], useRle));
    const rect = concat([u32(0), u32(0), u32(h), u32(w)]);
    const listParts = [rect, u32(CHANNEL_SLOTS)];
    for (const s of slots) listParts.push(s);
    // PS 的 .pat 在通道槽之后固定还有 92 个零字节（样本 64/1/red256 均一致）
    listParts.push(new Uint8Array(92));
    const list = concat(listParts);

    const record = concat([
      u32(VERSION),
      u32(MODE_RGB),
      u16(h), u16(w),
      u32(nameUnits),
      nameBytes,
      new Uint8Array([id.length]),
      asciiBytes(id),
      u32(VMA_VERSION),
      u32(list.length),
      list
    ]);
    return { record: record, id: id, name: name || 'pattern', width: w, height: h };
  }

  /* 索引色图案（模式 2）：768B 灰度调色板 + 1 字节/像素，体积约为 RGB 的 1/3 */
  function buildPatternIndexed(name, w, h, gray, uuid) {
    const id = uuid || randomUuid();
    const nameBytes = utf16be(name || 'pattern');
    const nameUnits = nameBytes.length / 2;
    const palette = new Uint8Array(768);
    for (let i = 0; i < 256; i++) { palette[i * 3] = i; palette[i * 3 + 1] = i; palette[i * 3 + 2] = i; }

    const body = concat([u32(8), u32(0), u32(0), u32(h), u32(w), u16(8), new Uint8Array([0]), gray]);
    const slot = concat([u32(1), u32(body.length), body]);
    const rect = concat([u32(0), u32(0), u32(h), u32(w)]);
    const list = concat([rect, u32(CHANNEL_SLOTS), slot, new Uint8Array(92)]);

    const record = concat([
      u32(VERSION), u32(2), u16(h), u16(w),
      u32(nameUnits), nameBytes,
      new Uint8Array([id.length]), asciiBytes(id),
      palette, u16(256), u16(255),
      u32(VMA_VERSION), u32(list.length), list
    ]);
    return { record: record, id: id, name: name || 'pattern', width: w, height: h };
  }

  function randomUuid() {
    const hex = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
      else if (i === 14) s += '4';
      else s += hex[(Math.random() * 16) | 0];
    }
    return s;
  }

  function buildPat(patterns) {
    const parts = [concat([asciiBytes('8BPT'), u16(1), u32(patterns.length)])];
    for (const p of patterns) parts.push(p.record);
    parts.push(PHRY_BLOCK);
    return concat(parts);
  }

  function noisePlanes(w, h, seed) {
    seed = seed || 11;
    const n = w * h;
    const planes = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let v = (x * 374761393 + y * 668265263 + seed * 2147483647) ^ 0x5bf03635;
        v = (v ^ (v >> 13)) * 1274126177; v = v ^ (v >> 16);
        const a = (v >>> 0) % 1000;
        let v2 = (x * 22695477 + y * 1013904223 + seed * 2654435761) ^ 0x27d4eb2d;
        v2 = (v2 ^ (v2 >> 15)) * 2246822519; v2 = v2 ^ (v2 >> 13);
        const b = (v2 >>> 0) % 1000;
        const c = (((x * 31 + y * 17 + seed) * 2654435761) >>> 0) % 1000;
        planes[0][i] = 110 + Math.round(90 * a / 999);
        planes[1][i] = 108 + Math.round(90 * b / 999);
        planes[2][i] = 106 + Math.round(90 * c / 999);
      }
    }
    return planes;
  }

  /* 用真实纹理灰度图生成图案（planes 三通道同值） */
  function buildFromGray(name, w, h, gray, opts) {
    const n = w * h;
    const planes = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
    for (let i = 0; i < n; i++) { const v = gray[i]; planes[0][i] = v; planes[1][i] = v; planes[2][i] = v; }
    const p = buildPattern(name || 'brushconv-texture', w, h, planes, (opts && opts.uuid), true);
    return { bytes: buildPat([p]), id: p.id, name: p.name, width: w, height: h };
  }

  function buildGrainPat(opts) {
    opts = opts || {};
    const w = opts.size || 256, h = opts.size || 256;
    const p = buildPattern(opts.name || 'brushconv-grain', w, h, noisePlanes(w, h, opts.seed || 11), opts.uuid, opts.rle !== false);
    return { bytes: buildPat([p]), id: p.id, name: p.name, width: w, height: h };
  }

  const api = {
    buildPattern: buildPattern,
    buildPat: buildPat,
    buildGrainPat: buildGrainPat,
    buildFromGray: buildFromGray,
    buildPatternIndexed: buildPatternIndexed,
    noisePlanes: noisePlanes
  };
  if (typeof module !== 'undefined' && module.exports && typeof process !== 'undefined') module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { pat: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
