/* 画世界内置纹理库访问层（第187轮）
 *
 * `core/hsj-textures.js` 里 156 张纹理是 base64 的**原始图片字节**（143 JPEG + 13 PNG，
 * 全灰度、无损坏、无重复）。本模块负责「按 ptN 取 → 解码 → 转灰度 → 缓存」，
 * 供 convert.js 的 textureGray() 作为**第四级来源**使用。
 *
 * 为什么需要它：画世界 BRU 的纹理字段 f6 只存资源 id（`ptN`），不含像素。
 * 这类笔刷转到 ABR / Procreate / Krita / GoPaint / SAI2 / SUT 时，过去一律按
 * 「缺纹理原图」降级，纹理被静默丢掉（用户反馈过「网点笔刷变成半透明气枪」那类）。
 * 有了本模块就能用 App 自带的那张纹理补位。
 *
 * 优先级不能变（用户的素材永远高于内置库）：
 *   _patternPixels（ABR patt / 用户图案）> _grainRgba（Procreate Grain）
 *   > grain（GoPaint 解码）> 内置库(texAssetId) > null
 *
 * 已知限制：库里的 JPEG 有一部分是 progressive(SOF2)，而 `core/jpeg.js` 只支持
 * baseline(SOF0)。构建期会把它们重编码为 baseline 灰度（tools/reencode_hsj_textures.py）。
 * 解不开的 id 一律返回 null —— 不抛错、不重试、由各格式按原逻辑降级。
 */
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports && typeof process !== 'undefined';

  function dep(nodeName, bcName, req) {
    if (isNode) { try { return require(req); } catch (e) { return null; } }
    return (root.BC && root.BC[bcName]) || null;
  }
  const jpeg = dep('jpeg', 'jpeg', './jpeg.js');
  const png = dep('png', 'png', './png.js');

  /* 纹理库本身必须**惰性**取：网页端是懒加载的——用户在界面上点了「下载纹理库」
     之后才把 hsj-textures.js 注入 root.BC。如果在模块初始化时就把它抓进常量，
     懒加载完成后这里仍是 null，网页端就永远用不上（桌面端因为 require 在启动时
     就绪，看不出这个问题）。Node 端的 require 有模块缓存，每帧调用的开销可忽略。 */
  function srcRef() {
    if (isNode) { try { return require('./hsj-textures.js'); } catch (e) { return null; } }
    return (root.BC && root.BC.hsjTextures) || null;
  }

  /* 512² 灰度 = 256KB/张，全缓存 156 张约 40MB，不能全留；8 条足够覆盖
     「一次导出里反复取同一两张纹理」的实际访问模式。 */
  const CACHE_MAX = 8;
  const cache = new Map();   /* id -> {w,h,gray}；Map 的插入序就是 LRU 序 */
  const broken = new Set();  /* 解不开的 id，避免每次导出都重试解码 */

  function b64ToBytes(b64) {
    if (isNode) return new Uint8Array(Buffer.from(b64, 'base64'));
    const bin = root.atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* 解码结果统一成 {w,h,gray}（与 convert.js 的 textureGray 契约一致）。
     全库都是灰度，但 JPEG 解出来仍可能带三通道，所以按亮度合成；
     透明像素按白处理——纹理是遮罩语义，透明处应当是「满」而不是「黑」。 */
  function toGray(img) {
    if (!img) return null;
    const w = (img.width | 0) || (img.w | 0);
    const h = (img.height | 0) || (img.h | 0);
    if (!(w > 0 && h > 0)) return null;
    const rgba = img.rgba || img.data || null;
    if (!rgba) return null;
    const n = w * h;
    const gray = new Uint8Array(n);
    if (rgba.length === n) {                 /* 已经是单通道 */
      gray.set(rgba.subarray ? rgba.subarray(0, n) : rgba.slice(0, n));
      return { w: w, h: h, gray: gray };
    }
    if (rgba.length < n * 4) return null;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const a = rgba[o + 3] / 255;
      const inv = 1 - a;
      const r = rgba[o] * a + 255 * inv;
      const g = rgba[o + 1] * a + 255 * inv;
      const b = rgba[o + 2] * a + 255 * inv;
      /* 整数近似（0.299/0.587/0.114 → 77/151/28 / 256），避免每像素浮点乘 */
      gray[i] = Math.round((r * 77 + g * 151 + b * 28) / 256);
    }
    return { w: w, h: h, gray: gray };
  }

  function decodeOne(id) {
    const src = srcRef();
    if (!src || typeof src.get !== 'function') return null;
    const b64 = src.get(id);
    if (!b64 || typeof b64 !== 'string' || b64.length < 24) return null;
    const bytes = b64ToBytes(b64);
    if (bytes.length < 16) return null;
    let img = null;
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      if (!jpeg) return null;
      img = typeof jpeg.decode === 'function' ? jpeg.decode(bytes) : jpeg.parse(bytes);
    } else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      if (!png) return null;
      img = png.decode(bytes);
    } else {
      return null;
    }
    return toGray(img);
  }

  function normId(id) {
    const key = String(id === null || id === undefined ? '' : id).trim();
    return /^pt\d+$/.test(key) ? key : null;
  }

  /** 取一张内置纹理的灰度像素。命中返回 {w,h,gray}，任何情况下取不到都返回 null。 */
  function gray(id) {
    const key = normId(id);
    if (!key) return null;
    if (cache.has(key)) {
      const v = cache.get(key);
      cache.delete(key); cache.set(key, v);      /* 刷新 LRU 序 */
      return v;
    }
    if (broken.has(key)) return null;
    let got = null;
    try { got = decodeOne(key); } catch (e) { got = null; }
    if (!got) { broken.add(key); return null; }
    cache.set(key, got);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return got;
  }

  /** 是否真能取到像素（含缓存与已判死的 id），供 UI/报告判断要不要提示「需下载纹理库」。 */
  function has(id) {
    const key = normId(id);
    if (!key) return false;
    return cache.has(key) || (!broken.has(key) && !!gray(key));
  }

  /* 内容指纹缓存：反查时要把 156 张全算一遍 md5（每张 10–30ms 解码），
     算过一次就记住，后续单次反查只剩查表 + 一次 md5。 */
  const sigCache = new Map();   /* id -> 'WxH:md5' */

  function md5Of(bytes) {
    const util = isNode ? require('./util.js') : (root.BC && root.BC.util);
    if (!util || typeof util.md5 !== 'function') return null;
    return util.md5(bytes);
  }

  function sigOf(id) {
    if (sigCache.has(id)) return sigCache.get(id);
    const g = gray(id);
    if (!g || !g.gray) { sigCache.set(id, null); return null; }
    const h = md5Of(g.gray);
    const sig = h ? (g.w + 'x' + g.h + ':' + h) : null;
    sigCache.set(id, sig);
    return sig;
  }

  /** 按灰度像素反查库里有没有同一张纹理，命中返回 ptN，否则 null。
   *  用于 BRU 写 f6：源笔刷的纹理若是画世界内置的那张，就该写回它自己的编号，
   *  而不是一律写死 'pt24'。 */
  function matchId(w, h, grayArr) {
    const W = w | 0, H = h | 0;
    if (!(W > 0 && H > 0) || !grayArr || grayArr.length !== W * H) return null;
    const target = md5Of(grayArr);
    if (!target) return null;
    const want = W + 'x' + H + ':' + target;
    const total = (srcRef() && srcRef().count) || 0;
    for (let i = 1; i <= total; i++) {
      const id = 'pt' + i;
      if (sigOf(id) === want) return id;
    }
    return null;
  }

  /* 【第206轮 R204-02（作者：Claude）】内置纹理的**预计算**内容指纹表。
     key = 'W x H : md5(灰度像素)'（灰度按本模块 toGray 的口径），value = ptN。
     用途：Procreate / ABR 等来源的纹理若与画世界内置纹理逐像素相同，BRU 写出时
     直接引用 f6=ptN（独立纹理、固定在画布上），不再把网点烘进笔尖（连续落印会填平）。
     为什么要预计算：matchId() 要把 156 张全部解码一遍，Codex 实测首次 1.7 s、未命中 5.3 s；
     查这张表只要算一次源纹理的 md5，且**不需要先下载 31 MB 纹理库**（写 f6 只要编号）。
     表由当前 core/jpeg.js + hsj-textures.js 生成；test/halftone_texture206_test.js 会
     重新解码全库逐条核对，解码器或库一变就会红灯，不会悄悄失配。 */
  const KNOWN_SIGS = {
    "512x512:9ec424b085f78bc054a913a6fc2b16d2": "pt1",
    "512x512:12297cdac2eeda7bb9694b19419467a5": "pt2",
    "512x512:827d6e690aa09126dba4350c83c3e296": "pt3",
    "512x512:bf708b95db8198152a9997c971a1bbed": "pt4",
    "512x512:5df4d0f819700816eece0ed3774482b8": "pt5",
    "512x512:a49087ae4ab568c444185eb6a3112b6b": "pt6",
    "512x512:3b05b88c69baab601d114c32491ee996": "pt7",
    "512x512:254a8ad21ac88f5cef8707355ad2f1d5": "pt8",
    "512x512:a096d47e8bc930d6732e00fa41516447": "pt9",
    "512x512:3fa1ea34cb3f293fb6bf14e6539856c2": "pt10",
    "512x512:8409871f58a29a9f3cdecf0d6f336b58": "pt11",
    "512x512:e99ab2ea73310723378ccee5c80d2288": "pt12",
    "512x512:d1a07b74f78341d09f60050c74c286d2": "pt13",
    "512x512:654ddb349fe03c30088aadaa75efcfdf": "pt14",
    "512x512:c4d2cb2bd91b81711616537e2dc1aee1": "pt15",
    "512x512:62f50385afa16a2d695a1344845b5162": "pt16",
    "512x512:4e87aa0989414b086be867e1276defb4": "pt17",
    "512x512:8d220b26d29998606dc479339e4dc5e0": "pt18",
    "512x512:f8546ef6997d95f0e25148e4ff22b652": "pt19",
    "512x512:34e3cb6f1b2256cb6e1bbcf2cdd30ff3": "pt20",
    "512x512:00bbab8667334f87562afabc6847383a": "pt21",
    "512x512:89b72101bcaa5438670bd378b549bcc3": "pt22",
    "512x512:37d87cac97288218df5a8a0af936c1f8": "pt23",
    "512x512:1aad7427ac03b6fdfba3eb1e8f94b4b5": "pt24",
    "512x512:9a1ec3bf58238d3db647057eaf0ee4ca": "pt25",
    "512x512:20bdbef5a916f172b01dda2c18ddf329": "pt26",
    "512x512:071e0a36e08bc1452ae6c60bfe1f93f5": "pt27",
    "512x512:6725f72a6fc79219f6bada669efe0377": "pt28",
    "512x512:642ef241169d938271875a4a0f3f6e05": "pt29",
    "512x512:dec118d46818b479bcb42ec80a8ea157": "pt30",
    "512x512:79abb59ce57823d462e6bd4a1bfd4a7b": "pt31",
    "512x512:d5996d84571aef1cba82375bda468383": "pt32",
    "512x512:fd24e813b9c7e30098fb0b6b6ee2cb95": "pt33",
    "512x512:d0ec6524cc9d02cc89beeed2c1ee37bb": "pt34",
    "512x512:939798ad0bf14d036ef6681180243441": "pt35",
    "512x512:72e79ae4ebd7db0e1d48cbae027f604b": "pt36",
    "512x512:c37cecde5ad9f4b62bf657b61e10f23f": "pt37",
    "512x512:f87158c6366d0960808f0676b641a942": "pt38",
    "512x512:e612a1415b55aae6cfb56e8e040882b4": "pt39",
    "512x512:3b3009c5d5d4e73e2a213481d7b3de41": "pt40",
    "512x512:fc83ca23392a77e72c235529596cbd71": "pt41",
    "512x512:7bb846dd9306de377feedaa1acafc783": "pt42",
    "512x512:ef848e3ee5a554a9d22ee58d2ae31306": "pt43",
    "512x512:314bf1eda05498aa4b2db686412beebf": "pt44",
    "512x512:3d8855be580c4136b825567fbb1cba63": "pt45",
    "512x512:a8fb96e1dfe24e3ac106665c44533a09": "pt46",
    "512x512:970b4178c4fa73a75feb3dc95c4d966c": "pt47",
    "512x512:023dedf6989a27f0b154f86649a882d1": "pt48",
    "512x512:f8a15876e5bb96b8daa6f7fd0bb750df": "pt49",
    "512x512:e4e2db42254664b09fcc3a614b9f7f02": "pt50",
    "512x512:17505dbdfd553d04bb0fa2bdd0c42dc1": "pt51",
    "512x512:c7017ff905610f092dc39b2a3cef665b": "pt52",
    "512x512:6e795818badcf3df75f6d45aaad850c4": "pt53",
    "512x512:809fbad59bcb04a1688a772855868fe3": "pt54",
    "512x512:ac08da79c089f443b41fcfdf771db16d": "pt55",
    "512x512:e6a6f57e3b06f7cc10af4250ea4b514e": "pt56",
    "512x512:6f81f63a6661473adf149ad98b17536c": "pt57",
    "512x512:bacec34015ae41f33665bdf40a5896ca": "pt58",
    "512x512:48b6fae255307a62013a1cdba1178c92": "pt59",
    "512x512:e5c99d8858e5b30104e96b778c04e830": "pt60",
    "512x512:c2dc746cea4f0538761d9edb9afbfa63": "pt61",
    "512x512:c65466f2e1418782ec0178778c5bbd1a": "pt62",
    "512x512:79429324c3b5c1b3553ed3790145c9e1": "pt63",
    "512x512:26b04230e4b6d62d810570697b513bcc": "pt64",
    "64x64:66023a2efaecad34895ba0a6d747da7a": "pt65",
    "64x64:356ea34d000fdfedc4e4e53a0c921891": "pt66",
    "64x64:b465120a0d48f034c3c084ac6ab4afb4": "pt67",
    "64x64:9674a7cf19c0a10fab69720349db56f3": "pt68",
    "64x64:88966bbd4ac8fccc9f0db1a4d1d0dec6": "pt69",
    "64x64:eba396e815c336c379d779522af40528": "pt70",
    "64x64:afe9d9aeb52f4afdcf6583da63d7ecab": "pt71",
    "64x64:f47fc029e3a9775cc22518aefea5da03": "pt72",
    "64x64:8856469d5cae2203ecc1510d7cc8bad1": "pt73",
    "64x64:e6fff07bdfc3c5d2944069a21748f82b": "pt74",
    "64x64:768dec47317a27e4e531aeaaa1ad280d": "pt75",
    "512x512:634a0e45fd7628b3a72990b425216c24": "pt76",
    "512x512:1ee3376b4ab68d28a3c006e46e043cf8": "pt77",
    "512x512:c1b9178ff16adb9876d1cbb0248ba0bf": "pt78",
    "512x512:44f40b202025a323d61edecf8b87acf6": "pt79",
    "512x512:d20459fd52b92576a0d76229b257afc1": "pt80",
    "512x512:a33009aa357fff2d8e7a44eeb66c2ebf": "pt81",
    "512x512:6a02dddd6a931b9ebad217e24e231064": "pt82",
    "512x512:eea9b6feeb469bccea7be7de62893bb0": "pt83",
    "512x512:09c71335f1a712b0adcab9b331527f1c": "pt84",
    "512x512:04229d18ceb21ac9ed48b79c85b7e600": "pt85",
    "512x512:bfc5383c7c7e47d29f129483c454cad3": "pt86",
    "512x512:313dcff2b45d4acf4234945350b24869": "pt87",
    "512x512:5f88cea8555f71d037cb0b4a66602abe": "pt88",
    "1024x1024:46b501ae2ad3522a8ca244bdc0c39fb5": "pt89",
    "1024x1024:198afc3f806c96235cc1b309671aa5bb": "pt90",
    "1024x1024:6f3282e58be739e0731cba77dc363db7": "pt91",
    "1024x1024:1fc731eabe7fb8d1ee44b658114e9e44": "pt92",
    "400x400:459795f26b848dc1deb3ca83a086a839": "pt93",
    "1024x1024:9af77161af84bb0f038ef2bc344e85b9": "pt94",
    "512x512:065096f595a42bf1376ab0a5bc74e6d0": "pt95",
    "500x500:89c134ee9b90fe6fdc01e525f40fc911": "pt96",
    "512x512:b8d08677cc92a99b547c77d97d6ae80d": "pt97",
    "512x512:e995decdc15d75a811da407959e6705b": "pt98",
    "512x512:1767af46744931a071e0b21184680e61": "pt99",
    "512x512:715fccc8f9b45543667145fcd1f1e094": "pt100",
    "512x512:c3306b522a783319f4dcecc7e41167bb": "pt101",
    "512x512:4cb70268383eae0cf47a16cb573c9ead": "pt102",
    "512x512:5b0fbe5fff7fdd2114ac26f707080971": "pt103",
    "1024x1024:7d0906101e9ce0d1862a603d77f0660a": "pt104",
    "1024x1024:adb31b5d6e168a58b2a8370970624427": "pt105",
    "1024x1024:8839ebe1bed1c56b00beb32c0f06f9ce": "pt106",
    "1024x1024:9dac66b6db80433ee7202dc892cf9c33": "pt107",
    "1024x1024:6cbe31fc1372d731e5a7b089cddedc1c": "pt108",
    "1024x1024:b6fb15c93e23ecc670917a835bd7f9b8": "pt109",
    "1024x1024:2bb99d20f1e24aa2c794cd089db60995": "pt110",
    "1024x1024:b7568c564d0215d737455bd4cde11c4c": "pt111",
    "1024x1024:0a2b63bb9b6a81d1beaee8216aae276c": "pt112",
    "1024x1024:976b00057b37fee749ec10c270b03b46": "pt113",
    "1024x1024:d1d1d12fdd86feb4cf3d2e48240ad484": "pt114",
    "1024x1024:9657f066f995540feeb1ffb326d4bfcc": "pt115",
    "1024x1024:5b9a4329634a9baa8d8d0a45ec804e0a": "pt116",
    "1024x1024:ce3d7ede310a1b54bd1bed650b063172": "pt117",
    "1024x1024:79c4c3c245b1040bfb5fd9adcd6f107f": "pt118",
    "1024x1024:8dbe974bdc20fc473fb8a8e9c2d8e9d6": "pt119",
    "1024x1024:e6759a912deccafc800e3dc7b0c95503": "pt120",
    "1024x1024:bd48a2b80b7a6be5fbafecc2a340c0b6": "pt121",
    "1024x1024:ae83bd224c7c07f2c173a7d17c706e83": "pt122",
    "1024x1024:3cd0955e4cea5404fcae6e99f237f37a": "pt123",
    "1024x1024:cdad4bf2141615d2161f382d1b9440e4": "pt124",
    "1024x1024:51440fb76fac2f15a5792bea86826dbf": "pt125",
    "1024x1024:9c1309d76b46eea27e194cf6429e6cd5": "pt126",
    "1024x1024:701b288e693798298c20e6f1c5b8431a": "pt127",
    "1024x1024:125338cc58468efd3e8a3a7ccc10a298": "pt128",
    "1024x1024:a443d425740aa33b797cc69d9d37ddff": "pt129",
    "1024x1024:730d5412bf5940295bc80578257bb714": "pt130",
    "1024x1024:219aa5f6120491a4dfa6413db945a322": "pt131",
    "1024x1024:17e5091073abbb79873b0c3dc6677c63": "pt132",
    "1024x1024:14f3bf3aa6d3e77bf8cc8796e9051028": "pt133",
    "1024x1024:a26e336d9f68eb7a8431377ddd213749": "pt134",
    "1024x1024:ed36a82ebb90187a32c5696ac04c4daa": "pt135",
    "1024x1024:8b692e3bd24d73cb0264b61a5e61cf8c": "pt136",
    "1024x1024:a7430c504f810c8526fecb5170bda5f0": "pt137",
    "1024x1024:cc7782bcf10eea2e6dc7139b8732195b": "pt138",
    "1024x1024:ac91c6a6784290a0a44dd3900fa1965f": "pt139",
    "1024x1024:412e272fa0d5dd4ea8ac301546b18b00": "pt140",
    "1024x1024:d7f9fc080a1a7bd34f80360eb9fd22e7": "pt141",
    "1024x1024:07e2734d757102b69166e8e4cd56d286": "pt142",
    "1024x1024:8125099bd8c921dd3f6075ea4e8f9cd5": "pt143",
    "1024x1024:00e4cdf1feb95f6af966f6b026ecbfd3": "pt144",
    "1024x1024:fdd928a838f8b399a477a99d68dfba02": "pt145",
    "1024x1024:d1ca57d4354735791ae43f701ac5cf02": "pt146",
    "1024x1024:05eb5491e22deeb303736c9ae5904bf7": "pt147",
    "1024x1024:27874b3b0914f62069e1e31413805747": "pt148",
    "1024x1024:692b32355a1a2ef5bd60784501ab599c": "pt149",
    "1024x1024:431afad7bc941704fc195f3ed1ccbc0c": "pt150",
    "1024x1024:56d413a3817cfea92cc7247395a0552f": "pt151",
    "1024x1024:1bf3417a20a14a0b997b81a26495b1b5": "pt152",
    "1024x1024:5daacc803377d72e0707245d23f0801e": "pt153",
    "1024x1024:b82c90d9bbbcba0daa0df8320a6032f6": "pt154",
    "607x974:9292903d8f094946a5c333bddacd8d16": "pt155",
    "974x607:5a73d080bf01b791a7f9216a16a727be": "pt156"
  };

  /** 只查预计算表的精确反查：命中返回 ptN，否则 null。不解码库、不依赖库是否已下载。 */
  function matchKnown(w, h, grayArr) {
    const W = w | 0, H = h | 0;
    if (!(W > 0 && H > 0) || !grayArr || grayArr.length !== W * H) return null;
    const m = md5Of(grayArr);
    if (!m) return null;
    const id = KNOWN_SIGS[W + 'x' + H + ':' + m];
    return id || null;
  }

  /** 库里的 id 清单（不触发解码）。 */
  function ids() {
    const out = [];
    const src = srcRef();
    if (!src || typeof src.get !== 'function') return out;
    const total = src.count || 0;
    for (let i = 1; i <= total; i++) {
      const id = 'pt' + i;
      if (src.get(id)) out.push(id);
    }
    return out;
  }

  function clearCache() { cache.clear(); broken.clear(); sigCache.clear(); }

  const api = {
    gray: gray,
    has: has,
    matchId: matchId,
    matchKnown: matchKnown,
    knownSigs: function () { return Object.assign({}, KNOWN_SIGS); },
    ids: ids,
    clearCache: clearCache,
    get count() { const s = srcRef(); return (s && s.count) || 0; },
    cacheSize: function () { return cache.size; },
    brokenIds: function () { return Array.from(broken); }
  };

  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { hsjTextureLib: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
