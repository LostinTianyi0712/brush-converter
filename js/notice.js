/* 首次打开公告：独立小脚本，页面结构解析到就立即显示，不等主程序（约1MB JS）加载。
 * 主程序 app.js 检测到 window.__brushNotice 时会跳过自带的通知逻辑，避免重复弹窗。 */
(function () {
  'use strict';
  var KEY = 'brushconv_notice_20261022_seen';
  function html() {
    return '<h2>公告</h2>' +
      '<div class="modal-body">本工具<b>免费发布</b>，获取地址：<br>' +
      '<a href="https://xhslink.cn/o/3oISiVWckx3" target="_blank" rel="noopener">https://xhslink.cn/o/3oISiVWckx3</a><br>' +
      'QQ：<b>941034827</b><br>' +
      '如付费获取，请联系商家退款。</div>' +
      '<div class="modal-thanks">特别感谢：<a href="https://github.com/tohsakarat/Brush-Converter" target="_blank" rel="noopener">tohsakarat / Brush-Converter</a>（提供了 PS6 文件格式规范与 ABR 参数解析参考，本项目仅参考其公开规范与思路，未使用其代码）</div>' +
      '<div class="modal-note">此公告仅在第一次打开时显示，之后可在页面底部点「公告」再次查看。</div>' +
      '<div class="modal-actions"><button type="button" data-close>我知道了</button></div>';
  }
  function show() {
    var old = document.querySelector('.modal-backdrop');
    if (old) old.remove();
    var back = document.createElement('div');
    back.className = 'modal-backdrop';
    var card = document.createElement('div');
    card.className = 'modal-card';
    card.innerHTML = html();
    back.appendChild(card);
    document.body.appendChild(back);
    back.addEventListener('click', function (e) {
      if (e.target === back || (e.target && e.target.hasAttribute('data-close'))) {
        try { localStorage.setItem(KEY, '1'); } catch (err) { /* ignore */ }
        back.remove();
      }
    });
  }
  function init() {
    var seen = '';
    try { seen = localStorage.getItem(KEY) || ''; } catch (e) { seen = ''; }
    if (!seen) show();
    var footer = document.querySelector('.footer');
    if (footer && !document.getElementById('showNotice')) {
      var a = document.createElement('a');
      a.id = 'showNotice';
      a.href = 'javascript:void(0)';
      a.textContent = '公告';
      a.style.cssText = 'margin-left:10px;color:#2563eb;text-decoration:underline;cursor:pointer;font-size:12px;white-space:nowrap;flex:0 0 auto';
      a.addEventListener('click', show);
      footer.appendChild(a);
    }
  }
  /* 仅在真实浏览器里执行 DOM 初始化；Node vm 测试环境（无 document/window）直接跳过 */
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    init();
    window.__brushNotice = { show: show, KEY: KEY };
  }
})();
