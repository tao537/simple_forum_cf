  import { auth, api, escapeHtml, renderNav, initAnimatedBackground, initMusicPlayer,
           loadDisplaySettings, getDisplaySettings, API_BASE } from './common.js?v=20261027';

  let settingsForm = null;
  const postState = { page: 1, size: 20, total: 0 };

  function toast(msg, isErr = false) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = isErr ? 'show err' : 'show';
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.className = ''), 2400);
  }
  window.toast = toast;
  window.logout = function () { auth.clear(); location.reload(); };

  // ===== 标签页切换 =====
  // 记住上次停留的标签页（localStorage），并同步到地址栏 #hash，刷新/深链都不丢位置
  const TAB_KEY = 'admin_last_tab';
  const TABS = ['dashboard', 'health', 'reports', 'posts', 'users', 'categories', 'game', 'gate', 'content', 'settings', 'export'];

  window.switchTab = function (tab) {
    if (!TABS.includes(tab)) tab = 'dashboard';
    document.querySelectorAll('.admin-tabs button').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p =>
      p.classList.toggle('show', p.id === 'panel-' + tab));
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* 隐私模式忽略 */ }
    try { history.replaceState(null, '', '#' + tab); } catch { /* 忽略 */ }
    if (tab === 'dashboard') loadDashboard();
    if (tab === 'health') loadHealth();
    if (tab === 'reports') loadReports();
    if (tab === 'posts') loadPosts(1);
    if (tab === 'users') loadUsers();
    if (tab === 'categories') loadCategories();
    if (tab === 'game') loadGameAdmin();
    if (tab === 'gate') loadGateAdmin();
    if (tab === 'content') loadSiteContentForm();
    if (tab === 'settings') initSettingsForm();
  };

  /** 启动时决定进哪个标签：地址栏 #hash 优先，其次上次记忆，最后概览 */
  function initialTab() {
    const fromHash = (location.hash || '').replace('#', '');
    if (TABS.includes(fromHash)) return fromHash;
    try {
      const saved = localStorage.getItem(TAB_KEY);
      if (TABS.includes(saved)) return saved;
    } catch { /* 忽略 */ }
    return 'dashboard';
  }

  // ===== 站点体检 =====
  // 后端一次回所有检查项；前端只负责上色与排版，不做任何判断
  async function loadHealth() {
    const sum = document.getElementById('healthSum');
    const list = document.getElementById('healthList');
    sum.className = 'health-sum lv-ok';
    sum.innerHTML = '<div class="empty">检查中…</div>';
    list.innerHTML = '';
    try {
      const d = await api('/api/admin/health');
      const ICON = { ok: '✅', warn: '⚠️', bad: '⛔' };
      const TAG = { ok: '正常', warn: '注意', bad: '需处理' };
      const lv = d.bad ? 'lv-bad' : (d.warn ? 'lv-warn' : 'lv-ok');
      const head = d.bad
        ? `${d.bad} 项需要处理${d.warn ? `，${d.warn} 项注意` : ''}`
        : (d.warn ? `${d.warn} 项需要注意` : '全部正常');
      sum.className = 'health-sum ' + lv;
      sum.innerHTML = `<b>${escapeHtml(head)}</b><span>检查时间 ${escapeHtml(new Date(d.checkedAt).toLocaleString('zh-CN'))}</span>`;
      list.innerHTML = (d.items || []).map((i) => `
        <div class="health-item lv-${i.level}">
          <div class="hi-ic">${ICON[i.level] || '•'}</div>
          <div class="hi-body">
            <div class="hi-title">${escapeHtml(i.title)}<span class="hi-tag">${TAG[i.level] || ''}</span></div>
            <div class="hi-detail">${escapeHtml(i.detail)}</div>
          </div>
        </div>`).join('');
    } catch (e) {
      sum.className = 'health-sum lv-bad';
      sum.innerHTML = `<b>检查失败</b><span>${escapeHtml(e.message || '接口不可用')}</span>`;
    }
  }
  window.loadHealth = loadHealth;

  // ===== 举报处理 =====
  // 工单存在 KV 里，前端只做一件事：按状态列出来，然后改状态 + 写备注。
  // 明确不做「一键删帖」——处置动作留给帖子管理页，避免一次误点造成不可逆结果。
  const REP_LABEL = { open: '待处理', done: '已处理', ignored: '已忽略' };
  const REP_TYPE = { post: '论坛帖', 'game-post': '游戏帖' };

  async function loadReports() {
    const sum = document.getElementById('repSum');
    const list = document.getElementById('repList');
    const status = (document.getElementById('repStatus') || {}).value || 'open';
    sum.textContent = '加载中…';
    list.innerHTML = '';
    try {
      const d = await api('/api/admin/reports?status=' + encodeURIComponent(status));
      const items = d.items || [];
      sum.innerHTML = `<b>${items.length} 条${REP_LABEL[status] || ''}工单</b><span>工单保存在 KV，保留 180 天</span>`;
      if (!items.length) {
        list.innerHTML = '<div class="empty">这一栏是空的。没有人举报，就是没人举报。</div>';
        return;
      }
      list.innerHTML = items.map((r) => `
        <div class="rep-item st-${r.status}">
          <div class="rep-head">
            <span class="rep-type">${escapeHtml(REP_TYPE[r.targetType] || r.targetType)}</span>
            <span class="rep-title">${escapeHtml(r.targetTitle || ('#' + r.targetId))}</span>
            <span class="rep-st st-${r.status}">${escapeHtml(REP_LABEL[r.status] || r.status)}</span>
          </div>
          <div class="rep-body">${escapeHtml(r.reason)}</div>
          <div class="rep-meta">
            <span>👤 ${escapeHtml(r.reporter)}</span>
            <span>🕒 ${escapeHtml(new Date(r.createdAt).toLocaleString('zh-CN'))}</span>
            ${r.handledAt ? `<span>✅ ${escapeHtml(r.handledBy || '管理员')} · ${escapeHtml(new Date(r.handledAt).toLocaleString('zh-CN'))}</span>` : ''}
            ${r.note ? `<span>💬 ${escapeHtml(r.note)}</span>` : ''}
          </div>
          <div class="rep-actions">
            <a class="btn btn-ghost btn-sm" href="/${r.targetType === 'game-post' ? 'game-post' : 'post'}?id=${encodeURIComponent(r.targetId)}" target="_blank" rel="noopener">查看原帖</a>
            ${r.status !== 'done' ? `<button class="btn btn-primary btn-sm" onclick="reportAction('${escapeHtml(r.key)}','done')">标记已处理</button>` : ''}
            ${r.status !== 'ignored' ? `<button class="btn btn-ghost btn-sm" onclick="reportAction('${escapeHtml(r.key)}','ignored')">忽略</button>` : ''}
            ${r.status !== 'open' ? `<button class="btn btn-ghost btn-sm" onclick="reportAction('${escapeHtml(r.key)}','open')">退回待处理</button>` : ''}
          </div>
        </div>`).join('');
    } catch (e) {
      sum.textContent = '读取失败：' + (e.message || '接口不可用');
      list.innerHTML = '';
    }
  }
  window.loadReports = loadReports;

  window.reportAction = async function (key, status) {
    let note = '';
    if (status !== 'open') {
      note = prompt(REP_LABEL[status] + '：写一句处理备注（可留空）', '') || '';
    }
    try {
      await api('/api/admin/reports/' + encodeURIComponent(key), {
        method: 'PATCH',
        body: JSON.stringify({ status, note }),
      });
      toast('已更新：' + REP_LABEL[status]);
      loadReports();
    } catch (e) {
      toast(e.message || '更新失败', true);
    }
  };

  // 这三个 loader 被 HTML 的 onclick / onchange 直接调用。
  // <script type="module"> 有独立作用域，模块内的 function 不会变成全局变量，
  // 必须显式挂到 window，否则点「筛选」「上一页」会报 xxx is not defined。
  window.loadPosts = (page) => loadPosts(page);
  window.loadUsers = () => loadUsers();
  window.loadGamePosts = (page) => loadGamePosts(page);

  // ===== 数据概览 =====
  async function loadDashboard() {
    try {
      const d = await api('/api/admin/stats');
      document.getElementById('st-users').textContent = d.users;
      document.getElementById('st-posts').textContent = d.posts;
      document.getElementById('st-comments').textContent = d.comments;
      document.getElementById('st-likes').textContent = d.postLikes + d.commentLikes;
      document.getElementById('st-banned').textContent = d.banned;
      document.getElementById('st-new-users').textContent = d.newUsersToday ? `今日新增 ${d.newUsersToday}` : '';
      document.getElementById('st-new-posts').textContent = d.newPostsToday ? `今日新增 ${d.newPostsToday}` : '';

      // 分类分布
      const cats = d.categories || [];
      const max = Math.max(1, ...cats.map(c => c.count));
      document.getElementById('catBars').innerHTML = cats.length
        ? cats.map(c => `
          <div class="bar-row">
            <span class="name">${escapeHtml(c.name)}</span>
            <span class="track"><span class="fill" style="width:${Math.round(c.count / max * 100)}%"></span></span>
            <span class="val">${c.count}</span>
          </div>`).join('')
        : '<div class="empty">暂无帖子</div>';

      // 热门帖子
      document.getElementById('topPosts').innerHTML = (d.topPosts || []).map(p => `
        <tr>
          <td><a href="/post.html?id=${p.id}" style="color:#2563eb;text-decoration:none">${escapeHtml(p.title)}</a></td>
          <td>${p.views}</td><td>${p.upvotes}</td><td>${p.comment_count}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="empty">暂无</td></tr>';
    } catch (e) { toast(e.message, true); }
  }

  // ===== 修改我的密码 =====
  window.saveMyPassword = async function () {
    const oldPw = document.getElementById('my-old-pw').value;
    const newPw = document.getElementById('my-new-pw').value;
    const msg = document.getElementById('my-pw-msg');
    msg.style.color = '#64748b';
    if (!oldPw || !newPw) { msg.textContent = '请填写原密码和新密码'; return; }
    if (newPw.length < 8) { msg.textContent = '新密码至少 8 位'; return; }
    try {
      await api('/api/users/password', { method: 'PUT', body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }) });
      document.getElementById('my-old-pw').value = '';
      document.getElementById('my-new-pw').value = '';
      msg.style.color = '#16a34a';
      msg.textContent = '✅ 密码已修改，下次登录请使用新密码';
    } catch (e) {
      msg.style.color = '#dc2626';
      msg.textContent = e.message;
    }
  };

  // ===== 帖子管理 =====
  async function loadPosts(page = 1) {
    postState.page = Math.max(1, page);
    const kw = document.getElementById('postKw').value.trim();
    const cat = document.getElementById('postCat').value;
    const qs = new URLSearchParams({ page: postState.page, size: postState.size });
    if (kw) qs.set('keyword', kw);
    if (cat) qs.set('category', cat);
    try {
      const d = await api(`/api/posts?${qs}`);
      postState.total = d.total;
      const rows = d.rows || [];
      document.getElementById('postRows').innerHTML = rows.length ? rows.map(p => `
        <tr>
          <td><input type="checkbox" class="post-checkbox" value="${p.id}"></td>
          <td>${p.id}</td>
          <td><a href="/post.html?id=${p.id}" style="color:#2563eb;text-decoration:none">${escapeHtml(p.title)}</a></td>
          <td>${p.category ? `<span class="cat-tag">${escapeHtml(p.category)}</span>` : '—'}</td>
          <td>${escapeHtml(p.author_name)}</td>
          <td>${p.views}</td><td>${p.upvotes}</td><td>${p.comment_count}</td>
          <td>${p.pinned ? '<span class="state-ico">📌</span>' : ''}${p.featured ? '<span class="state-ico">⭐</span>' : ''}${(!p.pinned && !p.featured) ? '—' : ''}</td>
          <td><div class="row-actions">
            <button class="btn btn-warn" onclick="pinPost(${p.id})">${p.pinned ? '取消置顶' : '置顶'}</button>
            <button class="btn btn-warn" onclick="featurePost(${p.id})">${p.featured ? '取消精选' : '精选'}</button>
            <button class="btn btn-danger" onclick="deletePost(${p.id})">删除</button>
          </div></td>
        </tr>`).join('')
        : '<tr><td colspan="10" class="empty">没有符合条件的帖子</td></tr>';

      const totalPages = Math.max(1, Math.ceil(postState.total / postState.size));
      document.getElementById('postPagerInfo').textContent = `共 ${postState.total} 条`;
      document.getElementById('postPageNow').textContent = `${postState.page} / ${totalPages}`;
      document.getElementById('postPrev').disabled = postState.page <= 1;
      document.getElementById('postNext').disabled = postState.page >= totalPages;
    } catch (e) { toast(e.message, true); }
  }

  window.pinPost = async function (id) {
    try { await api(`/api/posts/${id}/pin`, { method: 'POST' }); loadPosts(postState.page); }
    catch (e) { toast(e.message, true); }
  };
  window.featurePost = async function (id) {
    try { await api(`/api/posts/${id}/feature`, { method: 'POST' }); loadPosts(postState.page); }
    catch (e) { toast(e.message, true); }
  };
  window.deletePost = async function (id) {
    if (!confirm('确定删除该帖子及其评论吗？')) return;
    try { await api(`/api/posts/${id}`, { method: 'DELETE' }); toast('已删除'); loadPosts(postState.page); }
    catch (e) { toast(e.message, true); }
  };

  window.toggleAllPosts = function (master) {
    document.querySelectorAll('.post-checkbox').forEach(cb => (cb.checked = master.checked));
  };
  window.batchPosts = async function (action) {
    const ids = Array.from(document.querySelectorAll('.post-checkbox:checked')).map(cb => Number(cb.value));
    if (!ids.length) return toast('请先选择帖子', true);
    const label = action === 'pin' ? '批量置顶' : action === 'feature' ? '批量精选' : '批量删除';
    if (!confirm(`确定${label}这 ${ids.length} 个帖子吗？`)) return;
    try {
      await api('/api/posts/batch', { method: 'POST', body: JSON.stringify({ ids, action }) });
      toast('操作成功');
      document.getElementById('postSelectAll').checked = false;
      loadPosts(postState.page);
    } catch (e) { toast(e.message, true); }
  };

  // ===== 用户管理 =====
  async function loadUsers() {
    try {
      const kw = document.getElementById('userKw').value.trim();
      const filter = document.getElementById('userFilter').value;
      const d = kw
        ? await api(`/api/users/search?keyword=${encodeURIComponent(kw)}`)
        : await api('/api/users');
      const all = d.users || [];
      const list = all.filter(u =>
        !filter ? true
        : filter === 'admin' ? u.role === 'admin'
        : filter === 'banned' ? !!u.is_banned
        : !u.is_banned);
      const me = auth.getUser();
      document.getElementById('userCount').textContent =
        `共 ${list.length} 个账号` + (list.length !== all.length ? `（已从 ${all.length} 条中筛选）` : '');
      document.getElementById('userRows').innerHTML = list.length ? list.map(u => `
        <tr>
          <td><input type="checkbox" class="user-checkbox" value="${u.id}" ${u.id === me.id ? 'disabled' : ''}></td>
          <td>${u.id}</td>
          <td><a href="/user.html?id=${u.id}" target="_blank" style="color:#2563eb;text-decoration:none">@${escapeHtml(u.username)}</a></td>
          <td>${escapeHtml(u.nickname)}</td>
          <td><span class="role-badge ${u.role === 'admin' ? 'role-admin' : 'role-user'}">${u.role === 'admin' ? '🛡 管理员' : '普通用户'}</span></td>
          <td>${u.is_banned ? '<span style="color:#dc2626;font-weight:700">🚫 已封禁</span>' : '<span style="color:#16a34a">正常</span>'}</td>
          <td>${u.created_at}</td>
          <td>${u.id === me.id
            ? '<span style="color:#94a3b8">（自己）</span>'
            : `<div class="row-actions">
                 <button class="btn ${u.is_banned ? 'btn-ghost' : 'btn-danger'}" onclick="toggleBan(${u.id},${u.is_banned ? 0 : 1})">${u.is_banned ? '解封' : '封禁'}</button>
                 <button class="btn ${u.role === 'admin' ? 'btn-danger' : 'btn-warn'}" onclick="setRole(${u.id},'${u.role === 'admin' ? 'user' : 'admin'}')">${u.role === 'admin' ? '取消管理员' : '设为管理员'}</button>
                 <button class="btn btn-danger" onclick="deleteUser(${u.id})">删除</button>
               </div>`}</td>
        </tr>`).join('')
        : '<tr><td colspan="8" class="empty">没有符合条件的用户</td></tr>';
    } catch (e) { toast(e.message, true); }
  }

  window.toggleBan = async function (id, banned) {
    if (!confirm(banned ? '确定封禁该账号吗？封禁后立即无法登录与操作。' : '确定解封该账号吗？')) return;
    try {
      await api(`/api/users/${id}/ban`, { method: 'POST', body: JSON.stringify({ banned: !!banned }) });
      toast(banned ? '已封禁' : '已解封');
      loadUsers();
    } catch (e) { toast(e.message, true); }
  };

  window.toggleAll = function (master) {
    document.querySelectorAll('.user-checkbox').forEach(cb => (cb.checked = master.checked));
  };
  window.deleteUser = async function (id) {
    if (!confirm('确定删除该用户及其所有内容吗？')) return;
    try { await api(`/api/users/${id}`, { method: 'DELETE' }); toast('已删除'); loadUsers(); }
    catch (e) { toast(e.message, true); }
  };
  window.batchDelete = async function () {
    const ids = Array.from(document.querySelectorAll('.user-checkbox:checked')).map(cb => Number(cb.value));
    if (!ids.length) return toast('请先选择用户', true);
    if (!confirm(`确定批量删除 ${ids.length} 个账号吗？`)) return;
    try {
      await api('/api/users/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
      toast(`已删除 ${ids.length} 个账号`); loadUsers();
    } catch (e) { toast(e.message, true); }
  };
  window.setRole = async function (id, role) {
    if (!confirm(`确定将该用户${role === 'admin' ? '设为管理员' : '取消管理员'}吗？`)) return;
    try {
      await api(`/api/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
      toast('操作成功'); loadUsers();
    } catch (e) { toast(e.message, true); }
  };

  // ===== 分类管理 =====
  let categoriesCache = [];
  async function loadCategories() {
    try {
      const d = await api('/api/admin/categories');
      categoriesCache = d.categories || [];
      renderCategories();
    } catch (e) { toast(e.message, true); }
  }
  function renderCategories() {
    document.getElementById('catList').innerHTML = categoriesCache.length ? categoriesCache.map((c, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f1f5f9;flex-wrap:wrap">
        <span style="font-size:13px;color:#94a3b8;width:22px">${i + 1}</span>
        <span style="font-size:14px;font-weight:600;color:#334155;flex:1">${escapeHtml(c)}</span>
        ${i > 0 ? `<button class="btn btn-ghost" onclick="moveCategory(${i},-1)">↑</button>` : '<span style="width:52px"></span>'}
        ${i < categoriesCache.length - 1 ? `<button class="btn btn-ghost" onclick="moveCategory(${i},1)">↓</button>` : '<span style="width:52px"></span>'}
        <button class="btn btn-danger" onclick="removeCategory(${i})">删除</button>
      </div>`).join('')
      : '<div class="empty">暂无分类</div>';
  }
  window.addCategory = async function () {
    const name = document.getElementById('newCat').value.trim();
    if (!name) return toast('请输入分类名称', true);
    if (categoriesCache.includes(name)) return toast('该分类已存在', true);
    categoriesCache.push(name);
    document.getElementById('newCat').value = '';
    await saveCategories();
  };
  window.removeCategory = async function (i) {
    if (!confirm(`确定删除分类「${categoriesCache[i]}」吗？`)) return;
    categoriesCache.splice(i, 1);
    await saveCategories();
  };
  window.moveCategory = async function (i, dir) {
    const j = i + dir;
    if (j < 0 || j >= categoriesCache.length) return;
    [categoriesCache[i], categoriesCache[j]] = [categoriesCache[j], categoriesCache[i]];
    await saveCategories();
  };
  window.resetCategories = async function () {
    if (!confirm('恢复默认分类（壁纸/资源/求助/闲聊）？')) return;
    categoriesCache = ['壁纸', '资源', '求助', '闲聊'];
    await saveCategories();
  };
  async function saveCategories() {
    try {
      await api('/api/admin/categories', { method: 'PUT', body: JSON.stringify({ categories: categoriesCache }) });
      toast('分类已保存');
      renderCategories();
    } catch (e) { toast(e.message, true); }
  }

  // ===== 游戏站管理 =====
  const gameState = { page: 1, size: 20, total: 0 };
  async function loadGameAdmin() {
    try {
      const d = await api('/api/admin/game/stats');
      document.getElementById('g-posts').textContent = d.posts;
      document.getElementById('g-comments').textContent = d.comments;
      document.getElementById('g-likes').textContent = d.postLikes + d.commentLikes;
      document.getElementById('g-pw').textContent = d.passwordSet ? '已设置' : '未设置';
    } catch (e) { toast(e.message, true); }
    loadGamePosts(1);
  }

  // ===== 门禁 / 访问控制 =====
  const gateForm = { enabled: true, ttl: 43200 };
  async function loadGateAdmin() {
    try {
      const d = await api('/api/admin/gate');
      gateForm.enabled = d.enabled !== false;
      gateForm.ttl = Number(d.ttl) || 43200;

      document.getElementById('gate-state').textContent = gateForm.enabled ? '已开启' : '已关闭';
      document.getElementById('gate-state-sub').textContent = gateForm.enabled ? '进站需密码' : '自由进入';
      document.getElementById('gate-pw-state').textContent = d.hasPassword ? (d.usingDefaultPassword ? '默认口令' : '已设置') : '未设置';
      document.getElementById('gate-pw-sub').textContent = d.usingDefaultPassword ? '不安全，请更换' : '';
      const risk = document.getElementById('gate-risk');
      risk.style.display = d.usingDefaultPassword ? 'block' : 'none';
      document.getElementById('gate-ttl-state').textContent = formatTtl(gateForm.ttl);
      document.getElementById('gate-ver-state').textContent = 'v' + (d.version || 1);
      document.getElementById('gate-hint').value = d.hint || '';
      renderGateSeg();
    } catch (e) { toast(e.message, true); }
  }
  function formatTtl(sec) {
    if (sec >= 86400) return Math.round(sec / 86400) + ' 天';
    return Math.round(sec / 3600) + ' 小时';
  }
  function renderGateSeg() {
    const setSeg = (id, value) => {
      document.querySelectorAll(`#${id} button`).forEach(b =>
        b.classList.toggle('active', b.dataset.v === String(value)));
    };
    setSeg('seg-gate-enabled', gateForm.enabled ? 1 : 0);
    setSeg('seg-gate-ttl', gateForm.ttl);
  }
  window.setGateOpt = function (key, value) {
    gateForm[key] = key === 'enabled' ? !!Number(value) : Number(value);
    renderGateSeg();
  };
  window.saveGateConfig = async function () {
    try {
      await api('/api/admin/gate', {
        method: 'PUT',
        body: JSON.stringify({ enabled: gateForm.enabled, ttl: gateForm.ttl }),
      });
      toast('门禁设置已保存');
      loadGateAdmin();
    } catch (e) { toast(e.message, true); }
  };
  window.saveGatePassword = async function () {
    const pw = document.getElementById('gate-new-pw').value.trim();
    if (pw.length < 4 || pw.length > 50) return toast('密码长度需 4-50 位', true);
    if (!confirm('确定修改访问密码？所有已进站用户会立即失效，需重新输入密码。')) return;
    try {
      await api('/api/admin/gate', { method: 'PUT', body: JSON.stringify({ password: pw }) });
      document.getElementById('gate-new-pw').value = '';
      toast('访问密码已更新');
      loadGateAdmin();
    } catch (e) { toast(e.message, true); }
  };
  window.saveGateHint = async function () {
    const hint = document.getElementById('gate-hint').value.trim();
    try {
      await api('/api/admin/gate', { method: 'PUT', body: JSON.stringify({ hint }) });
      toast('门禁提示词已保存');
      loadGateAdmin();
    } catch (e) { toast(e.message, true); }
  };
  window.kickGateSessions = async function () {
    if (!confirm('确定踢出所有已进站的用户？他们需要重新输入访问密码。')) return;
    try {
      const d = await api('/api/admin/gate/kick', { method: 'POST' });
      toast(`已踢出全部进站会话（门禁版本 v${d.version}）`);
      loadGateAdmin();
    } catch (e) { toast(e.message, true); }
  };
  async function loadGamePosts(page = 1) {
    gameState.page = Math.max(1, page);
    const kw = document.getElementById('g-post-kw').value.trim();
    const qs = new URLSearchParams({ page: gameState.page, size: gameState.size });
    if (kw) qs.set('keyword', kw);
    try {
      const d = await api(`/api/admin/game/posts?${qs}`);
      gameState.total = d.total;
      document.getElementById('gamePostRows').innerHTML = (d.rows || []).length ? d.rows.map(p => `
        <tr>
          <td>${p.id}</td>
          <td><a href="/game-post.html?id=${p.id}" target="_blank" style="color:#7c3aed;text-decoration:none">${escapeHtml(p.title)}</a></td>
          <td>${escapeHtml(p.author_name)}</td>
          <td>${p.views}</td><td>${p.upvotes}</td><td>${p.comment_count}</td>
          <td>${p.pinned ? '<span class="state-ico">📌</span>' : ''}${p.featured ? '<span class="state-ico">⭐</span>' : ''}${(!p.pinned && !p.featured) ? '—' : ''}</td>
          <td><div class="row-actions">
            <button class="btn btn-warn" onclick="gamePinPost(${p.id})">${p.pinned ? '取消置顶' : '置顶'}</button>
            <button class="btn btn-warn" onclick="gameFeaturePost(${p.id})">${p.featured ? '取消精选' : '精选'}</button>
            <button class="btn btn-ghost" onclick="gameImages(${p.id})">改图</button>
            <button class="btn btn-danger" onclick="deleteGamePost(${p.id})">删除</button>
          </div></td>
        </tr>`).join('')
        : '<tr><td colspan="8" class="empty">没有游戏分享</td></tr>';
      const totalPages = Math.max(1, Math.ceil(gameState.total / gameState.size));
      document.getElementById('gamePostPagerInfo').textContent = `共 ${gameState.total} 条`;
      document.getElementById('gamePostPageNow').textContent = `${gameState.page} / ${totalPages}`;
    } catch (e) { toast(e.message, true); }
  }
  window.gamePinPost = async function (id) {
    try { await api(`/api/admin/game/posts/${id}/pin`, { method: 'POST' }); loadGamePosts(gameState.page); }
    catch (e) { toast(e.message, true); }
  };
  window.gameFeaturePost = async function (id) {
    try { await api(`/api/admin/game/posts/${id}/feature`, { method: 'POST' }); loadGamePosts(gameState.page); }
    catch (e) { toast(e.message, true); }
  };
  window.deleteGamePost = async function (id) {
    if (!confirm('确定删除该游戏分享及其评论吗？')) return;
    try { await api(`/api/admin/game/posts/${id}`, { method: 'DELETE' }); toast('已删除'); loadGameAdmin(); }
    catch (e) { toast(e.message, true); }
  };
  window.gameImages = async function (id) {
    const raw = prompt('输入图片地址，多张用英文逗号分隔（留空 = 清空图片）\n只接受 /img/xxx 或 https://api.kuhai.de5.net/img/xxx', '');
    if (raw === null) return;
    const list = raw.split(',').map(s => s.trim()).filter(Boolean);
    const re = /^(\/img\/|https:\/\/api\.kuhai\.de5\.net\/img\/)[A-Za-z0-9._-]{1,120}$/;
    const bad = list.filter(u => !re.test(u));
    if (bad.length) return toast('地址不合法：' + bad[0], true);
    if (list.length > 9) return toast('最多 9 张图片', true);
    try {
      await api(`/api/admin/game/posts/${id}/images`, { method: 'PUT', body: JSON.stringify({ images: list }) });
      toast(list.length ? `已更新 ${list.length} 张图片` : '已清空图片');
      loadGamePosts(gameState.page);
    } catch (e) { toast(e.message, true); }
  };

  // ===== 站点文案 =====
  async function loadSiteContentForm() {
    try {
      const d = await api('/api/admin/site-content');
      const c = d.content || {};
      document.getElementById('c-bannerTitle').value = c.bannerTitle || '';
      document.getElementById('c-bannerSubtitle').value = c.bannerSubtitle || '';
      document.getElementById('c-announcement').value = c.announcement || '';
      document.getElementById('c-footerText').value = c.footerText || '';
    } catch (e) { toast(e.message, true); }
  }
  window.saveSiteContent = async function () {
    const content = {
      bannerTitle: document.getElementById('c-bannerTitle').value.trim(),
      bannerSubtitle: document.getElementById('c-bannerSubtitle').value.trim(),
      announcement: document.getElementById('c-announcement').value.trim(),
      footerText: document.getElementById('c-footerText').value.trim(),
    };
    try {
      await api('/api/admin/site-content', { method: 'PUT', body: JSON.stringify({ content }) });
      toast('文案已保存，论坛首页已生效');
    } catch (e) { toast(e.message, true); }
  };
  window.resetSiteContent = function () {
    document.getElementById('c-bannerTitle').value = '金榜题名 · 高考必胜';
    document.getElementById('c-bannerSubtitle').value = '苦海无涯，学海作舟 —— 乾坤未定，你我皆是黑马';
    document.getElementById('c-announcement').value = '';
    document.getElementById('c-footerText').value = '';
    toast('已恢复默认，点击「保存文案」生效');
  };

  // ===== 数据导出 =====
  async function downloadCsv(path, filename) {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${auth.getToken()}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('导出成功');
    } catch (e) { toast(e.message, true); }
  }
  window.exportPosts = function () { downloadCsv('/api/admin/export/posts', 'posts.csv'); };
  window.exportUsers = function () { downloadCsv('/api/admin/export/users', 'users.csv'); };

  // ===== 界面设置 =====
  async function initSettingsForm() {
    await loadDisplaySettings();
    settingsForm = { ...getDisplaySettings() };
    syncSeg('seg-card', settingsForm.cardSize);
    syncSeg('seg-density', settingsForm.density);
    syncSeg('seg-width', String(settingsForm.imageMaxWidth));
    document.getElementById('q-range').value = settingsForm.imageQuality;
    document.getElementById('q-val').textContent = Number(settingsForm.imageQuality).toFixed(2);
  }
  function syncSeg(boxId, val) {
    document.querySelectorAll(`#${boxId} button`).forEach(b =>
      b.classList.toggle('active', b.dataset.v === String(val)));
  }
  window.setOpt = function (key, val) {
    settingsForm[key] = val;
    const box = key === 'cardSize' ? 'seg-card' : key === 'density' ? 'seg-density' : 'seg-width';
    syncSeg(box, val);
  };
  window.onQuality = function (v) {
    settingsForm.imageQuality = Number(v);
    document.getElementById('q-val').textContent = Number(v).toFixed(2);
  };
  window.saveSettings = async function () {
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ settings: settingsForm }) });
      toast('设置已保存并应用');
      await loadDisplaySettings();
    } catch (e) { toast(e.message, true); }
  };
  window.resetSettings = function () {
    settingsForm = {
      cardSize: 'large', density: 'comfortable',
      imageMaxWidth: 1280, imageQuality: 0.8, thumbnailSize: 300,
    };
    syncSeg('seg-card', settingsForm.cardSize);
    syncSeg('seg-density', settingsForm.density);
    syncSeg('seg-width', String(settingsForm.imageMaxWidth));
    document.getElementById('q-range').value = settingsForm.imageQuality;
    document.getElementById('q-val').textContent = settingsForm.imageQuality.toFixed(2);
    toast('已恢复默认，点击「保存设置」生效');
  };

  // ===== 启动 =====
  initAnimatedBackground();
  initMusicPlayer({ tracks: [{ name: 'Follow', url: '/music/01.mp3' }, { name: 'Solaris', url: '/music/02.mp3' }] });
  renderNav();

  if (!auth.isLoggedIn()) { location.href = '/login.html'; }
  else if (auth.getUser().role !== 'admin') {
    document.querySelector('.container').innerHTML = '<div class="card empty">你不是管理员，无权访问管理后台</div>';
  } else {
    // 回到上次的标签页（或地址栏指定的），不再每次都从概览开始
    switchTab(initialTab());
    // 初始化分类下拉（供帖子管理筛选）
    api('/api/admin/stats').then(d => {
      const sel = document.getElementById('postCat');
      const current = sel.value;
      const names = (d.categories || []).map(c => c.name).filter(n => n && n !== '未分类');
      sel.innerHTML = '<option value="">全部分类</option>' +
        names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
      sel.value = current;
    }).catch(() => {});
  }
