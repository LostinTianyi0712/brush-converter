/* 画世界Pro .bru container + Brush protobuf reader/writer */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';
  const util = isNode ? require('./util.js') : root.BC.util;
  const png = isNode ? require('./png.js') : root.BC.png;

  const MAGIC = 'hsjbru';

  /* ---------- protobuf primitives ---------- */
  /* Varint for protobuf uint64. No BigInt / BigInt literals: must stay
     parseable by Chrome 61 (ES2017). Negative numbers are encoded as their
     two's-complement 64-bit value (always 10 bytes), matching protobuf. */
  function encVarint(v) {
    if (v >= 0 && v <= Number.MAX_SAFE_INTEGER) {
      const out = [];
      while (v >= 128) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
      out.push(v);
      return out;
    }
    // unsigned 64-bit halves
    let lo, hi;
    if (v >= 0) {
      lo = v % 4294967296;
      hi = Math.floor(v / 4294967296);
    } else {
      const neg = -v; // v >= -Number.MAX_SAFE_INTEGER
      const negLo = neg % 4294967296;
      const negHi = Math.floor(neg / 4294967296);
      lo = negLo === 0 ? 0 : 4294967296 - negLo;
      hi = (4294967296 - negHi - (negLo === 0 ? 0 : 1)) % 4294967296;
    }
    const out = [];
    for (;;) {
      const more = hi !== 0 || lo > 0x7f;
      out.push((lo & 0x7f) | (more ? 0x80 : 0));
      lo = ((lo >>> 7) | ((hi & 0x7f) << 25)) >>> 0;
      hi = hi >>> 7;
      if (!more) break;
    }
    return out;
  }
  // 画世界Pro 3.0 双笔刷引用消息模板（取自真实双笔刷 BRU 的 f121；只替换前两个 UUID）
  const DUAL_LINK_TEMPLATE_B64 = 'CiRlMjliODQwOS1iNTE0LTRjODgtYTY0Ny05NDVkNDg0NGI1MzkSJGU1MjJjYTczLWE0NWItNDM1OC1hMmNlLTdlZGNjYTA2YzUxYRoG5bmy5p+TIglpY29ucy95emIoATIFcHQxMzI6BXBzMTE2RR6FB0JNAACwQV0AAIA/ZQAA+kNtAACAP3X1KNw+gAGAgID4//////8BjQEK16M9mAEBrQEAALRCtQEAAIA/vQEAAIA/xQEAAAA/zQEAAIA/1QG4HgU+4AEB6AEB+AEBiAL3//////////8BmALp//////////8BoAIBqAIfyAIB0gIAiAMBlQPMzEw+qAMVwAMByAMB1QMAAMA/2AMCiAQB0AQB3QQAAABB5QQBAABB7QQAAIA/9QQAAIA/+AQBjQUAAIA/kAWs4Lj4//////8BmAUBoAUN0AUBiAYBoAYBrQYAAIA/mAcCwgcWOWU0dXJaWkhTNmFsUlpKVThtb1FHQdAHAd0HUrheP4AIAZ0IAACAP6UIAAC0Q70IAACAP8UImpkZP+gIAYUJAACAP5AJAfUJAAC0Qg==';
  function dualLinkTemplate() {
    const bin = isNode ? new Uint8Array(Buffer.from(DUAL_LINK_TEMPLATE_B64, 'base64')) : (function () { const s2 = atob(DUAL_LINK_TEMPLATE_B64); const out = new Uint8Array(s2.length); for (let i = 0; i < s2.length; i++) out[i] = s2.charCodeAt(i); return out; })();
    return bin;
  }

  function tag(field, wt) { return encVarint(field * 8 + wt); }
  function fVarint(field, v) { return tag(field, 0).concat(encVarint(v)); }
  function fF32(field, v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    return tag(field, 5).concat(Array.from(b));
  }
  function fBytes(field, bytes) {
    return tag(field, 2).concat(encVarint(bytes.length), Array.from(bytes));
  }
  function u8arr(arr) { return new Uint8Array(arr); }

  /* ---------- metadata builder (validated against 画世界Pro Android) ---------- */
  function buildMetadata(b) {
    const parts = [];
    const nameBytes = util.utf8Encode(b.name || 'brush');
    parts.push(u8arr(fBytes(1, util.utf8Encode(util.uid()))));   // ID
    parts.push(u8arr(fBytes(2, util.utf8Encode(b.pkgId || util.uid())))); // PKGID
    parts.push(u8arr(fBytes(3, nameBytes)));                    // NAME
    parts.push(u8arr(fBytes(4, util.utf8Encode('icons/yzb')))); // ICONPATH (cosmetic)
    parts.push(u8arr(fVarint(5, 1)));                           // ISVISIBLE
    parts.push(u8arr(fBytes(7, util.utf8Encode(b.texId))));     // MASKTEXPATH (image id)
    const size = Math.max(1, Math.min(5000, b.sizePx || 100));
    const minSize = Math.max(0.01, Math.min(1, b.minSizeRatio === undefined ? 1 : b.minSizeRatio));
    const opacity = Math.max(0.01, Math.min(1, b.opacity === undefined ? 1 : b.opacity));
    const minOp = Math.max(0.01, Math.min(1, b.minOpacityRatio === undefined ? 1 : b.minOpacityRatio));
    parts.push(u8arr(fF32(8, size)));                           // WIDTH
    parts.push(u8arr(fF32(9, size * minSize)));                 // SMALLWIDTH (零压感宽度)
    parts.push(u8arr(fF32(50, minSize)));                       // MINWIDTHPERCENT（最小直径，App 用这个字段）
    parts.push(u8arr(fF32(11, 1)));                             // MINWIDTH
    parts.push(u8arr(fF32(12, Math.max(500, size))));           // MAXWIDTH
    parts.push(u8arr(fF32(13, opacity)));                       // ALPHA
    parts.push(u8arr(fF32(14, opacity * minOp)));               // SMALLALPHA
    parts.push(u8arr(fVarint(16, -1)));                         // COLOR (white)
    const spacing = Math.max(0.01, Math.min(10, (b.spacingPct || 10) / 100));
    parts.push(u8arr(fF32(17, spacing)));                       // SPACING
    parts.push(u8arr(fVarint(19, 1)));                          // ROTFLOWFINGER
    const roundness = Math.max(0.01, Math.min(1, (b.roundness === undefined ? 100 : b.roundness) / 100));
    parts.push(u8arr(fF32(22, roundness)));                     // ROUNDNESS
    const hardness = Math.max(0, Math.min(1, b.hardness === undefined ? 1 : b.hardness));
    parts.push(u8arr(fF32(23, hardness)));                      // HARDNESS
    const texScale = Math.max(0.01, Math.min(20, b.textureScale === undefined ? 1 : b.textureScale));
    parts.push(u8arr(fF32(24, texScale)));                      // TEXSCALE
    const flow = Math.max(0.01, Math.min(1, b.flowPct === undefined ? 1 : b.flowPct));
    parts.push(u8arr(fF32(25, flow)));                          // BRUSHFLOW
    const minFlow = Math.max(0.01, Math.min(1, b.minFlowRatio === undefined ? Math.min(1, flow * 0.13 + 0.01) : b.minFlowRatio));
    parts.push(u8arr(fF32(26, flow * minFlow)));                // SMALLBRUSHFLOW
    parts.push(u8arr(fVarint(31, 1)));                          // USESHAPE
    if (b.hasTexture) parts.push(u8arr(fVarint(28, 1)));        // TEXTURE ON
    parts.push(u8arr(fF32(35, Math.max(0, Math.min(100, b.textureBrightness === undefined ? 51 : b.textureBrightness))))); // TEXBRIGHTNESS
    parts.push(u8arr(fVarint(33, Math.max(0, Math.min(200, Math.round(b.textureContrast === undefined ? 100 : b.textureContrast)))))); // CONTRAST
    if (b.textureDepth) parts.push(u8arr(fF32(123, Math.max(0, Math.min(1, b.textureDepth))))); // TEXTUREDEPTH
    if (b.pressure || b.pressureSize) parts.push(u8arr(fVarint(36, 1))); // SUPPORTPRESSURE
    if (b.pressureOpacity) parts.push(u8arr(fVarint(47, 1)));   // TRANSFER
    if (b.sizeJitterPct) parts.push(u8arr(fF32(10, Math.min(1, b.sizeJitterPct / 100)))); // SIZE JITTER
    if (b.spacingJitterPct) parts.push(u8arr(fF32(18, Math.min(10, b.spacingJitterPct / 100)))); // SPACING JITTER
    if (b.flowJitterPct) parts.push(u8arr(fF32(27, Math.min(1, b.flowJitterPct / 100)))); // FLOW JITTER
    if (b.countJitterPct) parts.push(u8arr(fF32(60, Math.min(1, b.countJitterPct / 100)))); // COUNT JITTER
    if (b.angle) parts.push(u8arr(fF32(20, b.angle)));          // ANGLE
    if (b.angleJitterDeg) parts.push(u8arr(fF32(21, b.angleJitterDeg))); // ANGLE JITTER
    if (b.scatterOn) {
      parts.push(u8arr(fVarint(56, 1)));                        // SCATTER ON
      if (b.scatterBothAxes) parts.push(u8arr(fVarint(57, 1))); // SCATTER BOTH AXES
      parts.push(u8arr(fF32(58, Math.max(0, Math.min(10, (b.scatterPct || 0) / 100))))); // SCATTER STRENGTH
      if ((b.scatterCount || 1) > 1) parts.push(u8arr(fVarint(59, Math.round(b.scatterCount)))); // COUNT
    }
    parts.push(u8arr(fVarint(37, 31)));                         // VER
    parts.push(u8arr(fBytes(42, new Uint8Array(0))));           // RGBTOALPHA
    parts.push(u8arr(fVarint(49, 1)));                          // PRESSUSEPERCENT
    parts.push(u8arr(fF32(51, Math.min(1, flow * minFlow))));   // SMALLBRUSHFLOWPERCENT
    parts.push(u8arr(fVarint(65, 1)));                          // ALLBRUSHRECT
    if (b.taperOn) {
      parts.push(u8arr(fVarint(74, 1)));
      parts.push(u8arr(fF32(77, Math.max(0, Math.min(1, b.taperSize === undefined ? 1 : b.taperSize)))));
      parts.push(u8arr(fF32(78, Math.max(0, Math.min(1, b.taperOpacity === undefined ? 1 : b.taperOpacity)))));
    }
    if (b.wetEdgesOn) {
      parts.push(u8arr(fVarint(100, 1)));
      parts.push(u8arr(fF32(101, Math.max(0, Math.min(1, 1 - (b.wetEdgesAmount === undefined ? 0.4 : b.wetEdgesAmount))))));
      parts.push(u8arr(fF32(129, Math.max(0, Math.min(1, 1 - (b.wetEdgesDepth === undefined ? 0.4 : b.wetEdgesDepth))))));
    }
    if (b.smudgeOn) {
      parts.push(u8arr(fVarint(103, 1)));
      parts.push(u8arr(fF32(104, Math.max(0, Math.min(1, 1 - (b.smudgeAmount === undefined ? 0.3 : b.smudgeAmount))))));
    }
    if (b.colorDynamicsOn) {
      parts.push(u8arr(fVarint(61, 1)));
      if (b.colorJitterHue) parts.push(u8arr(fF32(62, b.colorJitterHue)));
      if (b.colorJitterSat) parts.push(u8arr(fF32(63, b.colorJitterSat)));
      if (b.colorJitterVal) parts.push(u8arr(fF32(64, b.colorJitterVal)));
    }
    parts.push(u8arr(fVarint(79, 1)));                          // TAPEREFFECT
    parts.push(u8arr(fF32(80, b.smoothingStrength === undefined ? 0.2 : Math.max(0, Math.min(1, b.smoothingStrength))))); // SMOOTHSTRENGTH
    if (b.bruUuid || b.bruDualRefUuid) {
      const uuidBytes = util.utf8Encode(b.bruUuid || ('bc-' + Date.now().toString(16) + '-0000-0000-0000-000000000000'));
      parts.push(u8arr(fBytes(120, uuidBytes)));
      if (b.bruDualRefUuid) {
        const u1 = uuidBytes, u2 = util.utf8Encode(b.bruDualRefUuid);
        const tpl = (b.bruLinkTemplate && b.bruLinkTemplate.length > 97) ? b.bruLinkTemplate : dualLinkTemplate();
        const subName = util.utf8Encode(String(b.dualSubName || '第二支笔刷'));
        const iconPath = util.utf8Encode('icons/yzb');
        const msgParts = [];
        msgParts.push(0x0a); msgParts.push(u1.length); msgParts.push.apply(msgParts, Array.from(u1));
        msgParts.push(0x12); msgParts.push(u2.length); msgParts.push.apply(msgParts, Array.from(u2));
        msgParts.push(0x1a); msgParts.push(subName.length); msgParts.push.apply(msgParts, Array.from(subName));
        msgParts.push(0x22); msgParts.push(iconPath.length); msgParts.push.apply(msgParts, Array.from(iconPath));
        msgParts.push(0x28, 1);
        const msg = new Uint8Array(msgParts.concat(Array.from(tpl.subarray(97))));
        parts.push(u8arr(fBytes(121, msg)));
        // 真实双笔刷文件里还有 f87 / f158，一并写入（经验值，来自样本）
        parts.push(u8arr(fVarint(87, 9629115)));
        parts.push(u8arr(fF32(158, 90)));
      }
    }
    if (b.hollowPct !== undefined && b.hollowPct > 0) parts.push(u8arr(fF32(44, Math.max(0, Math.min(0.5, b.hollowPct / 100))))); // 中空度
    if (b.antialiasLevel) parts.push(u8arr(fVarint(96, Math.max(1, Math.min(3, Math.round(b.antialiasLevel))))));
    if (b.borderOn) {
      parts.push(u8arr(fVarint(92, 1)));
      if (b.borderBlend) parts.push(u8arr(fVarint(95, Math.round(b.borderBlend))));
      if (b.borderBrightness !== undefined) parts.push(u8arr(fF32(93, Math.max(0, Math.min(1, b.borderBrightness / 100)))));
      if (b.borderStrength !== undefined) parts.push(u8arr(fF32(94, Math.max(0, Math.min(1, b.borderStrength / 100)))));
    }
    if (b.speedPressure) parts.push(u8arr(fVarint(43, 1)));
    parts.push(u8arr(fF32(81, 1)));                             // HOLLOWALPHA
    parts.push(u8arr(fVarint(82, -1)));                         // HOLLOWCOLOR
    parts.push(u8arr(fVarint(83, 1)));                          // HOLALPIND
    parts.push(u8arr(fVarint(90, 1)));                          // NEWSPACECALTYPE
    parts.push(u8arr(fF32(93, 1)));                             // BORDERWIDTH
    parts.push(u8arr(fF32(94, 1)));                             // BORDERSTRENGTH
    parts.push(u8arr(fVarint(95, 4)));                          // BORDERBLENDMODE
    parts.push(u8arr(fVarint(97, Math.max(1, Math.round(b.renderCount || 1))))); // RENDERCOUNT
    parts.push(u8arr(fVarint(115, 1)));                         // SHAPEROTTYPE
    parts.push(u8arr(fF32(135, 1)));                            // BRUWMAXSCALE
    parts.push(u8arr(fF32(136, 0.06776)));                      // BRUWSCALE
    return util.concat(parts.map(u8arr));
  }

  const CONTAINER_HEAD = 22;
  const RECORD_LEN = 128;
  const BODY_START = CONTAINER_HEAD + RECORD_LEN; // 150

  /* Build a single-brush .bru file */
  function writeBrush(brush, opts) {
    opts = opts || {};
    const img = brush.png;
    if (!img || !img.length) throw new Error('缺少笔尖图像数据');
    const meta = buildMetadata(brush);
    const total = BODY_START + meta.length + img.length;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    out.set(util.utf8Encode(MAGIC), 0);
    dv.setUint32(6, 8, false);            // container version 8
    dv.setUint32(10, total, false);       // total size
    dv.setUint32(14, 1, false);           // brush count
    dv.setUint32(18, 1, false);           // flag
    const rec = CONTAINER_HEAD;
    dv.setUint32(rec + 0x56, meta.length, false);            // meta length
    dv.setUint32(rec + 0x5e, img.length, false);             // image length
    dv.setUint32(rec + 0x66, BODY_START + meta.length + img.length, false); // end
    out.set(meta, BODY_START);
    out.set(img, BODY_START + meta.length);
    return out;
  }

  /* Build a multi-brush .bru pack (container v7 layout used by 画世界Pro):
     header + 128-byte record (brush 1) + for every other brush a 50-byte index block,
     its metadata and its tip image. This keeps a whole .abr / .brushset together. */
  function writePack(brushes, opts) {
    opts = opts || {};
    if (!brushes || !brushes.length) throw new Error('没有可打包的笔刷');
    if (brushes.length > 3000) throw new Error('单个 .bru 笔刷数量过多');
    const items = brushes.map(function (b) {
      const pngBytes = b.png;
      if (!pngBytes || !pngBytes.length) throw new Error('缺少笔尖图像数据: ' + (b.name || ''));
      // 还原优先：源就是 .bru 时原样复用参数字节（只改笔尖图片及其引用 id）
      let meta = null;
      if (opts.fidelity !== false && b._rawMeta && b._rawMeta.length && opts.keepRawMeta !== false) {
        const raw = new Uint8Array(b._rawMeta);
        // 若笔尖图片被重新编码，md5 变了：把元数据里旧的 texId 文本替换成新的（长度相同）
        const oldId = (b.oldTexId || '').toUpperCase();
        const newId = (b.texId || util.md5(pngBytes)).toUpperCase();
        if (oldId && newId && oldId !== newId) {
          const oldBytes = util.utf8Encode(oldId), newBytes = util.utf8Encode(newId);
          if (oldBytes.length === newBytes.length) {
            for (let i = 0; i + oldBytes.length <= raw.length; i++) {
              let same = true;
              for (let k = 0; k < oldBytes.length; k++) if (raw[i + k] !== oldBytes[k]) { same = false; break; }
              if (same) { raw.set(newBytes, i); break; }
            }
          }
        }
        meta = raw;
      }
      if (!meta) {
        meta = buildMetadata(Object.assign({}, b, {
          pkgId: b.pkgId || opts.pkgId,
          texId: b.texId || util.md5(pngBytes).toUpperCase()
        }));
      }
      return { meta, img: pngBytes };
    });
    let total = BODY_START;
    for (let i = 0; i < items.length; i++) {
      total += items[i].meta.length + items[i].img.length;
      if (i > 0) total += 50;
    }
    if (total > 0xffffffff) throw new Error('打包后文件超过 4GB');
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    out.set(util.utf8Encode(MAGIC), 0);
    dv.setUint32(6, 7, false);          // container version 7 (multi-brush layout)
    dv.setUint32(10, total, false);     // total size
    dv.setUint32(14, items.length, false);
    dv.setUint32(18, 0, false);
    let pos = BODY_START;
    // brush 1: describe it in the 128-byte record
    dv.setUint32(CONTAINER_HEAD + 0x56, items[0].meta.length, false);
    dv.setUint32(CONTAINER_HEAD + 0x5e, items[0].img.length, false);
    dv.setUint32(CONTAINER_HEAD + 0x66, pos + items[0].meta.length + items[0].img.length, false);
    out.set(items[0].meta, pos); pos += items[0].meta.length;
    out.set(items[0].img, pos); pos += items[0].img.length;
    for (let i = 1; i < items.length; i++) {
      const blockPos = pos;
      const metaLen = items[i].meta.length, imgLen = items[i].img.length;
      const endOff = blockPos + 50 + metaLen + imgLen;
      dv.setUint32(blockPos + 0x08, metaLen, false);
      dv.setUint32(blockPos + 0x10, imgLen, false);
      dv.setUint32(blockPos + 0x14, 0, false);
      dv.setUint32(blockPos + 0x18, endOff, false);
      pos = blockPos + 50;
      out.set(items[i].meta, pos); pos += metaLen;
      out.set(items[i].img, pos); pos += imgLen;
    }
    if (pos !== total) throw new Error('内部长度不一致 (' + pos + '/' + total + ')');
    return out;
  }

  /* ---------- reader ---------- */
  function isBru(bytes) {
    return bytes.length > 8 && util.ascii(bytes, 0, 6) === MAGIC;
  }

  const SKIP_FIELDS = new Set([7, 46, 120, 121, 147, 148]);

  function readFields(bytes, start, end) {
    const fields = [];
    let p = start;
    while (p < end) {
      let tagVal = 0, shift = 0, ok = false;
      let q = p;
      while (q < end) {
        const c = bytes[q++];
        tagVal += (c & 0x7f) * Math.pow(2, shift);
        if (!(c & 0x80)) { ok = true; break; }
        shift += 7;
        if (shift > 56) break;
      }
      if (!ok) break;
      const f = Math.floor(tagVal / 8), w = tagVal % 8;
      if (f === 0 || f > 100000) break;
      p = q;
      if (w === 0) {
        let v = 0; shift = 0;
        while (p < end) {
          const c = bytes[p++];
          v += (c & 0x7f) * Math.pow(2, shift);
          if (!(c & 0x80)) break;
          shift += 7;
          if (shift > 63) return fields;
        }
        fields.push({ f, w, v });
      } else if (w === 5) {
        if (p + 4 > end) break;
        fields.push({ f, w, v: new DataView(bytes.buffer, bytes.byteOffset + p, 4).getFloat32(0, true) });
        p += 4;
      } else if (w === 1) {
        if (p + 8 > end) break;
        fields.push({ f, w, v: bytes.subarray(p, p + 8) });
        p += 8;
      } else if (w === 2) {
        let l = 0; shift = 0;
        while (p < end) {
          const c = bytes[p++];
          l += (c & 0x7f) * Math.pow(2, shift);
          if (!(c & 0x80)) break;
          shift += 7;
        }
        if (p + l > end) break;
        fields.push({ f, w, v: bytes.subarray(p, p + l) });
        p += l;
      } else break;
    }
    return fields;
  }

  function fieldsToObj(fields) {
    const o = {};
    for (const it of fields) o[it.f] = it.v;
    return o;
  }

  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function findPng(bytes, from, limit) {
    const end = Math.min(bytes.length - 8, from + (limit || 20000000));
    for (let i = from; i < end; i++) {
      if (bytes[i] !== 0x89) continue;
      let ok = true;
      for (let k = 0; k < 8; k++) if (bytes[i + k] !== PNG_SIG[k]) { ok = false; break; }
      if (ok) return i;
    }
    return -1;
  }

  function looksLikeMetaStart(bytes, i) {
    if (bytes[i] !== 0x0a) return false;
    const len = bytes[i + 1];
    if (len < 8 || len > 60) return false;
    for (let k = 0; k < len; k++) {
      const c = bytes[i + 2 + k];
      if (c < 32 || c > 126) return false;
    }
    const nt = i + 2 + len;
    return bytes[nt] === 0x12;
  }

  /* Block-driven multi-brush reader. Fallbacks keep older/odd containers readable. */
  function parseBru(bytes) {
    if (!isBru(bytes)) throw new Error('不是画世界Pro .bru 文件');
    const version = util.u32(bytes, 6);
    const totalSize = util.u32(bytes, 10);
    const count = util.u32(bytes, 14);
    const rec = CONTAINER_HEAD;
    const firstMetaLen = util.u32(bytes, rec + 0x56);
    const firstImgLen = util.u32(bytes, rec + 0x5e);
    const firstEnd = util.u32(bytes, rec + 0x66);
    const brushes = [];
    const warnings = [];

    function pushBrush(metaStart, metaEnd, pngStart, pngEnd) {
      const rawMeta = bytes.subarray(metaStart, metaEnd);
      const fields = readFields(bytes, metaStart, metaEnd);
      const o = fieldsToObj(fields);
      // 字段语义依据实机标定：D:\dsh项目\笔刷ru_标定\字段映射.md
      const num = (v, dflt) => (typeof v === 'number' && isFinite(v) ? v : dflt);
      const name = o[3] ? util.utf8Decode(o[3]) : '';
      const size = num(o[8], 100);
      const minSizePct = typeof o[50] === 'number' ? o[50] : null;   // 最小直径（f50）
      const spacing = num(o[17], 0.1);                                // 间距（f17）
      const alpha = num(o[13], 1);                                    // 不透明度（f13）
      const flowPct = num(o[25], 1);                                  // 流量（f25）
      const smallAlpha = num(o[14], alpha);                           // 最小不透明度（f14）
      const minFlowPct = num(o[51], flowPct);                         // 最小流量（f51）
      const sizeJitterPct = num(o[10], 0) * 100;                      // 大小随机（f10）
      const spacingJitterPct = num(o[18], 0) * 100;                   // 间距随机（f18）
      const flowJitterPct = num(o[27], 0) * 100;                      // 流量随机（f27）
      const countJitterPct = num(o[60], 0) * 100;                     // 数量随机（f60）
      const angleDeg = num(o[20], 0);                                 // 旋转（f20，度）
      const angleJitterDeg = num(o[21], 0);                           // 旋转随机（f21，度）
      const roundnessPct = num(o[22], 1) * 100;                       // 圆度（f22）
      const hardnessPct = num(o[23], 1) * 100;                        // 硬度（f23）
      const scatterOn = !!o[56];                                      // 散布开关（f56）
      const scatterPct = num(o[58], 0) * 100;                         // 散布强度（f58）
      const scatterBothAxes = !!o[57];                                // 散布两轴（f57）
      const scatterCount = Math.max(1, Math.round(num(o[59], 1)));    // 数量（f59）
      const textureOn = !!o[28];                                      // 纹理开关（f28）
      const texScale = num(o[24], 1);                                 // 纹理缩放（f24）
      const texBrightness = num(o[35], 51);                           // 纹理亮度（f35）
      const texContrast = num(o[33], 100);                            // 纹理对比度（f33）
      const texDepth = num(o[123], 0);                                // 纹理深度（f123）
      const wetOn = !!o[100];                                         // 湿边开关（f100）
      const wetStrengthRaw = num(o[101], 1);                          // 湿边强度（反向：1-x）
      const wetDepthRaw = num(o[129], 1);                             // 湿边深度（反向）
      const mixOn = !!o[103];                                         // 混色开关（f103）
      const mixStrengthRaw = num(o[104], 1);                          // 混色强度（反向）
      const taperOn = !!o[74];                                        // 锥度开关（f74）
      const taperSize = num(o[77], 1);                                // 锥度尺寸强度（f77）
      const taperOpacity = num(o[78], 1);                             // 锥度不透明度（f78）
      const colorDynOn = !!o[61];                                     // 颜色动态（f61）
      const colorHue = num(o[62], 0), colorSat = num(o[63], 0), colorVal = num(o[64], 0);
      const smoothingStrength = num(o[80], 0.2);                      // 平滑强度（f80）
      // 画世界Pro 3.0 双笔刷：f120=本笔刷 uuid，f121=关联消息（field1 本笔刷，field2 第二支笔刷）
      let bruUuid = null, bruDualRef = null, bruLinkInfo = null, bruLinkTemplate = null;
      try {
        if (o[120] instanceof Uint8Array) bruUuid = util.utf8Decode(o[120]).replace(/ +$/, '');
        if (o[121] instanceof Uint8Array) {
          let q = 0; const d = o[121]; const msg = {};
          while (q < d.length) {
            const tag = d[q++];
            let len = 0, sh = 0;
            while (q < d.length) { const c = d[q++]; len += (c & 0x7f) * Math.pow(2, sh); if (!(c & 0x80)) break; sh += 7; }
            if (q + len > d.length) break;
            msg[tag] = d.subarray(q, q + len); q += len;
          }
          const u1 = msg[0x0a] ? util.utf8Decode(msg[0x0a]) : null;
          const u2 = msg[0x12] ? util.utf8Decode(msg[0x12]) : null;
          if (!bruUuid && u1) bruUuid = u1;
          if (u2 && u2 !== bruUuid) bruDualRef = u2;
          bruLinkInfo = { primary: u1, secondary: u2 };
          bruLinkTemplate = new Uint8Array(o[121]);
        }
      } catch (e) { /* ignore */ }
      const hollowPct = o[44] === undefined ? undefined : num(o[44], 0.5) * 100;                        // 中空度（f44）
      const antialiasLevel = num(o[96], 0);                           // 抗锯齿（f96）
      const borderOn = !!o[92];                                       // 混边开关（f92）
      const borderBlend = num(o[95], 0);                              // 混边混合（f95）
      const borderBrightness = num(o[93], 1) * 100;                   // 混边亮度（f93）
      const borderStrength = num(o[94], 1) * 100;                     // 混边强度（f94）
      const renderCount = Math.max(1, Math.round(num(o[97], 1)));     // 渲染数量（f97）
      const speedPressure = !!o[43];                                  // 速度模拟压感（f43）
      const pressureSize = !!o[36];                                   // 大小压力（f36）
      const transferOn = !!o[47];                                     // 传递（f47）
      let tip = null;
      if (pngStart >= 0 && pngEnd > pngStart) {
        try {
          const im = png.decode(bytes.subarray(pngStart, pngEnd));
          tip = { w: im.width, h: im.height, rgba: im.rgba };
        } catch (e) {
          warnings.push('第 ' + (brushes.length + 1) + ' 支笔刷图像解码失败（可能为 JPEG 纹理）');
        }
      }
      brushes.push({
        name: name || ('笔刷 ' + (brushes.length + 1)),
        tip,
        sizePx: size,
        spacingPct: spacing * 100,
        minSizeRatio: minSizePct !== null ? Math.max(0, Math.min(1, minSizePct)) : 1,
        opacity: alpha,
        flowPct: Math.max(0, Math.min(1, flowPct)),
        minOpacityRatio: alpha > 0 ? Math.max(0.01, Math.min(1, smallAlpha / alpha)) : 1,
        minFlowRatio: flowPct > 0 ? Math.max(0.01, Math.min(1, minFlowPct / flowPct)) : 1,
        pressure: pressureSize || transferOn,
        pressureSize: pressureSize,
        pressureOpacity: transferOn,
        sizeJitterPct: sizeJitterPct,
        spacingJitterPct: spacingJitterPct,
        flowJitterPct: flowJitterPct,
        countJitterPct: countJitterPct,
        angle: angleDeg,
        angleJitterDeg: angleJitterDeg,
        roundness: roundnessPct,
        hardness: hardnessPct / 100,
        smoothingStrength: smoothingStrength,
        bruUuid: bruUuid,
        bruDualRefUuid: bruDualRef,
        bruLinkInfo: bruLinkInfo,
        bruLinkTemplate: bruLinkTemplate,
        hollowPct: hollowPct,
        antialiasLevel: antialiasLevel,
        borderOn: borderOn,
        borderBlend: borderBlend,
        borderBrightness: borderBrightness,
        borderStrength: borderStrength,
        renderCount: renderCount,
        speedPressure: speedPressure,
        scatterOn: scatterOn,
        scatterPct: scatterPct,
        scatterBothAxes: scatterBothAxes,
        scatterCount: scatterCount,
        hasTexture: textureOn,
        textureScale: texScale,
        textureBrightness: texBrightness,
        textureContrast: texContrast,
        textureDepth: texDepth,
        grainStrength: texDepth > 0 ? Math.max(0.1, Math.min(0.8, texDepth)) : 0.35,
        wetEdgesOn: wetOn,
        wetEdgesAmount: wetOn ? Math.max(0, Math.min(1, 1 - wetStrengthRaw)) : 0,
        wetEdgesDepth: wetOn ? Math.max(0, Math.min(1, 1 - wetDepthRaw)) : 0,
        smudgeOn: mixOn,
        smudgeAmount: mixOn ? Math.max(0, Math.min(1, 1 - mixStrengthRaw)) : 0,
        taperOn: taperOn,
        taperSize: taperSize,
        taperOpacity: taperOpacity,
        colorDynamicsOn: colorDynOn,
        colorJitterHue: colorHue,
        colorJitterSat: colorSat,
        colorJitterVal: colorVal,
        _rawMeta: rawMeta,
        oldTexId: (function (v) {
          if (!v) return '';
          if (typeof v === 'string') return v;
          try { return util.utf8Decode(v); } catch (e) { return ''; }
        })(o[7]),
        source: 'bru',
        bruVersion: version
      });
    }

    function metaAt(i) {
      if (i + 2 >= bytes.length || bytes[i] !== 0x0a) return false;
      const len = bytes[i + 1];
      if (len < 8 || len > 80) return false;
      for (let k = 0; k < len; k++) {
        const c = bytes[i + 2 + k];
        if (c < 32 || c > 126) return false;
      }
      return bytes[i + 2 + len] === 0x12;
    }
    function findNextMeta(from, limit) {
      const stop = Math.min(bytes.length - 8, from + (limit || 4 * 1024 * 1024));
      for (let i = from; i < stop; i++) {
        if (bytes[i] === 0x0a && metaAt(i)) return i;
      }
      return -1;
    }

    // brush 1 described by the 128-byte record
    let pos = BODY_START + firstMetaLen + firstImgLen;
    if (firstMetaLen > 0 && BODY_START + firstMetaLen <= bytes.length) {
      pushBrush(BODY_START, BODY_START + firstMetaLen, BODY_START + firstMetaLen,
        Math.min(bytes.length, BODY_START + firstMetaLen + firstImgLen));
      if (firstEnd && firstEnd > pos && firstEnd <= bytes.length) pos = firstEnd;
    }

    // remaining brushes: 50-byte index block each
    let guard = 0;
    while (guard++ < 5000) {
      if (count > 0 && brushes.length >= count) break;
      if (pos + 50 >= bytes.length) break;
      let metaLen = util.u32(bytes, pos + 0x08);
      const img1Len = util.u32(bytes, pos + 0x10);
      const img2Len = util.u32(bytes, pos + 0x14);
      let endOff = util.u32(bytes, pos + 0x18);
      let metaStart = pos + 50;
      let ok = metaLen > 0 && metaLen < 0x10000 && metaAt(metaStart);
      if (!ok) {
        // container variant: locate next metadata by signature scan (block size may differ)
        const found = findNextMeta(pos + 1, 4096);
        if (found < 0) break;
        metaStart = found;
        const pngAt = findPng(bytes, metaStart, 4 * 1024 * 1024);
        const nextMeta = findNextMeta(metaStart + 40, 64 * 1024 * 1024);
        const metaEnd = pngAt > 0 && (nextMeta < 0 || pngAt < nextMeta) ? pngAt : (nextMeta > 0 ? nextMeta : bytes.length);
        pushBrush(metaStart, metaEnd, pngAt > 0 && metaEnd === pngAt ? pngAt : -1,
          nextMeta > 0 ? Math.max(pngAt, nextMeta - 50) : bytes.length);
        pos = nextMeta > 0 ? nextMeta - 50 : bytes.length;
        continue;
      }
      const expectEnd = metaStart + metaLen + img1Len + img2Len;
      if (endOff !== expectEnd) {
        // tolerate 64-bit/flag variants: prefer the block's end offset when it looks sane
        if (endOff > pos && endOff <= bytes.length && metaAt(endOff + 50) === false && expectEnd <= bytes.length) {
          endOff = expectEnd;
        } else if (endOff <= pos || endOff > bytes.length) {
          endOff = expectEnd;
        }
      }
      const pngStart = metaStart + metaLen;
      pushBrush(metaStart, pngStart, pngStart, Math.min(bytes.length, pngStart + img1Len));
      pos = endOff > pos ? endOff : Math.min(bytes.length, pngStart + img1Len + img2Len);
    }
    if (!brushes.length) throw new Error('.bru 中没有找到可用笔刷');
    return { version, totalSize, count: count || brushes.length, brushes, warnings };
  }

  const api = { isBru, writeBrush, writePack, parseBru, buildMetadata, MAGIC };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { bru: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
