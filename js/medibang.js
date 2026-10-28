/* MediBang Paint / FireAlpaca material: .mdp = "mdipack" container
   [magic "mdipack\0"][u32 0][u32 xmlLen][u32 dataLen][XML][PAC sections]

   PAC image bin formats (reverse-engineered from real .mdp brush materials):
     plain bin : zlib(bytes = width*height*4 RGBA)
     tiled bin : u32 tileCount, u32 tileSize, then per tile:
                 [u32 col][u32 row][u32 0][u32 compLen] + zlib(tileSize*tileSize*4)
   The layer image is the brush stamp; the "thumb" bin is the 256px preview. */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const zlib = isNode ? require('./zlib.js') : root.BC.zlib;
  const png = isNode ? require('./png.js') : root.BC.png;

  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function le32(n) { return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]); }

  function isMdp(bytes) {
    if (!bytes || bytes.length < 24) return false;
    return util.ascii(bytes, 0, 8) === 'mdipack\u0000' || util.ascii(bytes, 0, 7) === 'mdipack';
  }

  /* ---------- PAC parsing ---------- */
  function readSections(pac) {
    const sections = [];
    let pos = 0;
    while (pos + 132 <= pac.length && util.ascii(pac, pos, 4) === 'PAC ') {
      const sectionSize = u32(pac, pos + 4);
      if (!sectionSize || pos + sectionSize > pac.length) break;
      let name = '';
      for (let i = 0; i < 64; i++) {
        const c = pac[pos + 68 + i];
        if (!c) break;
        name += String.fromCharCode(c);
      }
      sections.push({ name: name, data: pac.subarray(pos + 132, pos + sectionSize), size: sectionSize });
      pos += sectionSize;
    }
    return sections;
  }

  function decodeBin(section, xmlInfo) {
    const data = section.data;
    if (!data || data.length < 8) return null;
    const maybeCount = u32(data, 0);
    // tiled bin: u32 tileCount, u32 unknown(128), then per tile
    //   [u32 col][u32 row][u32 0][u32 compLen] + zlib(tileSize*tileSize*4), 4-byte aligned
    if (maybeCount > 0 && maybeCount <= 200000) {
      const tiles = [];
      let p = 8;
      let ok = true;
      let tileSize = 0;
      for (let i = 0; i < maybeCount; i++) {
        if (p + 16 > data.length) { ok = false; break; }
        const col = u32(data, p);
        const row = u32(data, p + 4);
        const compLen = u32(data, p + 12);
        if (!compLen || p + 16 + compLen > data.length) { ok = false; break; }
        let raw;
        try { raw = zlib.inflate(data.subarray(p + 16, p + 16 + compLen)); } catch (e) { ok = false; break; }
        if (raw.length % 4 !== 0) { ok = false; break; }
        const px = Math.round(Math.sqrt(raw.length / 4));
        if (px * px * 4 !== raw.length) { ok = false; break; }
        if (!tileSize) tileSize = px;
        if (px !== tileSize) { ok = false; break; }
        tiles.push({ col: col, row: row, raw: raw });
        p += 16 + compLen;
        p = (p + 3) & ~3;
      }
      if (ok && tiles.length === maybeCount && tileSize) {
        let width = xmlInfo && xmlInfo.width ? xmlInfo.width : 0;
        let height = xmlInfo && xmlInfo.height ? xmlInfo.height : 0;
        for (const t of tiles) {
          const needW = (t.col + 1) * tileSize, needH = (t.row + 1) * tileSize;
          if (needW > width) width = needW;
          if (needH > height) height = needH;
        }
        width = Math.ceil(width / tileSize) * tileSize;
        height = Math.ceil(height / tileSize) * tileSize;
        const rgba = new Uint8Array(width * height * 4);
        for (const t of tiles) {
          for (let y = 0; y < tileSize; y++) {
            const dy = t.row * tileSize + y;
            if (dy >= height) break;
            const srcRow = y * tileSize * 4;
            const dstRow = (dy * width + t.col * tileSize) * 4;
            rgba.set(t.raw.subarray(srcRow, srcRow + tileSize * 4), dstRow);
          }
        }
        return { w: width, h: height, rgba: rgba, tiled: true };
      }
    }
    // plain bin: zlib of a full RGBA image
    try {
      const raw = zlib.inflate(data);
      const info = xmlInfo || {};
      let w = info.width || 0, h = info.height || 0;
      if (!w || !h) {
        w = Math.round(Math.sqrt(raw.length / 4));
        h = w;
      }
      if (raw.length !== w * h * 4) {
        // try square fallback
        const side = Math.round(Math.sqrt(raw.length / 4));
        if (side * side * 4 !== raw.length) return null;
        w = side; h = side;
      }
      return { w: w, h: h, rgba: new Uint8Array(raw), tiled: false };
    } catch (e) {
      return null;
    }
  }

  /* crop fully transparent margins so a stamp document becomes a tight brush tip */
  function cropAlpha(img) {
    let minX = img.w, minY = img.h, maxX = -1, maxY = -1;
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        if (img.rgba[(y * img.w + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return img;
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const src = ((minY + y) * img.w + minX) * 4;
      rgba.set(img.rgba.subarray(src, src + w * 4), y * w * 4);
    }
    return { w: w, h: h, rgba: rgba, tiled: img.tiled };
  }

  function parseXml(xml) {
    const info = { width: 0, height: 0, layers: [], thumb: null };
    const m = /<Mdiapp\b([^>]*)>/.exec(xml);
    if (m) {
      const w = /width="(\d+)"/.exec(m[1]);
      const h = /height="(\d+)"/.exec(m[1]);
      if (w) info.width = parseInt(w[1], 10);
      if (h) info.height = parseInt(h[1], 10);
    }
    const th = /<Thumb\b([^>]*)\/?>/.exec(xml);
    if (th) {
      const bin = /bin="([^"]*)"/.exec(th[1]);
      if (bin) info.thumb = bin[1];
    }
    const layerRe = /<Layer\b([^>]*)\/?>/g;
    let lm;
    while ((lm = layerRe.exec(xml))) {
      const attrs = lm[1];
      const name = /name="([^"]*)"/.exec(attrs);
      const bin = /bin="([^"]*)"/.exec(attrs);
      const binType = /binType="([^"]*)"/.exec(attrs);
      const width = /width="(\d+)"/.exec(attrs);
      const height = /height="(\d+)"/.exec(attrs);
      info.layers.push({
        name: name ? name[1] : '',
        bin: bin ? bin[1] : '',
        binType: binType ? parseInt(binType[1], 10) : 1,
        width: width ? parseInt(width[1], 10) : info.width,
        height: height ? parseInt(height[1], 10) : info.height
      });
    }
    return info;
  }

  function toTip(img) {
    if (!img) return null;
    const rgba = png.toMaskRgba(img.rgba);
    return { w: img.w, h: img.h, rgb: img.rgba, rgba: rgba };
  }

  /* ---------- read ---------- */
  function parseMdp(bytes, fileName) {
    if (!isMdp(bytes)) throw new Error('不是 MediBang .mdp 材质文件');
    const xmlLen = u32(bytes, 12);
    const dataLen = u32(bytes, 16);
    const xml = util.utf8Decode(bytes.subarray(20, 20 + xmlLen));
    const pac = bytes.subarray(20 + xmlLen, 20 + xmlLen + dataLen);
    const info = parseXml(xml);
    const sections = readSections(pac);
    const warnings = [];
    const byName = {};
    for (const s of sections) byName[s.name] = s;
    // pick the largest layer bin as the brush stamp
    let stamp = null;
    const candidates = info.layers.filter(function (l) { return l.bin; });
    candidates.sort(function (a, b) { return (b.width * b.height) - (a.width * a.height); });
    for (const layer of candidates) {
      const sec = byName[layer.bin];
      if (!sec) continue;
      const img = decodeBin(sec, { width: layer.width || info.width, height: layer.height || info.height });
      if (img) { stamp = img; break; }
    }
    if (!stamp) {
      for (const s of sections) {
        if (s.name === info.thumb) continue;
        const img = decodeBin(s, info);
        if (img) { stamp = img; break; }
      }
    }
    if (!stamp && info.thumb && byName[info.thumb]) stamp = decodeBin(byName[info.thumb], info);
    if (!stamp) throw new Error('MediBang 文件里没有可读的图像数据');
    const tight = cropAlpha(stamp);
    if (!stamp.tiled) warnings.push('该 .mdp 为普通图像 bin（未分块）');
    const baseName = (fileName || 'medibang').replace(/\.[^.]+$/, '');
    return {
      brushes: [{
        name: baseName,
        tip: toTip(tight),
        sizePx: Math.max(tight.w, tight.h),
        spacingPct: 25,
        opacity: 1,
        hardness: 1,
        angle: 0,
        roundness: 100,
        pressure: false,
        pressureSize: false,
        minSizeRatio: 1,
        source: 'medibang'
      }],
      warnings: warnings
    };
  }

  /* ---------- write ---------- */
  function buildXml(width, height, layerBin, thumbBin) {
    return '<?xml version="1.0" encoding="UTF-8" ?>\n'
      + '<Mdiapp width="' + width + '" height="' + height + '" dpi="350" checkerBG="true" bgColorR="255" bgColorG="255" bgColorB="255">\n'
      + '    <CreateTime time="0" timeString="1970-01-01T00:00:00" timeHash="00000000000000000000000000000000" />\n'
      + '    <UpdateTime time="0" timeString="1970-01-01T00:00:00" timeHash="00000000000000000000000000000000" rev="1" />\n'
      + '    <Thumb width="256" height="256" bin="' + thumbBin + '" />\n'
      + '    <Snaps />\n    <Guides />\n'
      + '    <ICCProfiles enabled="false" cmykView="false" blackPoint="true" renderingIntent="perceptual" />\n'
      + '    <Animation enabled="false" showNextPrev="true" baseLayer="false" fps="24" />\n'
      + '    <Layers active="0">\n'
      + '        <Layer name="layer0" width="' + width + '" height="' + height + '" mode="normal" alpha="255" id="0" parentId="-1" binType="2" bin="' + layerBin + '" type="32bpp" />\n'
      + '    </Layers>\n'
      + '</Mdiapp>\n';
  }

  function pacSection(name, payload) {
    const header = new Uint8Array(132);
    header.set(util.utf8Encode('PAC '), 0);
    const nb = util.utf8Encode(name.slice(0, 63));
    header.set(nb, 68);
    const out = util.concat([header, payload]);
    // section size = 132 + payload; fill fields 4/8/12/16
    const size = out.length;
    out.set(le32(size), 4);
    out.set(le32(1), 8);
    out.set(le32(payload.length), 12);
    out.set(le32(payload.length), 16);
    return out;
  }

  function encodeTiled(rgba, w, h, tileSize) {
    const cols = Math.ceil(w / tileSize);
    const rows = Math.ceil(h / tileSize);
    const parts = [le32(cols * rows), le32(tileSize)];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const tile = new Uint8Array(tileSize * tileSize * 4);
        for (let y = 0; y < tileSize; y++) {
          const sy = row * tileSize + y;
          if (sy >= h) break;
          const srcRow = (sy * w + col * tileSize) * 4;
          const dstRow = y * tileSize * 4;
          for (let x = 0; x < tileSize; x++) {
            const sx = col * tileSize + x;
            if (sx >= w) break;
            const si = srcRow + x * 4;
            const di = dstRow + x * 4;
            tile[di] = rgba[si]; tile[di + 1] = rgba[si + 1]; tile[di + 2] = rgba[si + 2]; tile[di + 3] = rgba[si + 3];
          }
        }
        const comp = zlib.deflate(tile, 6);
        const head = new Uint8Array(16);
        head.set(le32(col), 0);
        head.set(le32(row), 4);
        head.set(le32(0), 8);
        head.set(le32(comp.length), 12);
        parts.push(head, comp);
      }
    }
    return util.concat(parts);
  }

  function encodePlain(rgba) {
    return zlib.deflate(rgba, 6);
  }

  /* one brush -> one .mdp material (stamp document) */
  function writeMdp(brush) {
    const limit = 500;
    let tip = brush.tip;
    if (!tip) throw new Error('该笔刷没有笔尖图像，无法写入 MDP');
    let w = tip.w, h = tip.h, rgba = tip.rgba;
    if (!rgba) {
      rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = tip.data[i];
      }
    }
    if (Math.max(w, h) > limit) {
      const sc = limit / Math.max(w, h);
      const nw = Math.max(1, Math.round(w * sc)), nh = Math.max(1, Math.round(h * sc));
      rgba = png.resize(rgba, w, h, nw, nh);
      w = nw; h = nh;
    }
    const tileSize = 128;
    const layerBin = 'layer0img';
    const thumbBin = 'thumb';
    // thumbnail: 256x256 resized copy
    const tw = 256, th = 256;
    const thumbRgba = png.resize(rgba, w, h, tw, th);
    const xml = buildXml(w, h, layerBin, thumbBin);
    const pac = util.concat([
      pacSection(thumbBin, encodePlain(thumbRgba)),
      pacSection(layerBin, encodeTiled(rgba, w, h, tileSize))
    ]);
    const xmlBytes = util.utf8Encode(xml);
    const head = util.concat([
      util.utf8Encode('mdipack\u0000'),
      le32(0),
      le32(xmlBytes.length),
      le32(pac.length)
    ]);
    return util.concat([head, xmlBytes, pac]);
  }

  const api = { isMdp, parseMdp, writeMdp };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { medibang: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
