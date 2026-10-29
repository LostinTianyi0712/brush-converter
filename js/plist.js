/* Binary plist (bplist00) parser + NSKeyedArchiver unarchiver (for Procreate Brush.archive) */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  let U = null;
  function util() { if (!U) U = isNode ? require('./util.js') : root.BC.util; return U; }

  const MAX_DEPTH = 300;

  function readUint(b, o, n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + b[o + i];
    return v;
  }
  function readSint(b, o, n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + b[o + i];
    if (b[o] & 0x80) v -= Math.pow(256, n);
    return v;
  }

  function parseRaw(bytes) {
    if (bytes.length < 40 || util().ascii(bytes, 0, 8) !== 'bplist00') throw new Error('不是二进制 plist');
    const trailerOff = bytes.length - 32;
    const offsetSize = bytes[trailerOff + 6];
    const refSize = bytes[trailerOff + 7];
    const numObjects = readUint(bytes, trailerOff + 8, 8);
    const topObject = readUint(bytes, trailerOff + 16, 8);
    const offsetTableOff = readUint(bytes, trailerOff + 24, 8);
    if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) throw new Error('plist 头部异常');
    if (numObjects > 5000000 || offsetTableOff + numObjects * offsetSize > bytes.length) throw new Error('plist 偏移表异常');
    const offsets = new Array(numObjects);
    for (let i = 0; i < numObjects; i++) offsets[i] = readUint(bytes, offsetTableOff + i * offsetSize, offsetSize);
    const cache = new Map();

    function readObject(idx, depth) {
      if (depth > MAX_DEPTH) throw new Error('plist 嵌套过深');
      if (cache.has(idx)) return cache.get(idx);
      const off = offsets[idx];
      if (off === undefined || off < 0 || off >= bytes.length) throw new Error('plist 对象越界');
      const marker = bytes[off];
      const type = marker >> 4;
      let info = marker & 0x0f;
      let p = off + 1;
      let obj;
      function readLength() {
        if (info !== 0x0f) return info;
        const m = bytes[p]; p++;
        const n = 1 << (m & 0x0f);
        const v = readUint(bytes, p, n);
        p += n;
        return v;
      }
      switch (type) {
        case 0x0: obj = info === 0x08 ? false : info === 0x09 ? true : null; break;
        case 0x1: obj = readSint(bytes, p, 1 << info); break;
        case 0x2: {
          const n = 1 << info;
          const dv = new DataView(bytes.buffer, bytes.byteOffset + p, Math.min(n, 8));
          obj = n === 4 ? dv.getFloat32(0, false) : dv.getFloat64(0, false);
          break;
        }
        case 0x3: {
          const dv = new DataView(bytes.buffer, bytes.byteOffset + p, 8);
          obj = new Date((dv.getFloat64(0, false) + 978307200) * 1000);
          break;
        }
        case 0x4: { const len = readLength(); obj = bytes.subarray(p, p + len); break; }
        case 0x5: { const len = readLength(); obj = util().ascii(bytes, p, len).replace(/\u0000/g, ''); break; }
        case 0x6: {
          const len = readLength();
          let s = '';
          for (let i = 0; i < len; i++) s += String.fromCharCode((bytes[p + i * 2] << 8) | bytes[p + i * 2 + 1]);
          obj = s;
          break;
        }
        case 0x8: obj = { $uid: readUint(bytes, p, info + 1) }; break;
        case 0xa:
        case 0xb:
        case 0xc: {
          const len = readLength();
          obj = { $array: [] };
          for (let i = 0; i < len; i++) obj.$array.push(readUint(bytes, p + i * refSize, refSize));
          break;
        }
        case 0xd: {
          const len = readLength();
          obj = { $dict: [] };
          for (let i = 0; i < len; i++) {
            obj.$dict.push([readUint(bytes, p + i * refSize, refSize), readUint(bytes, p + (len + i) * refSize, refSize)]);
          }
          break;
        }
        default: throw new Error('不支持的 plist 类型: ' + type);
      }
      cache.set(idx, obj);
      return obj;
    }

    function rawKey(idx) {
      const o = readObject(idx, 0);
      return typeof o === 'string' ? o : null;
    }

    function rawGet(dict, name) {
      if (!dict || !dict.$dict) return undefined;
      for (const [kRef, vRef] of dict.$dict) {
        if (rawKey(kRef) === name) return vRef;
      }
      return undefined;
    }

    let objectsRaw = null;
    function objAt(i) {
      const arr = objectsRaw && objectsRaw.$array;
      if (!arr) throw new Error('plist 缺少 $objects');
      if (i < 0 || i >= arr.length) throw new Error('plist UID 越界: ' + i);
      return readObject(arr[i], 0);
    }
    function resolve(v, depth, stack) {
      if (depth > MAX_DEPTH) return null;
      if (v === null || v === undefined) return v;
      if (typeof v !== 'object') return v;
      if (v instanceof Uint8Array || v instanceof Date) return v;
      if (v.$uid !== undefined) return resolve(objAt(v.$uid), depth + 1, stack);
      if (v.$array) {
        const out = [];
        for (const r of v.$array) out.push(resolve(readObject(r, depth + 1), depth + 1, stack));
        return out;
      }
      if (v.$dict) {
        const out = {};
        for (const [kRef, vRef] of v.$dict) {
          const key = rawKey(kRef);
          if (key === null || key === '$class') continue;
          out[key] = resolve(readObject(vRef, depth + 1), depth + 1, stack);
        }
        // resolve archived class name if present
        const classRef = rawGet(v, '$class');
        if (classRef !== undefined) {
          const cls = readObject(classRef, 0);
          const cn = rawGet(cls, '$classname');
          if (cn !== undefined) out.__class = resolve(readObject(cn, 0), 0, stack);
        }
        return out;
      }
      return v;
    }

    const top = readObject(topObject, 0);
    const objectsRef = rawGet(top, '$objects');
    if (objectsRef === undefined) throw new Error('plist 缺少 $objects');
    objectsRaw = readObject(objectsRef, 0);
    if (!objectsRaw || !objectsRaw.$array) throw new Error('$objects 结构异常');
    let rootVal;
    const topWrapper = rawGet(top, '$top');
    if (topWrapper !== undefined) {
      const tw = readObject(topWrapper, 0);
      const rootRef = rawGet(tw, 'root');
      if (rootRef !== undefined) rootVal = readObject(rootRef, 0);
    }
    if (rootVal === undefined) rootVal = { $uid: 1 };
    return resolve(rootVal, 0, new Set());
  }

  function isBinaryPlist(bytes) { return bytes.length >= 8 && util().ascii(bytes, 0, 6) === 'bplist'; }
  function unarchive(bytes) { return parseRaw(bytes); }

  const api = { isBinaryPlist, parse: parseRaw, unarchive };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { plist: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
