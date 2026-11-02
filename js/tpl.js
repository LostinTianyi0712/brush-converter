/* Photoshop tool presets: 8BTP resource container, native tool descriptors. */
(function(root){
  'use strict';
  const node=typeof module!=='undefined'&&module.exports&&typeof process!=='undefined';
  const u=node?require('./util'):root.BC.util, d=node?require('./descriptor'):root.BC.descriptor;
  const abr=node?require('./abr'):root.BC.abr;
  const template=node?require('./tplTemplate'):root.BC.tplTemplate;
  const cat=parts=>u.concat(parts), text=s=>u.utf8Encode(s);
  function be(n){return Uint8Array.of(n>>>24,(n>>>16)&255,(n>>>8)&255,n&255);}
  function uni(s){const b=new Uint8Array(s.length*2);for(let i=0;i<s.length;i++){b[i*2]=s.charCodeAt(i)>>>8;b[i*2+1]=s.charCodeAt(i)&255;}return cat([be(s.length),b]);}
  function id(s){return cat([be(s.length===4?0:s.length),text(s)]);}
  function item(key,tag,value){return cat([id(key),text(tag),value]);}
  function descriptor(cls,items){return cat([uni('\0'),id(cls),be(items.length),...items]);}
  function block(key,data,alignment){const a=alignment||4;return cat([text('8BIM'+key),be(data.length),data,new Uint8Array((a-data.length%a)%a)]);}
  function isTpl(b){return !!b&&b.length>=4&&u.ascii(b,0,4)==='8BTP';}
  function resources(b){
    if(!isTpl(b)||b.length<12)throw Error('TPL 工具预设头不完整');
    const version=u.u32(b,4),count=u.u32(b,8);
    if(![2,3].includes(version))throw Error('不支持的 TPL 版本 '+version);
    if(count>256)throw Error('TPL 资源数量异常');
    let p=12;const out=[];
    for(let i=0;i<count;i++){
      if(p+12>b.length||u.ascii(b,p,4)!=='8BIM')throw Error('TPL 资源结构不完整');
      const key=u.ascii(b,p+4,4),n=u.u32(b,p+8);p+=12;
      if(n>b.length-p)throw Error('TPL 资源数据不完整');
      out.push({key,data:b.subarray(p,p+n)});p+=n+(4-n%4)%4;
      if(p>b.length)throw Error('TPL 资源对齐不完整');
    }
    return out;
  }
  function tools(data){
    if(data.length<4)throw Error('TPL 工具列表不完整');
    const count=u.u32(data,0);if(count>10000)throw Error('TPL 工具数量异常');
    let p=4;const out=[];
    for(let i=0;i<count;i++){
      if(p+4>data.length)throw Error('TPL 工具名称不完整');
      const n=u.u32(data,p);p+=4;
      if(n>Math.floor((data.length-p-4)/2)||n>1048576)throw Error('TPL 工具名称长度异常');
      let name='';for(let j=0;j<n;j++)name+=String.fromCharCode(u.u16(data,p+j*2));p+=2*n;
      name=name.replace(/\0+$/,'');if(name.startsWith('$$$/')&&name.includes('='))name=name.slice(name.lastIndexOf('=')+1);
      if(p+4>data.length||u.u32(data,p)!==16)throw Error('TPL 工具描述符版本异常');p+=4;
      const raw=data.subarray(p);let obj;
      try{obj=d.readDescriptor(raw);}catch(e){throw Error('TPL 工具描述符异常：'+e.message);}
      const end=obj._span[1];if(!end||end>raw.length)throw Error('TPL 工具描述符不完整');
      out.push({name,obj,raw:raw.subarray(0,end)});p+=end;
    }
    return out;
  }
  function rawItems(tool){return tool.obj.items.map(it=>({key:it.key,bytes:tool.raw.subarray(it._span[0],it._span[1])}));}
  function parse(bytes){
    const blocks=resources(bytes),list=blocks.filter(b=>b.key==='tptp').flatMap(b=>tools(b.data));
    const selected=list.filter(t=>{const br=d.getItem(t.obj,'Brsh');return br&&br.type==='descriptor';});
    if(!selected.length)throw Error('TPL 中没有可转换的画笔工具预设（文字、裁剪、选区等工具不能转换为笔刷）');
    const presets=selected.map(t=>{
      const entries=rawItems(t).filter(it=>it.key!=='Nm  '&&it.key!=='toolOptions').map(it=>it.bytes);
      entries.push(item('Nm  ','TEXT',uni(t.name)),item('toolOptions','Objc',t.raw));
      return cat([text('Objc'),descriptor('brushPreset',entries)]);
    });
    const desc=cat([be(16),descriptor('null',[item('Brsh','VlLs',cat([be(presets.length),...presets]))])]);
    const converted=[block('desc',desc,2)];
    // tpbd contains sampled brush records; tpsh is VECTOR custom shapes.
    // Treating tpsh as brush bitmaps causes Photoshop's path-data error.
    for(const b of blocks){if(b.key==='tpbd')converted.push(block('samp',b.data,2));if(b.key==='tppa')converted.push(block('patt',b.data,2));}
    const result=abr.parse(cat([Uint8Array.of(0,6,0,1),...converted]));
    result.brushes.forEach((b,i)=>{b._tplTool=selected[i].obj.classId;b._tplOptions=selected[i].raw;b.source='abr';b.sourceFormat='tpl';});
    if(list.length>selected.length)result.warnings.push('已跳过 '+(list.length-selected.length)+' 个非画笔工具预设');
    if(selected.some(t=>!['PbTl','paintbrushTool','pencilTool','PcTl'].includes(t.obj.classId)))result.warnings.push('TPL 中擦除、修复、混合等工具跨软件仅转换笔尖和可映射画笔参数，工具行为并不等价；再导出 TPL 会保留原工具类型');
    return result;
  }
  function fromAbr(bytes,brushes,patBytes){
    const blocks=[];let p=4;
    while(p+12<=bytes.length){const n=u.u32(bytes,p+8);if(u.ascii(bytes,p,4)!=='8BIM'||n>bytes.length-p-12)throw Error('TPL 输出的中间 ABR 结构不完整');blocks.push({key:u.ascii(bytes,p+4,4),data:bytes.subarray(p+12,p+12+n)});p+=12+n+(n&1);}
    const db=blocks.find(b=>b.key==='desc');if(!db)throw Error('TPL 输出缺少画笔参数');
    const ps=d.getItem(d.parseDescBlock(db.data).root,'Brsh');if(!ps||ps.type!=='list')throw Error('TPL 输出画笔列表异常');
    const entries=ps.items.map((preset,i)=>{
      const original=brushes[i]&&brushes[i]._tplOptions;
      const opts=original?{raw:original,obj:d.readDescriptor(original)}:null;
      const rootItems=preset.items.filter(it=>it.key!=='Nm  '&&it.key!=='toolOptions');
      const options=d.getItem(preset,'toolOptions');
      const combined=new Map();
      if(!opts){const raw=template.getBytes();for(const it of rawItems({raw,obj:d.readDescriptor(raw)}))combined.set(it.key,it.bytes);}
      if(opts)for(const it of rawItems(opts))combined.set(it.key,it.bytes);
      if(options&&options.items)for(const it of options.items)combined.set(it.key,db.data.subarray(it._span[0],it._span[1]));
      for(const it of rootItems)combined.set(it.key,db.data.subarray(it._span[0],it._span[1]));
      // A native TPL has these values both at the root and in the synthetic
      // ABR toolOptions. Parameter edits patch toolOptions; those tool-only
      // fields must win, while root Brsh/dynamics/texture edits must also win.
      const toolKeys=new Set(['flow','Opct','Smoo','Md  ','smoothing','smoothingValue','smoothingRadiusMode','smoothingCatchup','smoothingCatchupAtEnd','smoothingZoomCompensation','pressureSmoothing']);
      if(options&&options.items)for(const it of options.items)if(toolKeys.has(it.key))combined.set(it.key,db.data.subarray(it._span[0],it._span[1]));
      for(const key of ['brushPreset','brushGroup','useBrushSize'])combined.delete(key);
      const tx=d.getItem(preset,'Txtr');
      if(!tx||!tx.items||!tx.items.length)combined.delete('Txtr');
      const cls=brushes[i]&&brushes[i]._tplTool||'PbTl';
      return cat([uni((d.getItem(preset,'Nm  ')||'Brush')+'\0'),be(16),descriptor(cls,Array.from(combined.values()))]);
    });
    const resourcesOut=[];
    let patterns=blocks.filter(b=>b.key==='patt').map(b=>b.data);
    if(patBytes){
      const reader=node?require('./patRead'):root.BC.patRead,pat=node?require('./pat'):root.BC.pat;
      for(const p of reader.readPat(patBytes)){
        const rec=pat.buildPattern(p.name,p.width,p.height,[p.gray,p.gray,p.gray],p.id,true).record;
        patterns.push(cat([be(rec.length),rec,new Uint8Array((4-(rec.length%4))%4)]));
      }
    }
    if(patterns.length)resourcesOut.push(block('tppa',cat(patterns)));
    for(const b of blocks){
      if(b.key==='samp'){
        // TPL tpbd uses the original 47-byte sampled-brush header, not the
        // modern ABR v6/2 301-byte VM header. Re-encode decoded mask pixels.
        const entries=abr.parseSampBlock(b.data,u.u16(bytes,0),u.u16(bytes,2));
        const samples=[];
        for(const sample of entries){
          const tip=sample.tip;if(!tip||!tip.data||!sample.uuid)throw Error('TPL 笔尖图像无法解码');
          const w=tip.w,h=tip.h;
          const short=n=>Uint8Array.of(n>>>8,n&255);
          // Old header: UUID + 16-bit top/left/bottom/right + depth.
          const head=cat([text('$'+sample.uuid),be(0),short(h),short(w),short(8)]);
          const rect=cat([be(0),be(0),be(h),be(w),short(8),Uint8Array.of(1)]);
          const body=cat([head,rect,abr.rleEncode(tip.data,w,h)]);
          samples.push(cat([be(body.length),body,new Uint8Array((4-(body.length%4))%4)]));
        }
        resourcesOut.push(block('tpbd',cat(samples)));
      }
    }
    resourcesOut.push(block('tptp',cat([be(entries.length),...entries])));
    return cat([text('8BTP'),be(3),be(resourcesOut.length),...resourcesOut]);
  }
  const api={isTpl,parse,fromAbr,resources,tools};
  if(node)module.exports=api;else root.BC=Object.assign(root.BC||{},{tpl:api});
})(typeof globalThis!=='undefined'?globalThis:this);
