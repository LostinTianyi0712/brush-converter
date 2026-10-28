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
      if (obj && obj.__raw) {
        bytes = obj.__raw;
      } else if (obj && obj.__dict) {
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
        bytes = util.concat([lenMarker(obj.__arrayType || 0xa0, refs.length), body]);
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
    function refMarker(targetIdx) { return addObj(new Uid(archived.indexOf(targetIdx)), false); }
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

  // Patch root scalar values without flattening NSKeyedArchiver's object graph.
  // Opaque primitive encodings, class objects, UIDs and unknown fields survive.
  function patchKeyedArchive(bytes, changes) {
    if(!Object.keys(changes).length)return new Uint8Array(bytes);
    if(util.ascii(bytes,0,8)!=='bplist00' || bytes.length<40)throw Error('不能修改非二进制archive');
    const t=bytes.length-32, os=bytes[t+6], rs=bytes[t+7];
    function uint(at,n){let v=0;for(let i=0;i<n;i++)v=v*256+bytes[at+i];return v;}
    const count=uint(t+8,8),top=uint(t+16,8),table=uint(t+24,8);
    if(!os||os>8||!rs||rs>8||count>5000000||table+count*os>t)throw Error('archive对象表异常');
    const offsets=Array.from({length:count},(_,i)=>uint(table+i*os,os));
    const sorted=Array.from(new Set(offsets.concat(table))).sort((a,b)=>a-b),ends=new Map();
    for(let i=0;i<sorted.length-1;i++)ends.set(sorted[i],sorted[i+1]);
    function length(at){const info=bytes[at]&15;if(info<15)return {n:info,p:at+1};const size=1<<(bytes[at+1]&15);return {n:uint(at+2,size),p:at+2+size};}
    const objects=offsets.map(at=>{
      if(at<8||at>=table)throw Error('archive对象越界');
      const type=bytes[at]>>4;
      if(type===13){const q=length(at);return {__dict:Array.from({length:q.n},(_,i)=>[uint(q.p+i*rs,rs),uint(q.p+(q.n+i)*rs,rs)])};}
      if(type>=10&&type<=12){const q=length(at);return {__array:Array.from({length:q.n},(_,i)=>uint(q.p+i*rs,rs)),__arrayType:type<<4};}
      return {__raw:new Uint8Array(bytes.subarray(at,ends.get(at)))};
    });
    function textAt(i){if(typeof objects[i]==='string')return objects[i];const at=offsets[i];if(at===undefined)return null;const type=bytes[at]>>4,q=length(at);if(type===5)return util.ascii(bytes,q.p,q.n);if(type===6){let s='';for(let j=0;j<q.n;j++)s+=String.fromCharCode(uint(q.p+j*2,2));return s;}return null;}
    function get(dict,key){const item=dict&&dict.__dict&&dict.__dict.find(e=>textAt(e[0])===key);return item&&item[1];}
    const archived=objects[get(objects[top],'$objects')],wrapper=objects[get(objects[top],'$top')];
    const rootRef=get(wrapper,'root'),uidAt=offsets[rootRef];
    if(!archived||!archived.__array||uidAt===undefined||(bytes[uidAt]>>4)!==8)throw Error('archive根引用异常');
    const root=objects[archived.__array[uint(uidAt+1,(bytes[uidAt]&15)+1)]];
    if(!root||!root.__dict)throw Error('archive根字典异常');
    function add(value){objects.push(value);return objects.length-1;}
    for(const key of Object.keys(changes)){
      const value=changes[key];
      if(typeof value!=='number'&&typeof value!=='boolean'&&typeof value!=='string')throw Error('archive只支持局部修改标量');
      let ref;
      if(typeof value==='string'){
        archived.__array.push(add(value));ref=add(new Uid(archived.__array.length-1));
      }else ref=add(value);
      const pair=root.__dict.find(e=>textAt(e[0])===key);
      if(pair)pair[1]=ref;else root.__dict.push([add(key),ref]);
    }
    return serialize(objects,top);
  }

  const api = { Uid, serialize, writeKeyedArchive, patchKeyedArchive };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { bplist: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
