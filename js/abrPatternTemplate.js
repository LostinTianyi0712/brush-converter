/* PS ABR 纹理图案块模板（从 Photoshop 导出的“微粒”图案记录中提取的前缀）
   记录结构：u32 len + 前缀(272B) + 像素数据；像素数据 = 宽×高×3（RGB）
   模板尺寸 256×256，写入时只替换像素区，前缀原样复用，保证 PS 能解析。 */
(function (root) {
  'use strict';
  const prefixHex = '00030110000000010000000301000100000000035fae7c9200002463303266646466662d663035612d313137322d396130662d66376261643639646434623000000003000300cd00000000000000000000010000000100000000180000000100010017000000080000000000000000000001000000010000080092a9b69b8595a2929ba08c9b9b95a0adadada69992add0d7d0af958778879b8e787378686f81737187a0afa6a692736271879b998c787e81878e92998e7e8e9b9295929ba295787e8c92999b958c8c787a878e927e737e858ca0b6bfada09ba08e8c817e9299a0a08e9bc1c8b4a6998ea6c5ccbfbab6a98c7387adb4a69b8e8ea09b8c787a858c95929295a28e7173a9b6a29ba0958e9bb6b495';
  const api = {
    width: 256,
    height: 256,
    name: '微粒',
    id: 'c02fddff-f05a-1172-9a0f-f7bad69dd4b0',
    prefix: function () {
      const n = prefixHex.length / 2;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = parseInt(prefixHex.substr(i * 2, 2), 16);
      return out;
    }
  };
  if (typeof module !== 'undefined' && module.exports && typeof process !== 'undefined') module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { abrPatternTemplate: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
