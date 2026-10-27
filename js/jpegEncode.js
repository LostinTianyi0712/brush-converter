/* baseline JPEG 编码器（4:4:4，3 分量，标准 Huffman 表）
 * 由 jpeg-js 的 encoder（原作者 Adobe Systems Inc. / Andreas Ritter，BSD 许可）改写为
 * 无 Buffer / 无 DOM 的纯 Uint8Array 版本，供 Corel Painter .nib 笔尖使用。
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';

  function encodeRGBA(width, height, rgba, quality) {
    const q = quality === undefined ? 60 : Math.max(1, Math.min(100, quality));
    const ZigZag = [0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53, 10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63];

    const std_dc_luminance_nrcodes = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
    const std_dc_luminance_values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const std_ac_luminance_nrcodes = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
    const std_ac_luminance_values = [
      0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
      0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
      0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
      0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
      0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
      0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
      0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
      0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
      0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
      0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
      0xf9, 0xfa
    ];
    const std_dc_chrominance_nrcodes = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
    const std_dc_chrominance_values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const std_ac_chrominance_nrcodes = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
    const std_ac_chrominance_values = [
      0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
      0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
      0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
      0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
      0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
      0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
      0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
      0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
      0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
      0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
      0xf9, 0xfa
    ];

    const YTable = new Uint8Array(64), UVTable = new Uint8Array(64);
    const fdtblY = new Float32Array(64), fdtblUV = new Float32Array(64);
    let YDC_HT, UVDC_HT, YAC_HT, UVAC_HT;
    const bitcode = [], category = [];
    let byteout = [], bytenew = 0, bytepos = 7;

    (function initQuant(sf) {
      const YQT = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
      const UVQT = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
      for (let i = 0; i < 64; i++) {
        let t = Math.floor((YQT[i] * sf + 50) / 100);
        YTable[ZigZag[i]] = Math.max(1, Math.min(255, t));
      }
      for (let j = 0; j < 64; j++) {
        let u = Math.floor((UVQT[j] * sf + 50) / 100);
        UVTable[ZigZag[j]] = Math.max(1, Math.min(255, u));
      }
      const aasf = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379];
      let k = 0;
      for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
        fdtblY[k] = 1.0 / (YTable[ZigZag[k]] * aasf[row] * aasf[col] * 8.0);
        fdtblUV[k] = 1.0 / (UVTable[ZigZag[k]] * aasf[row] * aasf[col] * 8.0);
        k++;
      }
    })(q < 50 ? Math.floor(5000 / q) : Math.floor(200 - q * 2));

    (function initHuffman() {
      function mk(nrcodes, values) {
        const ht = [];
        let codevalue = 0, pos = 0;
        for (let k = 1; k <= 16; k++) {
          for (let j = 1; j <= nrcodes[k]; j++) { ht[values[pos]] = [codevalue, k]; pos++; codevalue++; }
          codevalue *= 2;
        }
        return ht;
      }
      YDC_HT = mk(std_dc_luminance_nrcodes, std_dc_luminance_values);
      UVDC_HT = mk(std_dc_chrominance_nrcodes, std_dc_chrominance_values);
      YAC_HT = mk(std_ac_luminance_nrcodes, std_ac_luminance_values);
      UVAC_HT = mk(std_ac_chrominance_nrcodes, std_ac_chrominance_values);
    })();

    (function initCategory() {
      let nrlower = 1, nrupper = 2;
      for (let cat = 1; cat <= 15; cat++) {
        for (let nr = nrlower; nr < nrupper; nr++) { category[32767 + nr] = cat; bitcode[32767 + nr] = [nr, cat]; }
        for (let nrneg = -(nrupper - 1); nrneg <= -nrlower; nrneg++) { category[32767 + nrneg] = cat; bitcode[32767 + nrneg] = [nrupper - 1 + nrneg, cat]; }
        nrlower <<= 1; nrupper <<= 1;
      }
    })();

    function writeByte(v) { byteout.push(v & 0xff); }
    function writeWord(v) { writeByte(v >> 8); writeByte(v); }
    function writeBits(bs) {
      let value = bs[0];
      let posval = bs[1] - 1;
      while (posval >= 0) {
        if (value & (1 << posval)) bytenew |= (1 << bytepos);
        posval--; bytepos--;
        if (bytepos < 0) {
          if (bytenew === 0xff) { writeByte(0xff); writeByte(0); }
          else writeByte(bytenew);
          bytepos = 7; bytenew = 0;
        }
      }
    }

    const RGB_YUV_TABLE = new Array(2048);
    for (let i = 0; i < 256; i++) {
      RGB_YUV_TABLE[i] = 19595 * i;
      RGB_YUV_TABLE[i + 256] = 38470 * i;
      RGB_YUV_TABLE[i + 512] = 7471 * i + 0x8000;
      RGB_YUV_TABLE[i + 768] = -11059 * i;
      RGB_YUV_TABLE[i + 1024] = -21709 * i;
      RGB_YUV_TABLE[i + 1280] = 32768 * i + 0x807fff;
      RGB_YUV_TABLE[i + 1536] = -27439 * i;
      RGB_YUV_TABLE[i + 1792] = -5329 * i;
    }

    const out = new Array(64);
    function fDCTQuant(data, fdtbl) {
      let d0, d1, d2, d3, d4, d5, d6, d7, i, dataOff;
      for (i = 0, dataOff = 0; i < 8; ++i) {
        d0 = data[dataOff]; d1 = data[dataOff + 1]; d2 = data[dataOff + 2]; d3 = data[dataOff + 3];
        d4 = data[dataOff + 4]; d5 = data[dataOff + 5]; d6 = data[dataOff + 6]; d7 = data[dataOff + 7];
        let tmp0 = d0 + d7, tmp7 = d0 - d7, tmp1 = d1 + d6, tmp6 = d1 - d6, tmp2 = d2 + d5, tmp5 = d2 - d5, tmp3 = d3 + d4, tmp4 = d3 - d4;
        let tmp10 = tmp0 + tmp3, tmp13 = tmp0 - tmp3, tmp11 = tmp1 + tmp2, tmp12 = tmp1 - tmp2;
        data[dataOff] = tmp10 + tmp11; data[dataOff + 4] = tmp10 - tmp11;
        let z1 = (tmp12 + tmp13) * 0.707106781;
        data[dataOff + 2] = tmp13 + z1; data[dataOff + 6] = tmp13 - z1;
        tmp10 = tmp4 + tmp5; tmp11 = tmp5 + tmp6; tmp12 = tmp6 + tmp7;
        let z5 = (tmp10 - tmp12) * 0.382683433;
        let z2 = 0.541196100 * tmp10 + z5, z4 = 1.306562965 * tmp12 + z5, z3 = tmp11 * 0.707106781;
        let z11 = tmp7 + z3, z13 = tmp7 - z3;
        data[dataOff + 5] = z13 + z2; data[dataOff + 3] = z13 - z2; data[dataOff + 1] = z11 + z4; data[dataOff + 7] = z11 - z4;
        dataOff += 8;
      }
      for (i = 0, dataOff = 0; i < 8; ++i) {
        d0 = data[dataOff]; d1 = data[dataOff + 8]; d2 = data[dataOff + 16]; d3 = data[dataOff + 24];
        d4 = data[dataOff + 32]; d5 = data[dataOff + 40]; d6 = data[dataOff + 48]; d7 = data[dataOff + 56];
        let tmp0 = d0 + d7, tmp7 = d0 - d7, tmp1 = d1 + d6, tmp6 = d1 - d6, tmp2 = d2 + d5, tmp5 = d2 - d5, tmp3 = d3 + d4, tmp4 = d3 - d4;
        let tmp10 = tmp0 + tmp3, tmp13 = tmp0 - tmp3, tmp11 = tmp1 + tmp2, tmp12 = tmp1 - tmp2;
        data[dataOff] = tmp10 + tmp11; data[dataOff + 32] = tmp10 - tmp11;
        let z1 = (tmp12 + tmp13) * 0.707106781;
        data[dataOff + 16] = tmp13 + z1; data[dataOff + 48] = tmp13 - z1;
        tmp10 = tmp4 + tmp5; tmp11 = tmp5 + tmp6; tmp12 = tmp6 + tmp7;
        let z5 = (tmp10 - tmp12) * 0.382683433;
        let z2 = 0.541196100 * tmp10 + z5, z4 = 1.306562965 * tmp12 + z5, z3 = tmp11 * 0.707106781;
        let z11 = tmp7 + z3, z13 = tmp7 - z3;
        data[dataOff + 40] = z13 + z2; data[dataOff + 24] = z13 - z2; data[dataOff + 8] = z11 + z4; data[dataOff + 56] = z11 - z4;
        dataOff++;
      }
      for (i = 0; i < 64; ++i) {
        const v = data[i] * fdtbl[i];
        out[i] = v > 0 ? ((v + 0.5) | 0) : ((v - 0.5) | 0);
      }
      return out;
    }

    function writeAPP0() { writeWord(0xffe0); writeWord(16); [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0].forEach(writeByte); writeWord(1); writeWord(1); writeByte(0); writeByte(0); }
    function writeSOF0(w, h) { writeWord(0xffc0); writeWord(17); writeByte(8); writeWord(h); writeWord(w); writeByte(3); writeByte(1); writeByte(0x11); writeByte(0); writeByte(2); writeByte(0x11); writeByte(1); writeByte(3); writeByte(0x11); writeByte(1); }
    function writeDQT() {
      writeWord(0xffdb); writeWord(132); writeByte(0);
      for (let i = 0; i < 64; i++) writeByte(YTable[i]);
      writeByte(1);
      for (let j = 0; j < 64; j++) writeByte(UVTable[j]);
    }
    function writeDHT() {
      writeWord(0xffc4); writeWord(0x01a2);
      writeByte(0);
      for (let i = 0; i < 16; i++) writeByte(std_dc_luminance_nrcodes[i + 1]);
      for (let j = 0; j <= 11; j++) writeByte(std_dc_luminance_values[j]);
      writeByte(0x10);
      for (let k = 0; k < 16; k++) writeByte(std_ac_luminance_nrcodes[k + 1]);
      for (let l = 0; l <= 161; l++) writeByte(std_ac_luminance_values[l]);
      writeByte(1);
      for (let m = 0; m < 16; m++) writeByte(std_dc_chrominance_nrcodes[m + 1]);
      for (let n = 0; n <= 11; n++) writeByte(std_dc_chrominance_values[n]);
      writeByte(0x11);
      for (let o = 0; o < 16; o++) writeByte(std_ac_chrominance_nrcodes[o + 1]);
      for (let p = 0; p <= 161; p++) writeByte(std_ac_chrominance_values[p]);
    }
    function writeSOS() {
      writeWord(0xffda); writeWord(12); writeByte(3);
      writeByte(1); writeByte(0); writeByte(2); writeByte(0x11); writeByte(3); writeByte(0x11);
      writeByte(0); writeByte(0x3f); writeByte(0);
    }

    function processDU(CDU, fdtbl, DC, HTDC, HTAC) {
      const EOB = HTAC[0x00], M16zeroes = HTAC[0xf0];
      const DU_DCT = fDCTQuant(CDU, fdtbl);
      const DU = new Array(64);
      for (let j = 0; j < 64; ++j) DU[ZigZag[j]] = DU_DCT[j];
      let diff = DU[0] - DC;
      DC = DU[0];
      if (diff === 0) writeBits(HTDC[0]);
      else {
        const pos = 32767 + diff;
        writeBits(HTDC[category[pos]]);
        writeBits(bitcode[pos]);
      }
      let end0pos = 63;
      for (; end0pos > 0 && DU[end0pos] === 0; end0pos--);
      if (end0pos === 0) { writeBits(EOB); return DC; }
      let i = 1;
      while (i <= end0pos) {
        const startpos = i;
        for (; DU[i] === 0 && i <= end0pos; ++i);
        let nrzeroes = i - startpos;
        if (nrzeroes >= 16) {
          const lng = nrzeroes >> 4;
          for (let nrmarker = 1; nrmarker <= lng; ++nrmarker) writeBits(M16zeroes);
          nrzeroes = nrzeroes & 0xf;
        }
        const pos = 32767 + DU[i];
        writeBits(HTAC[(nrzeroes << 4) + category[pos]]);
        writeBits(bitcode[pos]);
        i++;
      }
      if (end0pos !== 63) writeBits(EOB);
      return DC;
    }

    byteout = []; bytenew = 0; bytepos = 7;
    writeWord(0xffd8); writeAPP0(); writeDQT(); writeSOF0(width, height); writeDHT(); writeSOS();

    const YDU = new Array(64), UDU = new Array(64), VDU = new Array(64);
    let DCY = 0, DCU = 0, DCV = 0;
    const quadWidth = width * 4;
    let y = 0;
    while (y < height) {
      let x = 0;
      while (x < quadWidth) {
        const start = quadWidth * y + x;
        for (let pos = 0; pos < 64; pos++) {
          const row = pos >> 3, col = (pos & 7) * 4;
          let p = start + row * quadWidth + col;
          if (y + row >= height) p -= quadWidth * (y + 1 + row - height);
          if (x + col >= quadWidth) p -= (x + col - quadWidth + 4);
          const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
          YDU[pos] = ((RGB_YUV_TABLE[r] + RGB_YUV_TABLE[g + 256] + RGB_YUV_TABLE[b + 512]) >> 16) - 128;
          UDU[pos] = ((RGB_YUV_TABLE[r + 768] + RGB_YUV_TABLE[g + 1024] + RGB_YUV_TABLE[b + 1280]) >> 16) - 128;
          VDU[pos] = ((RGB_YUV_TABLE[r + 1280] + RGB_YUV_TABLE[g + 1536] + RGB_YUV_TABLE[b + 1792]) >> 16) - 128;
        }
        DCY = processDU(YDU, fdtblY, DCY, YDC_HT, YAC_HT);
        DCU = processDU(UDU, fdtblUV, DCU, UVDC_HT, UVAC_HT);
        DCV = processDU(VDU, fdtblUV, DCV, UVDC_HT, UVAC_HT);
        x += 32;
      }
      y += 8;
    }
    if (bytepos >= 0) {
      const fillbits = [];
      fillbits[1] = bytepos + 1;
      fillbits[0] = (1 << (bytepos + 1)) - 1;
      writeBits(fillbits);
    }
    writeWord(0xffd9);
    return new Uint8Array(byteout);
  }

  const api = { encode: encodeRGBA };
  if (typeof module !== 'undefined' && module.exports && typeof process !== 'undefined') module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { jpegEncode: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
