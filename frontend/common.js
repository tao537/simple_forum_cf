// 共享的登录态管理：localStorage 存储 token 与用户信息
const TOKEN_KEY = 'forum_token';
const USER_KEY = 'forum_user';

export const auth = {
  getToken() { return localStorage.getItem(TOKEN_KEY) || ''; },
  getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch { return null; }
  },
  isLoggedIn() { return !!this.getToken(); },
  set(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
  nickname() {
    const u = this.getUser();
    return u ? (u.nickname || u.username) : '';
  },
};

// ===== 后端地址配置 =====
// 线上 API（后端 Worker，独立子域名，国内可访问）
export const API_BASE = 'https://api.kuhai.de5.net';
// 本地 API（Linux 上 npx wrangler dev 的默认端口是 8787）
const LOCAL_API_BASE = 'http://localhost:8787';
// 本地前端调试时是否调用本地后端：true = 本地前端→本地后端；false = 本地前端→线上
const USE_LOCAL_API = false;

function resolveBaseUrl() {
  if (window.location.protocol === 'file:') return LOCAL_API_BASE;
  const localHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (localHost && USE_LOCAL_API) return LOCAL_API_BASE;
  return API_BASE;
}

// 统一的请求封装：自动附带 token
export async function api(url, opts = {}) {
  const baseUrl = resolveBaseUrl();
  const fullUrl = `${baseUrl}${url}`;

  const headers = { ...(opts.headers || {}) };
  const token = auth.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  // 15 秒超时：接口异常时明确报错，而不是页面无限"加载中"
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch(fullUrl, { ...opts, headers, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new Error('请求超时，请稍后重试');
    throw e;
  }
  clearTimeout(timer);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function parseImages(images) {
  try {
    const arr = typeof images === 'string' ? JSON.parse(images || '[]') : (images || []);
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch { return []; }
}

// ================================================================
//  娱乐游戏站（与苦海论坛账号完全隔离）
//  进入：统一访问密码 → 服务端签发 scope=game 的 token
//  站内无账号，发帖/评论用访客昵称，点赞用本地访客标识
// ================================================================
const GAME_TOKEN_KEY = 'game_token';
const GAME_NICK_KEY = 'game_nick';
const GAME_VISITOR_KEY = 'game_visitor';
const GAME_USER_KEY = 'game_user';

export const gameAuth = {
  getToken() { return localStorage.getItem(GAME_TOKEN_KEY) || ''; },
  isEntered() { return !!this.getToken(); },
  setToken(t) { localStorage.setItem(GAME_TOKEN_KEY, t); },
  // 登录账号信息（{id,username,nickname,role}），访客为 null
  user() { try { return JSON.parse(localStorage.getItem(GAME_USER_KEY)) || null; } catch { return null; } },
  setUser(u) {
    if (u) localStorage.setItem(GAME_USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(GAME_USER_KEY);
  },
  isLoggedIn() { return !!this.user(); },
  isAdmin() { const u = this.user(); return !!u && u.role === 'admin'; },
  // 退出：清 token + 账号信息，保留访客标识
  clear() { localStorage.removeItem(GAME_TOKEN_KEY); localStorage.removeItem(GAME_USER_KEY); },
  nickname() { return this.user()?.nickname || this.user()?.username || localStorage.getItem(GAME_NICK_KEY) || ''; },
  setNickname(n) { localStorage.setItem(GAME_NICK_KEY, String(n || '').slice(0, 20)); },
  visitorId() {
    let v = localStorage.getItem(GAME_VISITOR_KEY);
    if (!v) {
      v = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(GAME_VISITOR_KEY, v);
    }
    return v;
  },
};

// 游戏站请求封装：自动附带游戏 token（与论坛 api() 完全独立）
export async function gameApi(url, opts = {}) {
  const baseUrl = resolveBaseUrl();
  const fullUrl = `${baseUrl}${url}`;
  const headers = { ...(opts.headers || {}) };
  const token = gameAuth.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(fullUrl, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

// ==================== 界面显示设置（管理员后台可配置）====================
const SETTINGS_KEY = 'forum_settings';
const DEFAULT_SETTINGS = {
  cardSize: 'large',        // large | medium | small
  density: 'comfortable',   // comfortable | compact
  imageMaxWidth: 1280,      // 图片最大宽度 px
  imageQuality: 0.8,        // 压缩质量
  thumbnailSize: 300,       // 缩略图尺寸
};
let displaySettings = null;

function injectSettingsStyle() {
  if (document.getElementById('settingsStyle')) return;
  const style = document.createElement('style');
  style.id = 'settingsStyle';
  style.textContent = `
    /* 帖子卡片大小 */
    body[data-card-size="small"] .post { padding: 11px 14px; }
    body[data-card-size="small"] .post-title { font-size: 14.5px; margin-bottom: 5px; }
    body[data-card-size="small"] .post-summary { -webkit-line-clamp: 1 !important; font-size: 13px; margin-bottom: 7px; }
    body[data-card-size="small"] .thumbs img { width: 54px; height: 54px; }
    body[data-card-size="small"] .post-meta { font-size: 11.5px; gap: 12px; }
    body[data-card-size="medium"] .post { padding: 15px 17px; }
    body[data-card-size="medium"] .post-title { font-size: 16px; }
    body[data-card-size="large"] .post { padding: 18px 20px; }
    /* 布局密度 */
    body[data-density="compact"] .post { margin-bottom: 8px; }
    body[data-density="compact"] .post-summary { margin-bottom: 6px; }
    body[data-density="compact"] .post-meta { gap: 12px; }
    body[data-density="compact"] .post-title { margin-bottom: 5px; }
    /* 游戏卡片大小（游戏板块） */
    body[data-card-size="small"] .game-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
    body[data-card-size="medium"] .game-grid { grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
    body[data-card-size="large"] .game-grid { grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
  `;
  document.head.appendChild(style);
}

function applyDisplaySettings(s) {
  const settings = { ...DEFAULT_SETTINGS, ...s };
  injectSettingsStyle();
  document.body.dataset.cardSize = settings.cardSize;
  document.body.dataset.density = settings.density;
  return settings;
}

// 加载并应用显示设置：先用本地缓存立即应用，再拉取后端更新
export async function loadDisplaySettings() {
  try {
    const cached = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (cached) applyDisplaySettings(cached);
  } catch { /* 无缓存 */ }
  try {
    const data = await api('/api/settings');
    displaySettings = applyDisplaySettings(data.settings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(displaySettings));
  } catch { /* 拉取失败则沿用缓存/默认 */ }
  return displaySettings;
}

export function getDisplaySettings() {
  return displaySettings || { ...DEFAULT_SETTINGS };
}

// ==================== 图片上传前压缩 ====================
// 固定参数（不再读后台显示设置）：最长边 1600px、JPEG 质量 0.75
const UPLOAD_MAX_EDGE = 1600;            // 最长边（宽高取大者）
const UPLOAD_QUALITY = 0.75;             // JPEG 压缩质量
const SKIP_COMPRESS_BYTES = 500 * 1024;  // 小于 500KB 的图跳过压缩直传

export async function processImageForUpload(file) {
  // GIF / SVG 不做 canvas 压缩，原样返回
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  // 已经足够小，直接上传
  if (file.size < SKIP_COMPRESS_BYTES) return file;

  try {
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;
    const longest = Math.max(width, height);          // 按最长边判断
    if (longest > UPLOAD_MAX_EDGE) {
      const scale = UPLOAD_MAX_EDGE / longest;        // 竖图/长图同样会被缩
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', UPLOAD_QUALITY));
    bitmap.close?.();
    // 压缩后反而更大则回退原图
    if (blob && blob.size < file.size) {
      const base = (file.name || 'image').replace(/\.[^.]+$/, '');
      return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
    }
  } catch { /* 压缩失败则回退原图 */ }
  return file;
}

// 渲染带 @提及 高亮的文本（先转义，再高亮 @用户名）
export function renderMentions(text) {
  let html = escapeHtml(text);
  html = html.replace(/@([\u4e00-\u9fa5\w]{2,30})/g, '<span class="mention">@$1</span>');
  return html;
}

// ================================================================
//  轻量 Markdown 渲染（帖子正文）
//
//  为什么需要：AI/云端生成的正文本就是 Markdown（## 小节、- 列表、
//  ![](图)），而页面此前只做 escapeHtml → 整段 Markdown 以源码形式
//  显示出来（`## 🖼 游戏截图`、`![](https://.../img/xxx)` 全是字面量）。
//
//  安全原则：**先整体转义，再只还原白名单语法**。
//  绝不能写成 innerHTML = content —— 那会重新打开 359e712 修掉的
//  存储型 XSS。这里所有输出标签都是本函数自己生成的固定结构，
//  文本内容一律来自转义后的串。
// ================================================================

// 图片白名单：与后端 sanitizeImages / GET /img/:id 用同一套规则，
// 不在白名单里的图片一律降级成纯文本（连请求都不发出去）。
const MD_IMG_RE = /^(\/img\/|https:\/\/api\.kuhai\.de5\.net\/img\/)[A-Za-z0-9._-]{1,120}$/;

/** 只放行 http(s) / 站内相对路径 / mailto，挡掉 javascript:、data: 之类 */
function mdSafeHref(url) {
  if (/^https?:\/\//i.test(url)) return url;
  if (/^mailto:/i.test(url)) return url;
  if (/^\/[^/]/.test(url)) return url;
  return '';
}

// 行内语法。顺序要紧：图片排在链接前面（`![` 里也含 `[`），加粗排在斜体前面，
// 裸 URL（如「网盘链接：https://…」）放最后，避免抢先匹配。
const MD_INLINE_RE = /!\[(?<imgAlt>[^\]]*)\]\((?<imgUrl>[^)\s]+)\)|\[(?<linkText>[^\]]*)\]\((?<linkUrl>[^)\s]+)\)|`(?<code>[^`\n]+)`|\*\*(?<boldA>[^*]+)\*\*|__(?<boldB>[^_]+)__|~~(?<del>[^~]+)~~|\*(?<emA>[^*\n]+)\*|_(?<emB>[^_\n]+)_|@(?<mention>[\u4e00-\u9fa5\w]{2,30})|(?<auto>https?:\/\/[A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]+)/g;

/** 裸 URL 结尾常跟着中文标点或右括号，这些不算链接的一部分 */
const MD_URL_TAIL_RE = /[.,;:!?，。；：！？、）)】」』'"]+$/;

/** 渲染一行里的行内语法；入参必须已经是转义过的文本 */
function mdInline(escaped, mentions) {
  let out = '';
  let last = 0;
  let m;
  MD_INLINE_RE.lastIndex = 0;
  while ((m = MD_INLINE_RE.exec(escaped)) !== null) {
    if (m.index > last) out += escaped.slice(last, m.index);
    const g = m.groups;
    if (g.imgUrl !== undefined) {
      out += MD_IMG_RE.test(g.imgUrl)
        ? `<img src="${g.imgUrl}" alt="${g.imgAlt}" loading="lazy">`
        : (g.imgAlt || g.imgUrl);
    } else if (g.linkUrl !== undefined) {
      const href = mdSafeHref(g.linkUrl);
      out += href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${g.linkText || href}</a>`
        : `${g.linkText || ''}${g.linkUrl}`;
    } else if (g.code !== undefined) {
      out += `<code>${g.code}</code>`;
    } else if (g.boldA !== undefined || g.boldB !== undefined) {
      out += `<strong>${g.boldA ?? g.boldB}</strong>`;
    } else if (g.del !== undefined) {
      out += `<del>${g.del}</del>`;
    } else if (g.emA !== undefined || g.emB !== undefined) {
      out += `<em>${g.emA ?? g.emB}</em>`;
    } else if (g.mention !== undefined && mentions) {
      out += `<span class="mention">@${g.mention}</span>`;
    } else if (g.auto !== undefined) {
      const tail = (g.auto.match(MD_URL_TAIL_RE) || [''])[0];
      const url = tail ? g.auto.slice(0, -tail.length) : g.auto;
      out += url && mdSafeHref(url)
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${tail}`
        : m[0];
    } else {
      out += m[0];
    }
    last = m.index + m[0].length;
  }
  return out + escaped.slice(last);
}

/**
 * 把 Markdown 正文渲染成安全 HTML。
 * 支持：`#` 标题、`-` / `1.` 列表、`>` 引用、``` 代码块、`---` 分隔线、
 *       **粗体**、*斜体*、~~删除线~~、`` `行内代码` ``、[文字](链接)、![](图片)
 * @param {string} text 原始正文
 * @param {{ mentions?: boolean }} [opts] mentions=true 时高亮 @某人（论坛用）
 * @returns {string} 可直接放进 innerHTML 的安全 HTML
 */
export function renderMarkdown(text, opts = {}) {
  const mentions = !!(opts && opts.mentions);
  const src = escapeHtml(String(text ?? '')).replace(/\r\n?/g, '\n');
  if (!src.trim()) return '';

  const out = [];
  let list = '';          // '' | 'ul' | 'ol'
  let fence = false;      // 是否在 ``` 代码块里
  let code = [];
  const closeList = () => { if (list) { out.push(`</${list}>`); list = ''; } };
  const openList = (t) => { if (list !== t) { closeList(); out.push(`<${t}>`); list = t; } };

  for (const line of src.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (fence) { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = []; fence = false; }
      else { closeList(); fence = true; }
      continue;
    }
    if (fence) { code.push(line); continue; }
    if (!line.trim()) { closeList(); continue; }

    // 标题：只从 h2 起，避免和页面自己的 h1（帖子标题）抢层级
    const h = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (h) {
      closeList();
      const lv = Math.min(Math.max(h[1].length, 2), 6);
      out.push(`<h${lv}>${mdInline(h[2], mentions)}</h${lv}>`);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ul) { openList('ul'); out.push(`<li>${mdInline(ul[1], mentions)}</li>`); continue; }

    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ol) { openList('ol'); out.push(`<li>${mdInline(ol[1], mentions)}</li>`); continue; }

    // `>` 已被 escapeHtml 转成 `&gt;`
    const bq = line.match(/^\s*&gt;\s?(.*)$/);
    if (bq) { closeList(); out.push(`<blockquote>${mdInline(bq[1], mentions)}</blockquote>`); continue; }

    closeList();
    out.push(`<p>${mdInline(line, mentions)}</p>`);
  }
  if (fence) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
  closeList();
  return out.join('');
}

