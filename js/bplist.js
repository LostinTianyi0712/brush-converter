/* Binary plist (bplist00) writer + NSKeyedArchiver builder (Procreate Brush.archive) */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;

  function Uid(value) { this.value = value; }

  function encodeInt(n) {
    const sizes = [1, 2, 4];
    for (const size of sizes) {
      const min = -Math.pow(2, size * 8 - 1), max = Math.pow(2, size * 8 - 1) - 1;
      if (n >= min && n <= max) {
        const out = new Uint8Array(1 + size);
        out[0] = 0x10 | (Math.log2(size) | 0);
        const dv = new DataView(out.buffer);
        if (size === 1) dv.setInt8(1, n);
        else if (size === 2) dv.setInt16(1, n, false);
        else dv.setInt32(1, n, false);
        return out;
      }
    }
    const out = new Uint8Array(9);
    out[0] = 0x13;
    new DataView(out.buffer).setFloat64(1, n, false);
    return out;
  }

  function lenMarker(base, len) {
    if (len < 15) return new Uint8Array([base | len]);
    return util.concat([new Uint8Array([base | 0x0f]), encodeInt(len)]);
  }

  function encodeValue(v) {
    if (v === null || v === undefined) return new Uint8Array([0x00]);
    if (v instanceof Uid) {
      const n = Math.max(1, Math.ceil((Math.floor(Math.log2(Math.max(1, v.value))) + 1) / 8));
      const out = new Uint8Array(1 + n);
      out[0] = 0x80 | (n - 1);
      let val = v.value;
      for (let i = n - 1; i >= 0; i--) { out[1 + i] = val & 0xff; val = Math.floor(val / 256); }
      return out;
    }
    if (typeof v === 'boolean') return new Uint8Array([v ? 0x09 : 0x08]);
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return encodeInt(v);
      const out = new Uint8Array(9);
      out[0] = 0x23;
      new DataView(out.buffer).setFloat64(1, v, false);
      return out;
    }
    if (typeof v === 'string') {
      if (/^[\x00-\x7f]*$/.test(v)) {
        return util.concat([lenMarker(0x50, v.length), util.utf8Encode(v)]);
      }
      const units = v.length;
      const body = new Uint8Array(units * 2);
      const dv = new DataView(body.buffer);
      for (let i = 0; i < units; i++) dv.setUint16(i * 2, v.charCodeAt(i), false);
      return util.concat([lenMarker(0x60, units), body]);
    }
    if (v instanceof Uint8Array) return util.concat([lenMarker(0x40, v.length), v]);
    throw new Error('bplist 不支持的值类型: ' + typeof v);
  }

  function serialize(objects, topIndex) {
    const numObjects = objects.length;
    const refSize = numObjects <= 256 ? 1 : (numObjects <= 65536 ? 2 : 4);
    const chunks = [util.utf8Encode('bplist00')];
    const offsets = [];
    let pos = 8;
    for (const obj of objects) {
      offsets.push(pos);
      let bytes;
      if (obj && obj.__dict) {
        const entries = obj.__dict;
        const body = new Uint8Array(entries.length * 2 * refSize);
        const dv = new DataView(body.buffer);
        for (let i = 0; i < entries.length; i++) {
          const k = entries[i][0], v = entries[i][1];
          if (refSize === 1) { body[i] = k; body[entries.length + i] = v; }
          else if (refSize === 2) { dv.setUint16(i * 2, k, false); dv.setUint16((entries.length + i) * 2, v, false); }
          else { dv.setUint32(i * 4, k, false); dv.setUint32((entries.length + i) * 4, v, false); }
        }
        bytes = util.concat([lenMarker(0xd0, entries.length), body]);
      } else if (obj && obj.__array) {
        const refs = obj.__array;
        const body = new Uint8Array(refs.length * refSize);
        const dv = new DataView(body.buffer);
        for (let i = 0; i < refs.length; i++) {
          if (refSize === 1) body[i] = refs[i];
          else if (refSize === 2) dv.setUint16(i * 2, refs[i], false);
          else dv.setUint32(i * 4, refs[i], false);
        }
        bytes = util.concat([lenMarker(0xa0, refs.length), body]);
      } else {
        bytes = encodeValue(obj);
      }
      chunks.push(bytes);
      pos += bytes.length;
    }
    const offsetTableOffset = pos;
    const offsetSize = offsetTableOffset > 0xffff ? 4 : 2;
    const table = new Uint8Array(offsets.length * offsetSize);
    const tdv = new DataView(table.buffer);
    for (let i = 0; i < offsets.length; i++) {
      if (offsetSize === 2) tdv.setUint16(i * 2, offsets[i], false);
      else tdv.setUint32(i * 4, offsets[i], false);
    }
    chunks.push(table);
    const trailer = new Uint8Array(32);
    const dv = new DataView(trailer.buffer);
    trailer[6] = offsetSize;
    trailer[7] = refSize;
    dv.setUint32(12, numObjects, false);      // numObjects (low 32 bits)
    dv.setUint32(20, topIndex, false);        // topObject (low 32 bits)
    dv.setUint32(28, offsetTableOffset, false);
    chunks.push(trailer);
    return util.concat(chunks);
  }

  /**
   * Build an NSKeyedArchiver archive.
   * rootScalarDict: { key: string|number|boolean|Uid }  (UID refs into archived objects)
   * className / classChain: archived class identity (e.g. "SilicaBrush")
   */
  function writeKeyedArchive(rootScalarDict, className, classChain) {
    const objects = [];
    const archived = [];
    function addObj(o, isArchived) {
      objects.push(o);
      const idx = objects.length - 1;
      if (isArchived) archived.push(idx);
      return idx;
    }
    // every archived object reference inside a dict must be a UID marker
    function refMarker(targetIdx) { return addObj(new Uid(targetIdx), false); }
    const idxNull = addObj('$null', true);
    const idxRoot = addObj(null, true);
    const idxClass = addObj(null, true);
    const entries = [];
    for (const k of Object.keys(rootScalarDict)) {
      const v = rootScalarDict[k];
      const kIdx = addObj(k, true);
      let vIdx;
      if (v === null || v === undefined) {
        vIdx = addObj(new Uid(0), false);
      } else if (v instanceof Uid) {
        vIdx = addObj(v, false);
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        vIdx = addObj(v, true);
      } else if (typeof v === 'string') {
        vIdx = refMarker(addObj(v, true));
      } else {
        vIdx = refMarker(addObj(v, true));
      }
      entries.push([kIdx, vIdx]);
    }
    const classKeyIdx = addObj('$class', true);
    entries.push([classKeyIdx, refMarker(idxClass)]);
    objects[idxRoot] = { __dict: entries };
    const cnKey = addObj('$classname', true);
    const cnVal = addObj(className, true);
    const csKey = addObj('$classes', true);
    const csVals = classChain.map(c => addObj(c, true));
    const csArr = addObj({ __array: csVals }, true);
    objects[idxClass] = { __dict: [[cnKey, cnVal], [csKey, csArr]] };
    // top-level archive plumbing (plain plist objects, not archived)
    const uidRoot = addObj(new Uid(idxRoot), false);
    const rootKey = addObj('root', false);
    const topDict = addObj({ __dict: [[rootKey, uidRoot]] }, false);
    const objectsArr = addObj({ __array: archived.slice() }, false);
    const vKey = addObj('$version', false);
    const vVal = addObj(100000, false);
    const aKey = addObj('$archiver', false);
    const aVal = addObj('NSKeyedArchiver', false);
    const tKey = addObj('$top', false);
    const oKey = addObj('$objects', false);
    const archiveIdx = addObj({
      __dict: [[vKey, vVal], [aKey, aVal], [tKey, topDict], [oKey, objectsArr]]
    }, false);
    return serialize(objects, archiveIdx);
  }

  const api = { Uid, serialize, writeKeyedArchive };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { bplist: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
