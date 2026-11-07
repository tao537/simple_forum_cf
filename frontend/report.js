// ================================================================
//  举报弹窗（跨板块共享库）
//  --------------------------------------------------------------
//  为什么放在这里而不是各页自己写：论坛帖详情和游戏帖详情都要能举报，
//  两边皮肤完全是两套（米白纸 / 霓虹紫），如果每页写一份，样式会分叉；
//  这里做成一个"自带样式的库"，页面只传三个值（类型、id、标题）。
//
//  用法：
//    import { openReport } from '/report.js?v=20261110';
//    openReport({ targetType: 'post', targetId: 12, title: '标题' });
//
//  样式用深墨底 + 朱红强调（站点主色），在纸面与霓虹两种背景上都看得清，
//  不需要依赖页面自己定义的变量——保证单独拿走这页也不会失样。
//  样式只注入一次（右下角），页面 CSS 不需要改动。
// ================================================================

import { api, auth, escapeHtml } from './common.js?v=20261027';

const STYLE_ID = 'kuhai-report-style';
const REASONS = ['垃圾广告', '违规内容', '人身攻击', '侵权/盗图', '与板块无关'];

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = `
.kr-overlay{position:fixed;inset:0;z-index:9998;background:rgba(10,16,24,.62);
  display:flex;align-items:center;justify-content:center;padding:20px;
  opacity:0;pointer-events:none;transition:opacity .18s}
.kr-overlay.show{opacity:1;pointer-events:auto}
.kr-box{width:100%;max-width:420px;background:#16232f;color:#f3eee3;border-radius:10px;
  border:1px solid rgba(232,213,160,.28);box-shadow:0 24px 60px rgba(0,0,0,.5);
  padding:18px 20px 16px;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  transform:translateY(6px);transition:transform .18s}
.kr-overlay.show .kr-box{transform:none}
.kr-title{font-size:16px;font-weight:700;letter-spacing:.5px;display:flex;align-items:center;gap:6px}
.kr-title i{font-style:normal;color:#c8543f}
.kr-sub{font-size:12px;color:#93a4b5;margin-top:4px;line-height:1.6;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kr-chips{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 10px}
.kr-chip{font-size:12px;padding:5px 10px;border-radius:99px;cursor:pointer;user-select:none;
  background:rgba(232,213,160,.08);border:1px solid rgba(232,213,160,.22);color:#e8d5a0;
  transition:all .15s}
.kr-chip:hover{background:rgba(232,213,160,.18)}
.kr-chip.on{background:#a8322a;border-color:#a8322a;color:#fff}
.kr-ta{width:100%;box-sizing:border-box;min-height:84px;resize:vertical;border-radius:8px;
  background:#0d1721;border:1px solid rgba(232,213,160,.22);color:#f3eee3;
  font-size:13px;line-height:1.6;padding:9px 11px;font-family:inherit;outline:none}
.kr-ta:focus{border-color:#e8d5a0}
.kr-count{font-size:11px;color:#7d8b9a;text-align:right;margin-top:4px}
.kr-foot{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.kr-btn{font-size:13px;padding:7px 16px;border-radius:8px;cursor:pointer;border:1px solid transparent;
  font-family:inherit;transition:all .15s}
.kr-btn.ghost{background:transparent;border-color:rgba(232,213,160,.26);color:#cdd7e2}
.kr-btn.ghost:hover{border-color:#e8d5a0;color:#e8d5a0}
.kr-btn.prim{background:#a8322a;color:#fff;font-weight:600}
.kr-btn.prim:hover{background:#bd3a30}
.kr-btn:disabled{opacity:.55;cursor:not-allowed}
`;
  document.head.appendChild(st);
}

let overlay = null;

function build() {
  ensureStyle();
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'kr-overlay';
  overlay.innerHTML = `
    <div class="kr-box" role="dialog" aria-modal="true" aria-label="举报">
      <div class="kr-title"><i>⚑</i> 举报这一条</div>
      <div class="kr-sub" id="krSub"></div>
      <div class="kr-chips" id="krChips"></div>
      <textarea class="kr-ta" id="krTa" maxlength="200" placeholder="补充一点说明（选填），比如哪个位置有问题"></textarea>
      <div class="kr-count"><span id="krLen">0</span>/200</div>
      <div class="kr-foot">
        <button class="kr-btn ghost" id="krCancel">取消</button>
        <button class="kr-btn prim" id="krSend">提交举报</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#krCancel').addEventListener('click', close);
  overlay.querySelector('#krTa').addEventListener('input', (e) => {
    overlay.querySelector('#krLen').textContent = String(e.target.value.length);
  });

  // 预设理由：点一下就把理由填进输入框（可继续补充）
  overlay.querySelector('#krChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.kr-chip');
    if (!chip) return;
    const ta = overlay.querySelector('#krTa');
    const word = chip.dataset.r;
    ta.value = ta.value.trim() ? ta.value.trim() : word;
    if (!ta.value.includes(word)) ta.value = word + ' ' + ta.value;
    overlay.querySelectorAll('.kr-chip').forEach((c) => c.classList.toggle('on', c === chip));
    overlay.querySelector('#krLen').textContent = String(ta.value.length);
    ta.focus();
  });

  const els = overlay.querySelector('#krChips');
  els.innerHTML = REASONS.map((r) => `<span class="kr-chip" data-r="${escapeHtml(r)}">${escapeHtml(r)}</span>`).join('');
  return overlay;
}

function close() {
  if (overlay) overlay.classList.remove('show');
}

let ctx = null;

async function send() {
  if (!ctx) return;
  const btn = overlay.querySelector('#krSend');
  const ta = overlay.querySelector('#krTa');
  const reason = ta.value.trim();
  if (reason.length < 2) { ta.focus(); return; }

  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const r = await api('/api/reports', {
      method: 'POST',
      body: JSON.stringify({
        targetType: ctx.targetType,
        targetId: ctx.targetId,
        targetTitle: ctx.title || '',
        reason,
      }),
    });
    close();
    if (window.toast) window.toast(r && r.duplicated ? (r.message || '你已经举报过这一条') : '已提交，管理员会处理');
    else alert(r && r.duplicated ? (r.message || '你已经举报过这一条') : '已提交，管理员会处理');
  } catch (e) {
    const msg = String(e.message || '提交失败');
    if (/登录/.test(msg)) {
      if (confirm('举报需要先登录，现在去登录页？')) location.href = '/login.html';
    } else if (window.toast) {
      window.toast(msg, true);
    } else {
      alert(msg);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '提交举报';
  }
}

/** 打开举报弹窗；未登录直接引导去登录，避免填完才被拒 */
export function openReport({ targetType, targetId, title }) {
  if (!targetType || !targetId) return;
  const me = auth.getUser && auth.getUser();
  if (!me) {
    if (confirm('举报需要先登录，现在去登录页？')) location.href = '/login.html';
    return;
  }
  build();
  ctx = { targetType, targetId, title: title || '' };
  overlay.querySelector('#krSub').textContent =
    `${targetType === 'game-post' ? '游戏帖' : '帖子'} #${targetId}${title ? ' · ' + title : ''}`;
  overlay.querySelector('#krTa').value = '';
  overlay.querySelector('#krLen').textContent = '0';
  overlay.querySelectorAll('.kr-chip').forEach((c) => c.classList.remove('on'));
  overlay.querySelector('#krSend').onclick = send;
  overlay.classList.add('show');
  setTimeout(() => overlay.querySelector('#krTa').focus(), 60);
}

export const REPORT_REASONS = REASONS;