// 统一导航栏渲染：登录态 + 通知铃铛
export function renderNav(elId = 'navRight', opts = {}) {
  // 首次渲染时自动加载并应用全站显示设置
  if (!window.__settingsBooted) { window.__settingsBooted = true; loadDisplaySettings(); }

  // 苦海论坛 / 娱乐游戏 跨站点切换链接
  const cross = opts.site === 'game'
    ? `<a class="link" href="/forum.html">⌬ 苦海</a>`
    : `<a class="link" href="/game.html">◈ 娱乐</a>`;

  const box = document.getElementById(elId);
  if (!auth.isLoggedIn()) {
    const here = encodeURIComponent(location.pathname + location.search);
    box.innerHTML = `${cross}<a class="link" href="/login.html?redirect=${here}">登录 / 注册</a>`;
    return;
  }
  const u = auth.getUser();
  const nick = u.nickname || u.username;
  const initial = (nick[0] || '?').toUpperCase();
  const bell = opts.withBell !== false
    ? `<a class="bell" href="/notifications.html" title="消息通知">🔔<span class="bell-count" id="bellCount"></span></a>`
    : '';
  const admin = u.role === 'admin'
    ? `<a class="link" href="/admin.html">⚙️ 管理</a>` : '';
  box.innerHTML = `
    ${cross}
    ${bell}
    ${admin}
    <a class="user-chip" href="/user.html?id=${u.id}">
      <span class="avatar">${escapeHtml(initial)}</span>${escapeHtml(nick)}
    </a>
    <span class="logout" onclick="logout()">退出</span>`;
  if (opts.withBell !== false) refreshUnread();
}

