'use strict';
/*
 * SAI2「设置包」读取（第153轮追加）
 *
 * 用户在 SAI2 侧的导出方式（已实测）：
 *   退出 SAI2 → 打包 settings 下的 custool / brushfom / brushtex / papertex / scatter（跳过 bak）→
 *   可选再加入 settings2.ssd（布局）。
 * 本模块只读这种 ZIP：把 custool 里的工具/组/别名/集合解析成清单，并统计素材数量。
 * 不换算参数（.saitdat 数值语义未标定，见 SAI2原生工具预设格式_第153轮）。
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const zip = isNode ? require('./zip.js') : root.BC.zip;
  const sd = isNode ? require('./sai2dat.js') : root.BC.sai2dat;

  const TOOL_RE = /^custool\/([^/]+)\/(\d+)\.saitdat$/i;
  const LINK_RE = /^custool\/([^/]+)\/(\d+)\.saitlnk$/i;
  const GROUP_RE = /^custool\/([^/]+)\/_(\d+)\.saitgrp$/i;
  const SET_RE = /^custool\/([^/]+)\/_\d+\.saitset$/i;
  const MATERIAL_ROOTS = { brushfom: 1, brushtex: 1, papertex: 1, scatter: 1 };

  function latin1(bytes) {
    if (typeof bytes === 'string') return bytes;
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('latin1');
    return Array.prototype.map.call(bytes, function (c) { return String.fromCharCode(c); }).join('');
  }

  /** 是否是设置包 ZIP（有 custool/<family>/*.saitdat 即算）。 */
  function isSettingsPack(bytes) {
    if (!bytes || !zip) return false;
    let entries;
    try { entries = zip.read(bytes); } catch (e) { return false; }
    if (!entries || !entries.length) return false;
    return entries.some(function (e) { return TOOL_RE.test(e.name || ''); });
  }

  /**
   * 读出设置包清单。
   * @returns {{families: Array, materials: Object, totals: Object, layout: boolean}}
   */
  function readSettingsPack(bytes) {
    const entries = zip.read(bytes);
    const families = new Map();
    const materials = { brushfom: 0, brushtex: 0, papertex: 0, scatter: 0 };
    let layout = false;

    function fam(name) {
      if (!families.has(name)) families.set(name, { name: name, tools: [], links: [], groups: [], sets: 0 });
      return families.get(name);
    }
    function dataOf(e) {
      try { return typeof e.data === 'function' ? e.data() : e.data; } catch (err) { return null; }
    }

    for (const e of entries) {
      const name = e.name || '';
      if (name === 'settings2.ssd') { layout = true; continue; }
      const top = name.split('/')[0];
      if (MATERIAL_ROOTS[top]) { materials[top]++; continue; }

      let m;
      if ((m = TOOL_RE.exec(name))) {
        const b = dataOf(e);
        if (!b) continue;
        const doc = sd.parse(latin1(b));
        fam(m[1]).tools.push({
          id: Number(m[2]), file: name,
          name: sd.get(doc, 'name') || null,
          cursize: sd.get(doc, 'cursize'),
          curszscl: sd.get(doc, 'curszscl'),
          keyCount: Object.keys(sd.all(doc)).length
        });
      } else if ((m = LINK_RE.exec(name))) {
        const b = dataOf(e);
        if (!b) continue;
        const doc = sd.parse(latin1(b));
        fam(m[1]).links.push({ id: Number(m[2]), target: sd.get(doc, 'tarid') });
      } else if ((m = GROUP_RE.exec(name))) {
        const b = dataOf(e);
        if (!b) continue;
        const doc = sd.parse(latin1(b));
        fam(m[1]).groups.push({ id: Number(m[2]), file: name, name: sd.get(doc, 'name') || null, slots: sd.slots(doc) });
      } else if (SET_RE.test(name)) {
        const f = SET_RE.exec(name);
        fam(f[1]).sets++;
      }
    }

    const out = { families: [], materials: materials, layout: layout };
    let toolTotal = 0, groupTotal = 0;
    for (const f of families.values()) {
      const byId = new Map(f.tools.map(function (t) { return [t.id, t]; }));
      const placed = new Set();
      for (const g of f.groups) {
        g.tools = g.slots.map(function (s) {
          const t = byId.get(s.id);
          if (t) placed.add(s.id);
          return { slot: s.slot, id: s.id, name: t ? t.name : null };
        }).sort(function (a, b) { return a.slot - b.slot; });
        groupTotal++;
      }
      f.groups.sort(function (a, b) { return a.id - b.id; });
      f.tools.sort(function (a, b) { return a.id - b.id; });
      f.ungrouped = f.tools.filter(function (t) { return !placed.has(t.id); }).map(function (t) { return t.id; });
      toolTotal += f.tools.length;
      out.families.push(f);
    }
    out.families.sort(function (a, b) { return a.name.localeCompare(b.name); });
    out.totals = { families: out.families.length, tools: toolTotal, groups: groupTotal,
                   links: out.families.reduce(function (n, f) { return n + f.links.length; }, 0) };
    return out;
  }

  /** 人类可读的一句话概要（用于错误提示/日志）。 */
  function summarize(sum) {
    const parts = sum.families.map(function (f) {
      return f.name + ' ' + f.tools.length + '支/' + f.groups.length + '组';
    });
    return parts.join('，') +
      '；素材 brushfom ' + sum.materials.brushfom + ' / brushtex ' + sum.materials.brushtex +
      ' / papertex ' + sum.materials.papertex + ' / scatter ' + sum.materials.scatter +
      (sum.layout ? '；含 settings2.ssd（布局）' : '；无 settings2.ssd');
  }

  const api = { isSettingsPack, readSettingsPack, summarize };
  if (isNode) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, { sai2settings: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
