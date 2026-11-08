/* 版本号比较 + 更新源候选（纯逻辑，浏览器/Node 通用，便于单测）。
   version.json 形如 {"version":"2.8.41","date":"2026-11-08T10:47:04.842Z"} */
(function (root) {
  'use strict';

  /* "2.8.41" -> [2,8,41]；非数字段按 0 处理，缺失段补 0（"2.9" 等同 "2.9.0"） */
  function parse(v) {
    return String(v == null ? '' : v)
      .trim()
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map(function (p) { var n = parseInt(p, 10); return isFinite(n) && n >= 0 ? n : 0; })
      .concat([0, 0, 0])
      .slice(0, 3);
  }

  /* a<b -> -1, a==b -> 0, a>b -> 1 */
  function compare(a, b) {
    const x = parse(a), y = parse(b);
    for (let i = 0; i < 3; i++) {
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return 0;
  }

  function isNewer(latest, current) {
    if (!latest || !current) return false;
    /* 无法解析成数字的（例如 "dev"）一律认为不是新版本，避免误报 */
    if (!/^\d/.test(String(latest).replace(/^v/i, ''))) return false;
    return compare(latest, current) > 0;
  }

  /* 更新源：同源优先（最快、离线缓存友好），再站点绝对地址、gh 镜像、jsDelivr。
     native / desktop 壳是 file:// 协议，拿不认同源，直接给绝对地址。 */
  function sources(opts) {
    opts = opts || {};
    const base = opts.siteBase || '';
    const raw = opts.rawBase || '';
    const mirrors = opts.mirrors || [];
    const cdn = opts.cdn || [];
    const native = !!opts.native;
    const file = 'version.json';
    const list = [];
    const push = function (u) { if (u && list.indexOf(u) < 0) list.push(u); };
    if (!native) push(file);
    if (base) push(base + file);
    for (let i = 0; i < mirrors.length; i++) if (raw) push(mirrors[i] + raw + file);
    for (let i = 0; i < cdn.length; i++) push(cdn[i] + file);
    if (native) push(file);
    return list;
  }

  /* 给 URL 加防缓存参数（部分镜像/CDN 会缓存 version.json 很久） */
  function bust(url, stamp) {
    const s = stamp === undefined ? Date.now() : stamp;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + s;
  }

  /* 把 version.json 归一化成 {version, date}；缺 version 视为无效 */
  function normalize(json) {
    if (!json || typeof json !== 'object') return null;
    const version = String(json.version || '').trim();
    if (!/^\d+\.\d+/.test(version)) return null;
    return { version: version, date: String(json.date || '') };
  }

  const api = { parse: parse, compare: compare, isNewer: isNewer, sources: sources, bust: bust, normalize: normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { update: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
