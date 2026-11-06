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
  /* Supported native tile layouts (Parameter[4,6,8,10,12]); coverage is always the
     first 65536-byte plane of a 256x256 tile.
       33/4/65536/1024/256 : coverage + 4 colour planes (colour must be empty)
       17/1/65536/256/256  : coverage + 1 secondary plane (verified: plane 0 = coverage)
        1/0/0/0/256        : coverage only */
  function tileBytes(p){
    if(p[4]===33&&p[6]===4&&p[8]===65536&&p[10]===1024&&p[12]===256)return 327680;
    if(p[4]===17&&p[6]===1&&p[8]===65536&&p[10]===256&&p[12]===256)return 131072;
    if(p[4]===1&&p[6]===0&&p[8]===0&&p[10]===0&&p[12]===256)return 65536;
    return 0;
  }
  function reader(data){
    let at=0;
    return {take:function(n){if(!Number.isSafeInteger(n)||n<0||at+n>data.length)throw Error('Truncated material raster');const b=data.subarray(at,at+n);at+=n;return b;},
      u32:function(){return util.u32(this.take(4),0);},
      name:function(){const b=this.take(this.u32()*2);let s='';for(let i=0;i<b.length;i+=2)s+=String.fromCharCode(util.u16(b,i));return s;},
      position:function(){return at;},length:data.length};
  }
  function decodeRaster(row){
    const attr=reader(row.Attribute);
    if(attr.u32()!==16)throw Error('Unsupported raster attributes');
    const lens=[attr.u32(),attr.u32(),attr.u32()],sections={};
    lens.forEach(function(n){const part=reader(attr.take(n)),key=part.name(),values=[];while(part.position()<part.length)values.push(part.u32());sections[key]=values;});
    const p=sections.Parameter||[],w=p[0],h=p[1],bx=p[2],by=p[3];dimensions(w,h);
    const raw0=tileBytes(p);
    if(attr.position()!==attr.length||bx!==Math.ceil(w/256)||by!==Math.ceil(h/256)||!raw0)throw Error('Unsupported raster layout');
    const mask=new Uint8Array(w*h),r=reader(row.BlockData),statuses=[],checks=[],sizes=[];let presentCount=0;
    for(let i=0;i<bx*by;i++){
      const start=r.position(),size=r.u32();
      if(r.name()!=='BlockDataBeginChunk'||r.u32()!==i||r.u32()!==raw0||r.u32()!==256||r.u32()!==256)throw Error('Invalid raster block');
      const present=r.u32();if(present!==0&&present!==1)throw Error('Invalid block status');
      let sum=0;
      if(present){
        presentCount++;
        const framed=r.take(r.u32());
        if(framed.length<4||le32(framed,0)!==framed.length-4)throw Error('Invalid compressed length');
        const raw=zlib.inflateLimited(framed.subarray(4),raw0);
        if(raw.length!==raw0)throw Error('Invalid raster length');
        // Coloured layers need colour semantics; do not silently discard RGB.
        for(let c=65536;c<raw.length&&raw0===327680;c++)if(raw[c])throw Error('Coloured raster is not supported');
        const left=(i%bx)*256,top=Math.floor(i/bx)*256;
        for(let y=0;y<Math.min(256,h-top);y++)mask.set(raw.subarray(y*256,y*256+Math.min(256,w-left)),(top+y)*w+left);
        sum=adler(framed);
      }
      if(r.name()!=='BlockDataEndChunk'||r.position()-start!==size)throw Error('Invalid raster record size');
      statuses.push(present);checks.push(sum);sizes.push(size);
    }
    [['BlockStatus',statuses],['BlockCheckSum',checks]].forEach(function(t){
      if(r.position()===r.length)return; // native files may end right after the last tile record
      if(r.name()!==t[0]||r.u32()!==12||r.u32()!==bx*by||r.u32()!==4)throw Error('Invalid raster table');
      t[1].forEach(function(v,i){const x=r.u32();if(t[0]==='BlockStatus'?(x!==0&&x!==1):(statuses[i]?x!==v:x!==0))throw Error('Invalid raster checksum/status');});
    });
    const expected=[12,bx*by,4].concat(sizes),actual=sections.BlockSize||[];
    if(r.position()!==r.length||expected.length!==actual.length||expected.some(function(v,i){return v!==actual[i];}))throw Error('Invalid raster size table');
    return {w:w,h:h,mask:mask,present:presentCount};
  }
  /* Row choice: a row that actually carries tiles wins (self-made MainId 7 first,
     then the largest); an all-empty MainId 7 raster is a legitimately empty tip. */
  function pickRaster(rows){
    const good=[];let empty=null,lastError=null;
    rows.forEach(function(row){
      if(row.MainId!==7&&row.MainId!==8&&row.MainId!==9&&row.MainId!==10)return;
      if(!(row.Attribute instanceof Uint8Array)||!(row.BlockData instanceof Uint8Array))return;
      let image;try{image=decodeRaster(row);}catch(e){lastError=e;return;}
      if(image.present)good.push({image:image,id:row.MainId,len:row.BlockData.length});
      else if(row.MainId===7&&!empty)empty=image;
    });
    good.sort(function(a,b){return (b.id===7)-(a.id===7)||b.len-a.len;});
    if(good.length)return good[0].image;
    if(empty)return empty;
    throw lastError||Error('Missing raster');
  }
  /* The first dATA chunk of many native files encrypts only the first 5120 bytes
     of the inner SQLite file; the remaining chunks are plaintext and keep every
     page at its original offset, so b-tree leaf pages can be scanned directly. */
  function varint(b,p,end){
    const limit=end===undefined?b.length:end;let v=0;
    for(let i=0;i<9;i++){
      if(p+i>=limit)throw Error('Truncated material varint');
      const c=b[p+i];v=i===8?v*256+c:v*128+(c&127);
      if(!Number.isSafeInteger(v))throw Error('Oversized material varint');
      if(i===8||c<128)return [v,p+i+1];
    }
  }
  function serialLen(s){if(s<=4)return s;if(s===5)return 6;if(s===6||s===7)return 8;if(s>=12)return (s-(s%2?13:12))/2;return 0;}
  function scanRows(body){
    for(const ps of [1024,4096,2048,8192]){
      if(body.length%ps)continue;
      const pages=body.length/ps,rows=[];
      for(let pg=1;pg<=pages;pg++){
        const base=(pg-1)*ps;if(body[base]!==0x0d)continue;
        const cells=(body[base+3]<<8)|body[base+4];if(!cells||8+cells*2>ps)continue;
        for(let c=0;c<cells;c++){
          try{
            const co=(body[base+8+c*2]<<8)|body[base+9+c*2];if(co<8||co>=ps)continue;
            let q=varint(body,base+co,base+ps);const total=q[0];q=varint(body,q[1],base+ps);let at=q[1];
            if(total>body.length)continue;
            const maxLocal=ps-35;let local=total;
            if(total>maxLocal){const m=Math.floor((ps-12)*32/255)-23;local=m+((total-m)%(ps-4));if(local>maxLocal)local=m;}
            if((at-base)+local>ps)continue;
            const parts=[body.subarray(at,at+local)];let rem=total-local;
            if(rem>0){
              if(at+local+4>base+ps)continue;
              let ov=util.u32(body,at+local);const seen=new Set();
              while(rem>0&&ov>=1&&ov<=pages&&!seen.has(ov)){seen.add(ov);const o=(ov-1)*ps,take=Math.min(rem,ps-4);parts.push(body.subarray(o+4,o+4+take));rem-=take;ov=util.u32(body,o);}
            }
            if(rem!==0)continue;
            const rec=parts.length===1?parts[0]:util.concat(parts);
            const hl=varint(rec,0),kinds=[];let hp=hl[1];
            if(hl[0]<hp||hl[0]>rec.length)continue;
            while(hp<hl[0]&&kinds.length<6){const s=varint(rec,hp,hl[0]);kinds.push(s[0]);hp=s[1];}
            if(hp!==hl[0]||kinds.length!==6)continue;
            let bp=hl[0];const vals=[];
            kinds.forEach(function(k){
              const length=serialLen(k);
              if(k===10||k===11||!Number.isSafeInteger(length)||length<0||bp+length>rec.length)throw Error('Invalid material record');
              if(k<=6&&k>=1){let n=0;const len=serialLen(k);for(let i=0;i<len;i++)n=n*256+rec[bp+i];vals.push(n);bp+=len;}
              else if(k>=12){const len=serialLen(k);vals.push(rec.subarray(bp,bp+len));bp+=len;}
              else{vals.push(k===8?0:k===9?1:null);if(k===7)bp+=8;}
            });
            if(bp!==rec.length)continue;
            if(vals[4] instanceof Uint8Array&&vals[5] instanceof Uint8Array)rows.push({MainId:vals[1],Attribute:vals[4],BlockData:vals[5]});
          }catch(e){/* damaged cell: keep scanning */}
        }
      }
      if(rows.length)return rows;
    }
    return [];
  }
  // Plain C2F and the partially-encrypted native layout are read at original
  // resolution; anything else stays on the explicit preview fallback.
  function read(layer){
    const magic=[137,67,50,70,13,10,26,10];
    if(!(layer instanceof Uint8Array)||!magic.every(function(v,i){return layer[i]===v;}))throw Error('Unsupported material container');
    let pos=8;const chunks=[];
    while(pos<layer.length){
      if(pos+12>layer.length)throw Error('Truncated C2F header');
      const n=le32(layer,pos),end=pos+8+n;
      if(end+4>layer.length||util.crc32(layer.subarray(pos+4,end))!==le32(layer,end))throw Error('Invalid C2F chunk');
      const type=util.utf8Decode(layer.subarray(pos+4,pos+8));
      if(type==='dATA'){
        if(n<2)throw Error('Encrypted material');
        chunks.push({flag:layer[pos+8]|(layer[pos+9]<<8),data:layer.subarray(pos+10,end)});
      }
      pos=end+4;
    }
    if(!chunks.length)throw Error('Missing material data');
    let rows;
    if(chunks.every(function(c){return c.flag===0;})){
      const body=util.concat(chunks.map(function(c){return c.data;}));
      if(!sql.isSqlite(body))throw Error('Material is not plain SQLite');
      const off=sql.getTable(sql.read(body),'Offscreen');
      rows=off?off.rows:[];
    }else if(chunks.length>=2&&chunks[0].flag===1&&chunks.slice(1).every(function(c){return c.flag===0;})&&chunks[0].data.length>8){
      const lead=new Uint8Array(chunks[0].data.length-8);
      rows=scanRows(util.concat([lead].concat(chunks.slice(1).map(function(c){return c.data;}))));
    }else throw Error('Encrypted material');
    const image=pickRaster(rows);
    return {w:image.w,h:image.h,mask:image.mask};
  }
  function referencePath(blob){
    if(!(blob instanceof Uint8Array)||blob.length<16||util.u32(blob,0)!==8||util.u32(blob,4)<1)return null;
    const n=util.u32(blob,12);if(n%2||n>blob.length-16)return null;
    let s='';for(let i=16;i<16+n;i+=2)s+=String.fromCharCode(le16(blob,i));return s;
  }
  const api={build:build,make:make,reference:reference,read:read,referencePath:referencePath,validateSource:validateSource,MAX_PIXELS:MAX_PIXELS};
  if(node)module.exports=api;else root.BC=Object.assign(root.BC||{},{cspMaterial:api});
})(typeof globalThis!=='undefined'?globalThis:this);