export async function refreshUnread() {
  const el = document.getElementById('bellCount');
  if (!el || !auth.isLoggedIn()) return;
  try {
    const data = await api('/api/notifications/unread');
    const n = data.count || 0;
    el.textContent = n > 0 ? (n > 99 ? '99+' : n) : '';
    el.style.display = n > 0 ? 'flex' : 'none';
  } catch { /* 静默 */ }
}

export function logoutAction(reload = true) {
  auth.clear();
  if (reload) location.reload();
}

// ===== 动态壁纸背景（全站共用，苦海主题）=====
const BG_IMAGES = [
  '/wallpapers/kuhai-sea-v2.jpg',
  '/wallpapers/kuhai-sea.jpg',
];

// 动态背景：多张壁纸缓慢交叉淡入轮播
export function initAnimatedBackground(opts = {}) {
  let bgEl = document.getElementById('animated-bg');
  if (bgEl && bgEl.dataset.init === '1') return; // 已初始化
  const images = opts.images || BG_IMAGES;
  const interval = opts.interval || 9000;

  // 创建背景层
  if (!bgEl) {
    const div = document.createElement('div');
    div.id = 'animated-bg';
    div.innerHTML = images.map((src, i) =>
      `<div class="abg-layer" style="background-image:url('${src}')" data-i="${i}"></div>`
    ).join('');
    document.body.prepend(div);
    bgEl = div;
  }
  const layers = bgEl.querySelectorAll('.abg-layer');
  if (!layers.length) return;
  bgEl.dataset.init = '1';
  let current = 0;
  layers[current].classList.add('show');
  setInterval(() => {
    const next = (current + 1) % layers.length;
    layers[current].classList.remove('show');
    layers[next].classList.add('show');
    current = next;
  }, interval);
}

