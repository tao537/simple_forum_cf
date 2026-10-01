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

// 统一的请求封装：自动附带 token
export async function api(url, opts = {}) {
  // 如果是通过文件直接打开 (file://)，则补全后端服务器地址
  const API_BASE = 'https://forum-api.tao537.workers.dev';
  const baseUrl = window.location.protocol === 'file:' ? 'http://localhost:3000' : API_BASE;
  const fullUrl = `${baseUrl}${url}`;

  const headers = { ...(opts.headers || {}) };
  const token = auth.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(fullUrl, { ...opts, headers });
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

// 渲染带 @提及 高亮的文本（先转义，再高亮 @用户名）
export function renderMentions(text) {
  let html = escapeHtml(text);
  html = html.replace(/@([\u4e00-\u9fa5\w]{2,30})/g, '<span class="mention">@$1</span>');
  return html;
}

// 统一导航栏渲染：登录态 + 通知铃铛
export function renderNav(elId = 'navRight', opts = {}) {
  const box = document.getElementById(elId);
  if (!auth.isLoggedIn()) {
    box.innerHTML = `<a class="link" href="/login.html">登录 / 注册</a>`;
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

// ===== 动态壁纸背景（全站共用）=====
const BG_IMAGES = [
  '/wallpapers/01_gettyimages-497901028_super_resized.jpg',
  '/wallpapers/02_gettyimages-590973341_super_resized.jpg',
  '/wallpapers/03_gettyimages-623766552_high_resized.jpg',
  '/wallpapers/04_gettyimages-824846456_super_resized.jpg',
  '/wallpapers/05_gettyimages-510212188_super_resized.jpg',
  '/wallpapers/06_gettyimages-599102116_super_resized.jpg',
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
