/*
 * SAI2 原生工具预设（.saitdat / .saitgrp / .saitset）解析与写出。
 *
 * 第153轮逆向结论（用 87 个真实文件验证，见 test/sai2dat_roundtrip_test.js）：
 *   - 不是二进制，是纯文本；LF 换行；最后一行固定 `--EOF--`；
 *   - 每行 `key=类型:值`，类型取值：
 *       I 十进制整数（可负）
 *       U UTF-8 字符串
 *       S 原始字节串（Shift-JIS 语境，样本里只有 ASCII，如 inkpen / binkpen）
 *       F float32 的 **原始位模式**，以无符号十进制写出（1065353216 = 0x3F800000 = 1.0）
 *       D float64 的 **原始位模式**，以无符号十进制写出（0 = 0.0）
 *   - 单独一行 `.` 是块分隔符；文件结尾常见多个 `.`（空块），必须原样保留才能字节级回环。
 *
 * 本模块只做「结构层」：解析、按类型取值、按类型写值、原样写回。
 * 字段语义（cursize 是 1/10px 还是百分比等）尚未原生标定，不在本模块里猜。
 */
(function (root) {
  'use strict';

  const TYPES = ['I', 'U', 'S', 'F', 'D'];

  function isNode() {
    return typeof module !== 'undefined' && module.exports;
  }

  /* ---------- 位模式编解码 ---------- */
  function float32BitsToNumber(bits) {
    const b = new DataView(new ArrayBuffer(4));
    b.setUint32(0, Number(bits) >>> 0, true);
    return b.getFloat32(0, true);
  }
  function numberToFloat32Bits(value) {
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, Number(value) || 0, true);
    return b.getUint32(0, true);
  }
  function float64BitsToNumber(bits) {
    const b = new DataView(new ArrayBuffer(8));
    b.setBigUint64(0, BigInt(bits), true);
    return b.getFloat64(0, true);
  }
  function numberToFloat64Bits(value) {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, Number(value) || 0, true);
    return b.getBigUint64(0, true).toString();
  }

  /* ---------- 解析 ---------- */
  /**
   * 解析一个 .saitdat/.saitgrp/.saitset。
   * @param {string} text 以 latin1 读入的文本（保证 S: 的原始字节不丢）
   * @returns {{blocks: Array<Array<object>>, eof: boolean}}
   */
  function parse(text) {
    if (typeof text !== 'string') text = String(text);
    const lines = text.split('\n');
    /* 文件以 \n 结尾时 split 会多出一个空串，去掉它 */
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const blocks = [[]];
    let eof = false;
    for (const line of lines) {
      if (line === '--EOF--') { eof = true; break; }
      if (line === '.') { blocks.push([]); continue; }
      const m = /^([^=]+)=([A-Za-z]):([\s\S]*)$/.exec(line);
      if (!m) {
        /* .saitgrp 的成员表是 `槽位=工具id`（没有类型前缀），单独识别，仍是原始行语义 */
        const slot = /^(\d+)=(\d+)$/.exec(line);
        if (slot) { blocks[blocks.length - 1].push({ kind: 'slot', slot: Number(slot[1]), id: Number(slot[2]) }); continue; }
        blocks[blocks.length - 1].push({ raw: line });
        continue;
      }
      blocks[blocks.length - 1].push({
        key: m[1], type: m[2], value: m[3],
        /* 只有 set() 改过的条目才用编码器重写，未改动的原样输出 */
        touched: false
      });
    }
    return { blocks: blocks, eof: eof };
  }

  function stringify(doc) {
    const out = [];
    (doc.blocks || []).forEach(function (block, i) {
      if (i > 0) out.push('.');
      block.forEach(function (e) {
        if (e.kind === 'slot') { out.push(e.slot + '=' + e.id); return; }
        if (e.raw !== undefined && e.key === undefined) { out.push(e.raw); return; }
        out.push(e.key + '=' + e.type + ':' + e.value);
      });
    });
    out.push('--EOF--');
    return out.join('\n') + '\n';
  }

  /* ---------- 取值 / 赋值 ---------- */
  function findEntry(doc, key) {
    for (const block of doc.blocks) {
      for (const e of block) if (e.key === key) return e;
    }
    return null;
  }

  /** 按类型解出可用的 JS 值；未知类型返回原始字符串。 */
  function decode(entry) {
    if (!entry || entry.key === undefined) return undefined;
    switch (entry.type) {
      case 'I': return parseInt(entry.value, 10);
      case 'F': return float32BitsToNumber(entry.value);
      case 'D': return float64BitsToNumber(entry.value);
      case 'S': return entry.value;               /* 原始字节，按 latin1 保存 */
      case 'U': {
        /* 真实文件是按 latin1 读进来的，U: 里是 UTF-8 字节；此时每个字符都 ≤0xFF。
           若调用方直接传的是正常 JS 文本（含 >0xFF 的码点），原样返回。 */
        const v = entry.value;
        let byteLike = true;
        for (let i = 0; i < v.length; i++) { if (v.charCodeAt(i) > 0xFF) { byteLike = false; break; } }
        if (byteLike && typeof Buffer !== 'undefined') return Buffer.from(v, 'latin1').toString('utf8');
        return v;
      }
      default: return entry.value;
    }
  }

  function get(doc, key) {
    return decode(findEntry(doc, key));
  }

  function encodeValue(type, value) {
    switch (type) {
      case 'I': return String(Math.trunc(Number(value) || 0));
      case 'F': return String(numberToFloat32Bits(value));
      case 'D': return numberToFloat64Bits(value);
      case 'U':
      case 'S':
      default: return String(value === undefined || value === null ? '' : value);
    }
  }

  /** 按条目已有类型写值；条目不存在时返回 false（不擅自新增字段）。 */
  function set(doc, key, value) {
    const e = findEntry(doc, key);
    if (!e) return false;
    e.value = encodeValue(e.type, value);
    e.touched = true;
    return true;
  }

  /** 浅表：所有 key → 解码值（同名 key 后者覆盖前者，SAI 文件里没出现过重名）。 */
  function all(doc) {
    const out = {};
    for (const block of doc.blocks) {
      for (const e of block) if (e.key !== undefined) out[e.key] = decode(e);
    }
    return out;
  }

  /**
   * .saitgrp 的成员表：槽位 → 工具 id（文件里写作 `槽位=工具id` 的裸行）。
   * @returns {Array<{slot:number, id:number}>} 按文件出现顺序
   */
  function slots(doc) {
    const out = [];
    for (const block of doc.blocks) {
      for (const e of block) if (e.kind === 'slot') out.push({ slot: e.slot, id: e.id });
    }
    return out;
  }

  /** 改某个槽位的工具 id；槽位不存在则追加到第一个含成员表的块（没有就新建一块）。 */
  function setSlot(doc, slot, id) {
    for (const block of doc.blocks) {
      for (const e of block) {
        if (e.kind === 'slot' && e.slot === slot) { e.id = Number(id); return true; }
      }
    }
    const target = doc.blocks.find(function (b) { return b.some(function (e) { return e.kind === 'slot'; }); });
    if (target) { target.push({ kind: 'slot', slot: Number(slot), id: Number(id) }); }
    else { doc.blocks.push([{ kind: 'slot', slot: Number(slot), id: Number(id) }]); }
    return true;
  }

  /** 删除某个槽位；返回是否删到。 */
  function removeSlot(doc, slot) {
    for (const block of doc.blocks) {
      for (let i = 0; i < block.length; i++) {
        const e = block[i];
        if (e.kind === 'slot' && e.slot === Number(slot)) { block.splice(i, 1); return true; }
      }
    }
    return false;
  }

  /** 键 → 类型表（用于文档/报告，不参与转换）。 */
  function keyTypes(doc) {
    const out = {};
    for (const block of doc.blocks) {
      for (const e of block) if (e.key !== undefined) out[e.key] = e.type;
    }
    return out;
  }

  /**
   * 以文本模板为底，写出一个新文件：只覆盖模板里已存在的字段。
   * @param {string} templateText 原文件文本（latin1）
   * @param {object} overrides key → 值
   */
  function createFrom(templateText, overrides) {
    const doc = parse(templateText);
    Object.keys(overrides || {}).forEach(function (k) { set(doc, k, overrides[k]); });
    return doc;
  }

  /* ---------- 格式识别（给 convert.detect 用的只读入口） ---------- */
  /**
   * 是否是 SAI2 原生预设文本（.saitdat/.saitgrp/.saitset/.saitlnk）。
   * 判据：前 8KB 是文本、含若干 `key=类型:值` 行、以 `--EOF--` 收尾。
   */
  function isSai2Preset(bytes) {
    if (!bytes || bytes.length < 12 || bytes.length > 2 * 1024 * 1024) return false;
    const head = bytes.subarray(0, Math.min(bytes.length, 8192));
    for (let i = 0; i < head.length; i++) {
      const b = head[i];
      if (b === 0) return false;
      if (b < 9 || (b > 13 && b < 32)) return false;
    }
    let text;
    if (typeof Buffer !== 'undefined') text = Buffer.from(head).toString('latin1');
    else text = Array.prototype.map.call(head, function (c) { return String.fromCharCode(c); }).join('');
    if (text.indexOf('--EOF--') < 0) return false;
    return /(^|\n)[A-Za-z_][A-Za-z0-9_]*=[IUSFD]:/.test(text) || /(^|\n)\d+=\d+(\n|$)/.test(text);
  }

  /**
   * 粗识别一个 SAI2 预设：工具 / 组 / 集合 / 别名。
   * 只做结构判断与名称提取，不做参数语义映射。
   */
  function identify(bytes) {
    let text;
    if (typeof bytes === 'string') text = bytes;
    else if (typeof Buffer !== 'undefined') text = Buffer.from(bytes).toString('latin1');
    else text = Array.prototype.map.call(bytes, function (c) { return String.fromCharCode(c); }).join('');
    const doc = parse(text);
    const vals = all(doc);
    if (vals.tarid !== undefined || vals.tarcat !== undefined) {
      return { kind: 'link', name: null, target: vals.tarid, cat: vals.tarcat };
    }
    if (vals.curgid !== undefined || vals.newgid !== undefined || vals.tabno !== undefined) {
      return { kind: 'set', name: null };
    }
    const slotList = slots(doc);
    if (slotList.length || vals.vsbpos !== undefined || vals.csrbid0 !== undefined) {
      return { kind: 'group', name: vals.name || null, slots: slotList };
    }
    return { kind: 'tool', name: vals.name || null, keyCount: Object.keys(vals).length };
  }

  const KIND_LABEL = { tool: '工具', group: '工具组', set: '工具集状态', link: '工具别名' };

  const api = {
    parse: parse,
    stringify: stringify,
    get: get,
    set: set,
    all: all,
    slots: slots,
    setSlot: setSlot,
    removeSlot: removeSlot,
    keyTypes: keyTypes,
    createFrom: createFrom,
    decode: decode,
    isSai2Preset: isSai2Preset,
    identify: identify,
    KIND_LABEL: KIND_LABEL,
    encodeValue: encodeValue,
    float32BitsToNumber: float32BitsToNumber,
    numberToFloat32Bits: numberToFloat32Bits,
    float64BitsToNumber: float64BitsToNumber,
    numberToFloat64Bits: numberToFloat64Bits,
    TYPES: TYPES
  };
  if (isNode()) module.exports = api;
  else {
    const r = root || (typeof globalThis !== 'undefined' ? globalThis : this);
    r.BC = Object.assign(r.BC || {}, { sai2dat: api });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
