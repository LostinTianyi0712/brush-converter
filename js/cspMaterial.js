/* Single-colour CSP material writer. Native format evidence and independent
 * fixtures: research/sut-material139. All exported image coverage is real
 * Offscreen tile data; the PNG is a matching preview, never a substitute. */
(function(root){
  'use strict';
  const node=typeof module!=='undefined'&&module.exports&&typeof process!=='undefined';
  const util=node?require('./util'):root.BC.util;
  const sql=node?require('./sqlite'):root.BC.sqlite;
  const writer=node?require('./sutWrite'):root.BC.sutWrite;
  const seed=node?require('./cspMaterialTemplate'):root.BC.cspMaterialTemplate;
  const png=node?require('./png'):root.BC.png;
  const zip=node?require('./zip'):root.BC.zip;
  const zlib=node?require('./zlib'):root.BC.zlib;
  const MAX_PIXELS=16777216;
  function le32(b,p){return new DataView(b.buffer,b.byteOffset+p,4).getUint32(0,true);}
  function le16(b,p){return b[p]|(b[p+1]<<8);}
  function word(v,le){const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v,!!le);return b;}
  function words(v){return util.concat(v.map(function(n){return word(n);}));}
  function text16(s,le){const b=new Uint8Array(s.length*2),d=new DataView(b.buffer);for(let i=0;i<s.length;i++)d.setUint16(i*2,s.charCodeAt(i),!!le);return b;}
  function named(s){return util.concat([word(s.length),text16(s,false)]);}
  function table(s,values){return util.concat([named(s),words([12,values.length,4]),words(values)]);}
  function uuid(){const s=util.toHex(util.randomBytes(16));return [s.slice(0,10),s.slice(10,14),s.slice(14,18),s.slice(18,22),s.slice(22)].join('-');}
  function xml(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c];});}
  function adler(data){let a=1,b=0;for(let i=0;i<data.length;i++){a=(a+data[i])%65521;b=(b+a)%65521;}return (b*65536+a)>>>0;}
  function dimensions(w,h){if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>4096||h>4096||w*h>MAX_PIXELS)throw Error('CSP素材尺寸无效或超过4096×4096限制');}
  function check(image){dimensions(image.w,image.h);if(!(image.mask instanceof Uint8Array)||image.mask.length!==image.w*image.h)throw Error('CSP素材像素长度不匹配');}
  function validateSource(w,h,data,channels){
    dimensions(w,h);
    if(!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)||data.length!==w*h*channels)throw Error('CSP素材像素长度不匹配');
  }
  function encodeBlocks(image,w,h){
    const bx=Math.ceil(w/256),by=Math.ceil(h/256),records=[],checks=[],status=[],sizes=[];
    for(let yb=0;yb<by;yb++)for(let xb=0;xb<bx;xb++){
      const raw=new Uint8Array(327680);let present=0;
      if(image)for(let y=0;y<Math.min(256,h-yb*256);y++){
        const start=(yb*256+y)*w+xb*256,n=Math.min(256,w-xb*256);
        const span=image.mask.subarray(start,start+n);raw.set(span,y*256);
        if(!present)for(let x=0;x<span.length;x++)if(span[x]){present=1;break;}
      }
      const parts=[named('BlockDataBeginChunk'),words([records.length,327680,256,256,present])];
      let sum=0;
      if(present){const comp=zlib.deflate(raw,6),framed=util.concat([word(comp.length,true),comp]);parts.push(word(framed.length),framed);sum=adler(framed);}
      parts.push(named('BlockDataEndChunk'));
      const body=util.concat(parts),record=util.concat([word(body.length+4),body]);
      records.push(record);sizes.push(record.length);checks.push(sum);status.push(present);
    }
    records.push(table('BlockStatus',status),table('BlockCheckSum',checks));
    return {data:util.concat(records),sizes:sizes};
  }
  function attribute(old,w,h,sizes){
    let pos=16;const sections=[];
    for(let i=0;i<3;i++){
      const n=util.u32(old,4+i*4),part=old.subarray(pos,pos+n),count=util.u32(part,0);pos+=n;
      let label='';for(let c=0;c<count;c++)label+=String.fromCharCode(util.u16(part,4+c*2));
      const vals=[];for(let p=4+count*2;p<part.length;p+=4)vals.push(util.u32(part,p));
      if(label==='Parameter')vals.splice(0,4,w,h,Math.ceil(w/256),Math.ceil(h/256));
      if(label==='BlockSize')sections.push(table(label,sizes));else sections.push(util.concat([named(label),words(vals)]));
    }
    return util.concat([words([16].concat(sections.map(function(p){return p.length;})))].concat(sections));
  }
  function c2f(body){
    const chunks=[new Uint8Array([137,67,50,70,13,10,26,10])];
    [['HEAD',new Uint8Array(0)],['dATA',util.concat([new Uint8Array(2),body])],['TAIL',new Uint8Array(0)]].forEach(function(c){
      const data=util.concat([util.utf8Encode(c[0]),c[1]]);chunks.push(word(c[1].length,true),data,word(util.crc32(data),true));
    });return util.concat(chunks);
  }
  function tar(files){
    const pieces=[];
    files.forEach(function(f){
      const head=new Uint8Array(512);head.set(util.utf8Encode(f.name));
      function oct(at,n,value){head.set(util.utf8Encode(value.toString(8).padStart(n-1,'0')+'\0'),at);}
      oct(100,8,420);oct(108,8,0);oct(116,8,0);oct(124,12,f.data.length);oct(136,12,0);
      head.fill(32,148,156);head[156]=48;head.set(util.utf8Encode('ustar\0'+'00'),257);
      let sum=0;for(let i=0;i<512;i++)sum+=head[i];head.set(util.utf8Encode(sum.toString(8).padStart(6,'0')+'\0 '),148);
      pieces.push(head,f.data,new Uint8Array((512-f.data.length%512)%512));
    });pieces.push(new Uint8Array(1024));const data=util.concat(pieces);
    return util.concat([data,new Uint8Array((10240-data.length%10240)%10240)]);
  }
  function reference(path,name,catalog){
    const p=text16(path,true),n=text16(name,true),c=text16(catalog,true);
    const item=util.concat([word(p.length),p,word(2),word(n.length),n,word(1),word(c.length),c,word(0)]);
    return util.concat([word(8),word(1),word(item.length+4),item]);
  }
  function make(image,name){
    check(image);
    const tpl=seed.get('material'),db=sql.read(tpl),rows={},ids=Object.create(null);
    function remap(s){return s.replace(/[0-9a-f]{10}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{10}/g,function(id){return ids[id]||(ids[id]=uuid());});}
    let catalog=remap(seed.get('catalog')).replace(/BC136_L/g,function(){return xml(name);});
    const catalogId=/uuid="([^"]+)"/.exec(catalog)[1];
    const info=remap(seed.get('info')),ice=remap(seed.get('ice'));
    db.tables.forEach(function(t){rows[t.name]=t.rawRows.map(function(r){return {rowid:r.rowid,values:r.values.map(function(v){return typeof v==='string'?remap(v):v;})};});});
    function change(table,row,values){const t=sql.getTable(db,table);Object.keys(values).forEach(function(k){const ci=t.columns.indexOf(k);if(ci<0)throw Error('CSP素材模板缺少列 '+k);row.values[ci]=values[k];});}
    const rgba=new Uint8Array(image.w*image.h*4);for(let i=0;i<image.mask.length;i++)rgba[i*4+3]=image.mask[i];
    const preview=png.encode(image.w,image.h,rgba);
    change('Material',rows.Material[0],{MaterialName:name});
    change('Canvas',rows.Canvas[0],{CanvasWidth:image.w,CanvasHeight:image.h});
    change('CanvasPreview',rows.CanvasPreview[0],{ImageWidth:image.w,ImageHeight:image.h,ImageData:preview});
    const off=sql.getTable(db,'Offscreen');
    rows.Offscreen.forEach(function(row){
      const actual=row.values[off.columns.indexOf('MainId')]===7;
      const blocks=encodeBlocks(actual?image:null,image.w,image.h);
      change('Offscreen',row,{Attribute:attribute(row.values[off.columns.indexOf('Attribute')],image.w,image.h,blocks.sizes),BlockData:blocks.data});
    });
    rows.Layer.forEach(function(row){const t=sql.getTable(db,'Layer'),ci=t.columns.indexOf('LayerName');if(row.values[ci]==='BC136_L')row.values[ci]=name;});
    const layer=c2f(writer.buildSut(tpl,{tableRows:rows}));
    const ratio=Math.min(1,128/image.w,128/image.h),tw=Math.max(1,Math.round(image.w*ratio)),th=Math.max(1,Math.round(image.h*ratio));
    const thumbnail=png.encode(tw,th,png.resize(rgba,image.w,image.h,tw,th));
    const archive=tar([
      {name:'catalog.zip',data:zip.write([{name:'catalog.xml',data:util.utf8Encode(catalog)}])},
      {name:'info.zip',data:zip.write([{name:'info.xml',data:util.utf8Encode(info)}])},
      {name:'icedata/layerData.xml',data:util.utf8Encode(ice)},
      {name:'data/material_0.layer',data:layer},
      {name:'thumbnail/thumbnail.png',data:thumbnail}
    ]);
    const cat='.:74:92:'+catalogId,path=cat+':data:material_0.layer';
    return {data:archive,path:path,catalog:cat,ref:reference(path,name,cat)};
  }
  function build(options){
    const params=Object.assign({},options.params),materials=[];
    params.BrushUsePatternImage=0;params.BrushPatternImageArray=null;params.TextureImage=null;
    function attach(image,kind){
      const material=make(image,options.name+(kind==='texture'?'_纹理':''));
      materials.push({rowid:materials.length+1,values:[null,0,material.path,0,material.data,material.catalog,null]});
      if(kind==='tip'){params.BrushUsePatternImage=1;params.BrushPatternImageArray=material.ref;params.BrushChangePatternColor=1;}
      else {params.TextureImage=material.ref;params.TextureDensity=options.textureDensity===undefined?100:options.textureDensity;params.TextureScale2=options.textureScale===undefined?100:options.textureScale;params.TextureReverseDensity=0;}
    }
    if(options.tip)attach(options.tip,'tip');if(options.texture)attach(options.texture,'texture');
    return writer.buildSut(seed.get('sut'),{params:params,nodeName:options.name,tableRows:{MaterialFile:materials}});
  }
  // Only the independently verified plain C2F / single-colour tile layout.
  // Encrypted or other native layouts remain on the explicit preview fallback.
  function read(layer){
    const magic=[137,67,50,70,13,10,26,10];
    if(!(layer instanceof Uint8Array)||!magic.every(function(v,i){return layer[i]===v;}))throw Error('Unsupported material container');
    let pos=8;const payload=[];
    while(pos<layer.length){
      if(pos+12>layer.length)throw Error('Truncated C2F header');
      const n=le32(layer,pos),end=pos+8+n;
      if(end+4>layer.length||util.crc32(layer.subarray(pos+4,end))!==le32(layer,end))throw Error('Invalid C2F chunk');
      const type=util.utf8Decode(layer.subarray(pos+4,pos+8));
      if(type==='dATA'){
        if(n<2||layer[pos+8]!==0||layer[pos+9]!==0)throw Error('Encrypted material');
        payload.push(layer.subarray(pos+10,end));
      }
      pos=end+4;
    }
    const body=util.concat(payload);
    if(!sql.isSqlite(body))throw Error('Material is not plain SQLite');
    const db=sql.read(body),off=sql.getTable(db,'Offscreen');
    const row=off&&off.rows.filter(function(r){return r.MainId===7;})[0];
    if(!row)throw Error('Missing raster');
    function reader(data){
      let at=0;
      return {take:function(n){if(!Number.isSafeInteger(n)||n<0||at+n>data.length)throw Error('Truncated material raster');const b=data.subarray(at,at+n);at+=n;return b;},
        u32:function(){return util.u32(this.take(4),0);},
        name:function(){const b=this.take(this.u32()*2);let s='';for(let i=0;i<b.length;i+=2)s+=String.fromCharCode(util.u16(b,i));return s;},
        position:function(){return at;},length:data.length};
    }
    const attr=reader(row.Attribute);
    if(attr.u32()!==16)throw Error('Unsupported raster attributes');
    const lens=[attr.u32(),attr.u32(),attr.u32()],sections={};
    lens.forEach(function(n){const part=reader(attr.take(n)),key=part.name(),values=[];while(part.position()<part.length)values.push(part.u32());sections[key]=values;});
    const p=sections.Parameter||[],w=p[0],h=p[1],bx=p[2],by=p[3];dimensions(w,h);
    if(attr.position()!==attr.length||bx!==Math.ceil(w/256)||by!==Math.ceil(h/256)||p[4]!==33||p[6]!==4||p[8]!==65536||p[10]!==1024||p[12]!==256)throw Error('Unsupported raster layout');
    const mask=new Uint8Array(w*h),r=reader(row.BlockData),statuses=[],checks=[],sizes=[];
    for(let i=0;i<bx*by;i++){
      const start=r.position(),size=r.u32();
      if(r.name()!=='BlockDataBeginChunk'||r.u32()!==i||r.u32()!==327680||r.u32()!==256||r.u32()!==256)throw Error('Invalid raster block');
      const present=r.u32();if(present!==0&&present!==1)throw Error('Invalid block status');
      let sum=0;
      if(present){
        const framed=r.take(r.u32());
        if(framed.length<4||le32(framed,0)!==framed.length-4)throw Error('Invalid compressed length');
        const raw=zlib.inflateLimited(framed.subarray(4),327680);
        if(raw.length!==327680)throw Error('Invalid raster length');
        // Coloured layers need colour semantics; do not silently discard RGB.
        for(let c=65536;c<raw.length;c++)if(raw[c])throw Error('Coloured raster is not supported');
        const left=(i%bx)*256,top=Math.floor(i/bx)*256;
        for(let y=0;y<Math.min(256,h-top);y++)mask.set(raw.subarray(y*256,y*256+Math.min(256,w-left)),(top+y)*w+left);
        sum=adler(framed);
      }
      if(r.name()!=='BlockDataEndChunk'||r.position()-start!==size)throw Error('Invalid raster record size');
      statuses.push(present);checks.push(sum);sizes.push(size);
    }
    [['BlockStatus',statuses],['BlockCheckSum',checks]].forEach(function(t){
      if(r.name()!==t[0]||r.u32()!==12||r.u32()!==bx*by||r.u32()!==4)throw Error('Invalid raster table');
      t[1].forEach(function(v){if(r.u32()!==v)throw Error('Invalid raster checksum/status');});
    });
    const expected=[12,bx*by,4].concat(sizes),actual=sections.BlockSize||[];
    if(r.position()!==r.length||expected.length!==actual.length||expected.some(function(v,i){return v!==actual[i];}))throw Error('Invalid raster size table');
    return {w:w,h:h,mask:mask};
  }
  function referencePath(blob){
    if(!(blob instanceof Uint8Array)||blob.length<16||util.u32(blob,0)!==8||util.u32(blob,4)<1)return null;
    const n=util.u32(blob,12);if(n%2||n>blob.length-16)return null;
    let s='';for(let i=16;i<16+n;i+=2)s+=String.fromCharCode(le16(blob,i));return s;
  }
  const api={build:build,make:make,reference:reference,read:read,referencePath:referencePath,validateSource:validateSource,MAX_PIXELS:MAX_PIXELS};
  if(node)module.exports=api;else root.BC=Object.assign(root.BC||{},{cspMaterial:api});
})(typeof globalThis!=='undefined'?globalThis:this);