// ===== 背景音乐播放器（全站共用）=====
export function initMusicPlayer(opts = {}) {
  if (document.getElementById('music-fab') || !opts.tracks?.length) return;
  const tracks = opts.tracks;
  const fab = document.createElement('div');
  fab.id = 'music-fab';
  fab.className = 'music-fab';
  fab.innerHTML = `
    <div class="music-btn" title="背景音乐">
      <span class="music-icon">🎵</span>
      <span class="music-eq"><i></i><i></i><i></i><i></i></span>
    </div>
    <div class="music-panel">
      <div class="music-head">
        <b>背景音乐</b>
        <button class="music-close" onclick="window.__musicClose()">×</button>
      </div>
      <div class="music-song" id="musicSong">♫ 播放中</div>
      <div class="music-controls">
        <button onclick="window.__musicPrev()">⏮</button>
        <button onclick="window.__musicToggle()" id="musicPlayBtn">▶</button>
        <button onclick="window.__musicNext()">⏭</button>
      </div>
      <div class="music-tracks" id="musicTracks"></div>
    </div>`;
  document.body.appendChild(fab);

  // 样式
  const style = document.createElement('style');
  style.textContent = `
    #animated-bg { position: fixed; inset: 0; z-index: -1; overflow: hidden; background: #0f172a; }
    .abg-layer { position: absolute; inset: 0; background-size: cover; background-position: center;
                 opacity: 0; transition: opacity 3.2s ease-in-out; }
    .abg-layer.show { opacity: 1; }
    .music-fab { position: fixed; right: 22px; bottom: 22px; z-index: 100; display: flex;
                 flex-direction: column; align-items: flex-end; gap: 10px; }
    .music-btn { width: 54px; height: 54px; border-radius: 50%; background: linear-gradient(135deg,#3b82f6,#2563eb);
                 color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer;
                 box-shadow: 0 8px 24px rgba(37,99,235,.45); transition: .2s; }
    .music-btn:hover { transform: scale(1.07); }
    .music-icon { font-size: 22px; }
    .music-eq { display: none; gap: 3px; align-items: flex-end; height: 18px; }
    .music-eq i { width: 4px; border-radius: 2px; background: #fff; animation: mgeq 1s infinite ease-in-out; }
    .music-eq i:nth-child(1){animation-delay:0s} .music-eq i:nth-child(2){animation-delay:.2s}
    .music-eq i:nth-child(3){animation-delay:.4s} .music-eq i:nth-child(4){animation-delay:.6s}
    @keyframes mgeq { 0%,100%{height:6px} 50%{height:18px} }
    .music-fab.playing .music-icon { display: none; }
    .music-fab.playing .music-eq { display: flex; }
    .music-panel { display: none; width: 260px; background: rgba(15,23,42,.92); backdrop-filter: blur(10px);
                   border-radius: 14px; padding: 14px; color: #fff; box-shadow: 0 12px 40px rgba(0,0,0,.4); }
    .music-fab.open .music-panel { display: block; }
    .music-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .music-head b { font-size: 14px; }
    .music-close { background: transparent; border: none; color: #94a3b8; font-size: 16px; cursor: pointer; }
    .music-song { font-size: 13px; color: #e2e8f0; margin-bottom: 10px; white-space: nowrap; overflow: hidden;
                  text-overflow: ellipsis; }
    .music-controls { display: flex; justify-content: center; gap: 14px; margin-bottom: 10px; }
    .music-controls button { width: 38px; height: 38px; border-radius: 50%; border: none; cursor: pointer;
                             background: rgba(255,255,255,.12); color: #fff; font-size: 14px; transition: .15s; }
    .music-controls button:hover { background: rgba(255,255,255,.25); }
    #musicPlayBtn { background: linear-gradient(135deg,#3b82f6,#2563eb); width: 44px; height: 44px; font-size: 15px; }
    .music-tracks { display: flex; gap: 6px; flex-wrap: wrap; }
    .music-tracks button { padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,.2);
                           background: transparent; color: #cbd5e1; font-size: 11px; cursor: pointer; }
    .music-tracks button.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }
  `;
  document.head.appendChild(style);

  // 逻辑
  const audio = new Audio();
  let idx = 0;
  let playing = false;
  audio.loop = false;

  function setTrack(i) {
    idx = (i + tracks.length) % tracks.length;
    audio.src = tracks[idx].url;
    document.getElementById('musicSong').textContent = '♫ ' + (tracks[idx].name || '曲目 ' + (idx+1));
    [...document.querySelectorAll('#musicTracks button')].forEach((b, j) =>
      b.classList.toggle('active', j === idx));
    if (playing) audio.play().catch(() => {});
  }
  window.__musicToggle = () => {
    if (!audio.src) setTrack(0);
    if (playing) { audio.pause(); playing = false; }
    else { audio.play().catch(() => {}); playing = true; }
    document.getElementById('musicPlayBtn').textContent = playing ? '⏸' : '▶';
    fab.classList.toggle('playing', playing);
  };
  window.__musicNext = () => { setTrack(idx + 1); if (!playing) { playing = true; audio.play().catch(()=>{}); document.getElementById('musicPlayBtn').textContent='⏸'; fab.classList.add('playing'); } };
  window.__musicPrev = () => { setTrack(idx - 1); if (!playing) { playing = true; audio.play().catch(()=>{}); document.getElementById('musicPlayBtn').textContent='⏸'; fab.classList.add('playing'); } };
  window.__musicClose = () => fab.classList.remove('open');
  audio.addEventListener('ended', () => setTrack(idx + 1));
  fab.querySelector('.music-btn').addEventListener('click', e => {
    e.stopPropagation();
    if (fab.classList.contains('open')) fab.classList.remove('open');
    else fab.classList.add('open');
  });
  fab.addEventListener('click', e => e.stopPropagation());

  const tbox = document.getElementById('musicTracks');
  tracks.forEach((t, i) => {
    const b = document.createElement('button');
    b.textContent = (t.name || '曲目 ' + (i+1)).slice(0, 10);
    b.onclick = () => { if (!playing) { playing = true; } setTrack(i); if (playing) audio.play().catch(()=>{}); document.getElementById('musicPlayBtn').textContent='⏸'; fab.classList.add('playing'); };
    tbox.appendChild(b);
  });
  tbox.firstChild?.classList.add('active');
}
