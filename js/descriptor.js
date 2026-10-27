/* Photoshop Action Descriptor parser (used by ABR desc blocks) */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  let U = null;
  function util() { if (!U) U = isNode ? require('./util.js') : root.BC.util; return U; }

  const MAX_DEPTH = 60;
  const MAX_STR = 1 << 20;

  function Reader(bytes, pos) { this.b = bytes; this.p = pos || 0; }
  Reader.prototype = {
    u8: function () { return this.b[this.p++]; },
    u16: function () { const v = (this.b[this.p] << 8) | this.b[this.p + 1]; this.p += 2; return v; },
    i32: function () { const b = this.b, p = this.p; this.p += 4; return (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]; },
    u32: function () { const b = this.b, p = this.p; this.p += 4; return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; },
    f64: function () { const v = util().f64(this.b, this.p); this.p += 8; return v; },
    raw: function (n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; },
    left: function () { return this.b.length - this.p; }
  };

  function readId(r) {
    const len = r.u32();
    if (len === 0) {
      const s = util().ascii(r.b, r.p, 4); r.p += 4; return s;
    }
    if (len > MAX_STR) throw new Error('descriptor id 过长');
    const s = util().ascii(r.b, r.p, len); r.p += len;
    return s.replace(/\u0000+$/, '');
  }

  function readTypeTag(r) {
    const s = util().ascii(r.b, r.p, 4); r.p += 4; return s;
  }

  function readUnicode(r) {
    const len = r.u32();
    if (len === 0) return '';
    if (len > MAX_STR) throw new Error('descriptor 字符串过长');
    let s = '';
    for (let i = 0; i < len; i++) {
      const cu = (r.b[r.p] << 8) | r.b[r.p + 1];
      r.p += 2;
      s += String.fromCharCode(cu);
    }
    return s.replace(/\u0000+$/, '');
  }

  function readReference(r) {
    const n = r.u32();
    const items = [];
    for (let i = 0; i < n; i++) {
      const t = readTypeTag(r);
      if (t === 'prop') items.push(['prop', readId(r), readId(r)]);
      else if (t === 'Clss') items.push(['Clss', readId(r)]);
      else if (t === 'Enmr') items.push(['Enmr', readId(r), readId(r), readId(r)]);
      else if (t === 'rele') items.push(['rele', readId(r), readId(r)]);
      else if (t === 'Idnt') items.push(['Idnt', r.i32()]);
      else if (t === 'indx') items.push(['indx', r.u32()]);
      else if (t === 'name') items.push(['name', readId(r), readUnicode(r)]);
      else throw new Error('未知引用类型 ' + t);
    }
    return { type: 'ref', items };
  }

  function readValue(r, tag, depth) {
    if (depth > MAX_DEPTH) throw new Error('descriptor 嵌套过深');
    switch (tag) {
      case 'bool': return r.u8() !== 0;
      case 'long': return r.i32();
      case 'doub': return r.f64();
      case 'TEXT': return readUnicode(r);
      case 'enum': return { type: 'enum', typeId: readId(r), value: readId(r) };
      case 'UntF': return { type: 'unit', unit: util().ascii(r.b, r.p, 4), value: (r.p += 4, r.f64()) };
      case 'VlLs': {
        const n = r.u32(); const arr = [];
        for (let i = 0; i < n; i++) {
          const t = readTypeTag(r);
          arr.push(readValue(r, t, depth + 1));
        }
        return { type: 'list', items: arr };
      }
      case 'Objc': {
        const st = r.p;
        const v = readDescriptorBody(r, depth + 1);
        v._span = [st, r.p];
        return v;
      }
      case 'tdta': { const n = r.u32(); return { type: 'data', bytes: r.raw(n) }; }
      case 'alis': { const n = r.u32(); return { type: 'alias', bytes: r.raw(n) }; }
      case 'obj ': return readReference(r);
      case 'Pth ': {
        const n = r.u32();
        for (let i = 0; i < n; i++) { r.u16(); r.u16(); r.u16(); r.u16(); r.u16(); r.u16(); }
        return { type: 'path', n };
      }
      case 'UnFl': {
        const n = r.u32(); const arr = [];
        for (let i = 0; i < n; i++) { const v = util().f32(r.b, r.p); r.p += 4; arr.push(v); }
        return { type: 'floatlist', items: arr };
      }
      case 'ObAr': {
        const n = r.u32();
        const desc = readDescriptorBody(r, depth + 1);
        for (let i = 0; i < n; i++) { const t = readTypeTag(r); readValue(r, t, depth + 1); }
        return { type: 'objectarray', n, desc };
      }
      case 'type':
      case 'GlbC':
      case 'GlbO': return readDescriptorBody(r, depth + 1);
      case 'Clr ': {
        const n = r.u32();
        const items = [];
        for (let i = 0; i < n; i++) { const k = readId(r); const t = readTypeTag(r); items.push([k, t, readValue(r, t, depth + 1)]); }
        return { type: 'color', items };
      }
      default: throw new Error('未知 descriptor 类型: ' + tag);
    }
  }

  function readDescriptorBody(r, depth) {
    if (depth > MAX_DEPTH) throw new Error('descriptor 嵌套过深');
    const start=r.p;
    const name = readUnicode(r);
    const classId = readId(r);
    const countAt=r.p;
    const n = r.u32();
    const items = [];
    for (let i = 0; i < n; i++) {
      const itemStart=r.p;
      const key = readId(r);
      const tag = readTypeTag(r);
      const valueStart=r.p,value=readValue(r,tag,depth+1);
      items.push({key,tag,value,_span:[itemStart,r.p],_valueSpan:[valueStart,r.p]});
    }
    return { type: 'descriptor', name, classId, items, _span:[start,r.p], _countAt:countAt };
  }

  // Replacement payloads are already encoded by the ABR writer. Preserve every
  // unrelated item byte-for-byte, including its original charID/stringID form.
  function patchDescriptor(bytes, patches) {
    const r=new Reader(bytes,0),root=readDescriptorBody(r,0),u=util();
    function id(key){const b=u.utf8Encode(key);return u.concat([be32(key.length===4?0:b.length),b]);}
    function be32(n){return new Uint8Array([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]);}
    function apply(node,list){
      const parts=[],seen=new Set();
      for(const it of node.items){
        const local=list.filter(p=>p.path[0]===it.key);local.forEach(p=>seen.add(p.path[0]));
        const direct=local.find(p=>p.path.length===1);
        if(direct)parts.push(u.concat([bytes.subarray(it._span[0],it._valueSpan[0]-4),u.utf8Encode(direct.tag),direct.data]));
        else if(local.length && it.value && it.value.type==='descriptor'){
          parts.push(u.concat([bytes.subarray(it._span[0],it._valueSpan[0]),apply(it.value,local.map(p=>Object.assign({},p,{path:p.path.slice(1)})))]));
        }else parts.push(bytes.subarray(it._span[0],it._span[1]));
      }
      const additions=list.filter(p=>p.path.length===1&&!seen.has(p.path[0]));
      for(const p of additions)parts.push(u.concat([p.header || u.concat([id(p.path[0]),u.utf8Encode(p.tag)]),p.data]));
      return u.concat([bytes.subarray(node._span[0],node._countAt),be32(node.items.length+additions.length)].concat(parts));
    }
    return apply(root,patches);
  }

  /* Parse the ABR desc block into a list of brush presets. */
  function parseDescBlock(data) {
    const r = new Reader(data, 0);
    const fmtVersion = r.u32();
    // tolerate the 3 class-name/class-id header variants (see Photoshop spec)
    const peek = r.u32();
    if (peek === 0) {
      const next = r.u32();
      if (next === 0) { r.p += 4; }
      else { r.p += next; }
    } else if (peek === 1) {
      const ch = r.u16();
      if (ch === 0) { readId(r); }
      else {
        r.p -= 6;
        readUnicode(r); readId(r);
      }
    } else {
      r.p -= 4;
      readUnicode(r); readId(r);
    }
    const count = r.u32();
    const root = { type: 'descriptor', name: '', classId: '', items: [] };
    for (let i = 0; i < count; i++) {
      const key = readId(r);
      const tag = readTypeTag(r);
      root.items.push({ key, tag, value: readValue(r, tag, 1) });
    }
    return { fmtVersion, root };
  }

  function getItem(desc, key) {
    if (!desc || !desc.items) return undefined;
    for (const it of desc.items) if (it.key === key) return it.value;
    return undefined;
  }

  function unitValue(v) {
    if (!v) return undefined;
    if (v.type === 'unit') return v.value;
    if (v.type === 'floatlist' && v.items.length) return v.items[0];
    return undefined;
  }

  const api = { parseDescBlock, getItem, unitValue, Reader, patchDescriptor,
    readDescriptor:function(bytes){return readDescriptorBody(new Reader(bytes,0),0);} };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { descriptor: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
