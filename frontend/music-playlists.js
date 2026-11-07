// ================================================================
//  歌单模块（音乐板块专用）
//  --------------------------------------------------------------
//  为什么单独一个文件而不是塞进 music.html：
//  播放引擎（解析播放地址、进度、跨页续播）和"歌单数据"是两件事，
//  一个管声音，一个管收藏。混在一个文件里，改歌单布局时会碰到播放逻辑。
//
//  数据模型：localStorage `music_playlists_v2`
//    { lists: [{ id, name, createdAt, songs: [song…] }], active: id }
//  向后兼容：老版本只有一条扁平歌单 `music_playlist`，首次进来时
//  迁移成「我的收藏」这一张歌单，不丢歌。
//
//  对外只暴露 Playlists（数据）与 mountPlaylistPanel（界面），
//  页面通过 onChange 拿到"当前歌单的歌"，用它驱动上一首/下一首。
// ================================================================

const STORE_KEY = 'music_playlists_v2';
const LEGACY_KEY = 'music_playlist';

let state = null;
let listeners = [];
let nowIndex = -1;
let nowPlaying = false;
let panelEl = null;
let onPlayCb = null;

function uid() {
  return 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function snap(song) {
  return {
    id: song.id || song.name,
    name: song.name || '未知歌曲',
    artist: song.artist || '',
    artwork: song.artwork || '',
    preview: song.preview || '',
    urlId: song.urlId || '',
    source: song.source || 'netease',
  };
}

function load() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { /* 坏数据当没有 */ }

  if (raw && Array.isArray(raw.lists) && raw.lists.length) {
    state = {
      lists: raw.lists.map((l) => ({
        id: l.id || uid(),
        name: l.name || '未命名歌单',
        createdAt: l.createdAt || Date.now(),
        songs: Array.isArray(l.songs) ? l.songs.map(snap) : [],
      })),
      active: raw.active,
    };
    if (!state.lists.some((l) => l.id === state.active)) state.active = state.lists[0].id;
    return;
  }

  // 首次 / 老数据迁移
  let legacy = [];
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]'); } catch { /* 忽略 */ }
  const first = { id: uid(), name: '我的收藏', createdAt: Date.now(), songs: Array.isArray(legacy) ? legacy.map(snap) : [] };
  state = { lists: [first], active: first.id };
  save();
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* 隐私模式忽略 */ }
}

function emit() {
  const actsongs = Playlists.songs();
  listeners.forEach((fn) => {
    try { fn(actsongs, Playlists.active()); } catch (e) { console.error('[歌单] 回调失败', e); }
  });
  render();
}

function activeList() {
  if (!state) load();
  return state.lists.find((l) => l.id === state.active) || state.lists[0];
}

export const Playlists = {
  /** 全部歌单（只读快照） */
  all() { if (!state) load(); return state.lists.slice(); },

  active() { return activeList(); },

  /** 当前歌单的所有歌 */
  songs() { return activeList().songs.slice(); },

  setActive(id) {
    if (!state.lists.some((l) => l.id === id)) return;
    state.active = id;
    nowIndex = -1;
    save();
    emit();
  },

  create(name) {
    const nm = String(name || '').trim().slice(0, 20);
    if (!nm) return null;
    if (state.lists.some((l) => l.name === nm)) return null;
    const l = { id: uid(), name: nm, createdAt: Date.now(), songs: [] };
    state.lists.push(l);
    state.active = l.id;
    nowIndex = -1;
    save();
    emit();
    return l;
  },

  rename(id, name) {
    const nm = String(name || '').trim().slice(0, 20);
    if (!nm) return false;
    const l = state.lists.find((x) => x.id === id);
    if (!l) return false;
    l.name = nm;
    save();
    emit();
    return true;
  },

  /** 删掉一张歌单；只剩最后一张时不允许删，避免删成空页面 */
  remove(id) {
    if (state.lists.length <= 1) return false;
    const i = state.lists.findIndex((x) => x.id === id);
    if (i < 0) return false;
    state.lists.splice(i, 1);
    if (state.active === id) state.active = state.lists[0].id;
    nowIndex = -1;
    save();
    emit();
    return true;
  },

  clearActive() {
    activeList().songs = [];
    nowIndex = -1;
    save();
    emit();
    return true;
  },

  /**
   * 加一首进指定歌单（默认当前歌单）
   * @returns {'added'|'duplicate'|'no-target'}
   */
  addSong(song, listId) {
    if (!song) return 'no-target';
    const l = listId ? state.lists.find((x) => x.id === listId) : activeList();
    if (!l) return 'no-target';
    const s = snap(song);
    if (l.songs.some((x) => String(x.id) === String(s.id))) return 'duplicate';
    l.songs.push(s);
    save();
    emit();
    return 'added';
  },

  removeSong(index, listId) {
    const l = listId ? state.lists.find((x) => x.id === listId) : activeList();
    if (!l || index < 0 || index >= l.songs.length) return false;
    l.songs.splice(index, 1);
    if (l.id === state.active && nowIndex >= l.songs.length) nowIndex = -1;
    save();
    emit();
    return true;
  },

  /** 页面注册"当前歌单变了"的回调 */
  onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  },

  /** 播放高亮：哪一首在放 */
  setNowPlaying(index, playing) {
    nowIndex = Number.isInteger(index) ? index : -1;
    nowPlaying = !!playing;
    render();
  },
};

// ---------------------------------------------------------------
//  界面：侧栏面板
// ---------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  if (!panelEl) return;
  const list = activeList();
  const all = state.lists;
  const songs = list.songs;

  const chips = all.map((l) => `
    <button class="pl-chip ${l.id === list.id ? 'on' : ''}" data-act="switch" data-id="${esc(l.id)}">
      ${esc(l.name)}<i>${l.songs.length}</i>
    </button>`).join('');

  const rows = songs.map((s, i) => `
    <li class="pl-song ${i === nowIndex ? 'now' : ''}" data-act="play" data-i="${i}">
      <span class="pl-idx">${i === nowIndex && nowPlaying ? '♪' : i + 1}</span>
      <span class="pl-cover">${s.artwork ? `<img src="${esc(s.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '♪'}</span>
      <span class="pl-meta">
        <b>${esc(s.name)}</b>
        <em>${esc(s.artist || '未知歌手')}</em>
      </span>
      <button class="pl-del" data-act="del" data-i="${i}" title="从歌单移除">✕</button>
    </li>`).join('');

  panelEl.innerHTML = `
    <div class="pl-head">
      <div>
        <div class="pl-kind">PLAYLIST</div>
        <div class="pl-title">我的歌单</div>
      </div>
      <button class="pl-new" data-act="new">＋ 新建</button>
    </div>
    <div class="pl-chips">${chips}</div>
    <div class="pl-bar">
      <span><b>${esc(list.name)}</b> · ${songs.length} 首</span>
      <span class="pl-tools">
        <button data-act="rename">改名字</button>
        <button data-act="clear">清空</button>
        <button data-act="remove">删歌单</button>
      </span>
    </div>
    ${songs.length ? `<ul class="pl-songs">${rows}</ul>`
      : `<div class="pl-empty">这张歌单还是空的。<br>在右边搜索结果或热门卡片上点 <b>＋</b> 就能加进来。</div>`}
  `;
}

function bind() {
  if (!panelEl) return;

  panelEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'switch') {
      Playlists.setActive(btn.dataset.id);
      return;
    }
    if (act === 'play') {
      const i = Number(btn.dataset.i);
      if (onPlayCb) onPlayCb(i);
      return;
    }
    if (act === 'del') {
      e.stopPropagation();
      Playlists.removeSong(Number(btn.dataset.i));
      return;
    }
    if (act === 'new') {
      const name = prompt('新歌单的名字', '新歌单');
      if (name === null) return;
      if (!Playlists.create(name)) alert('名字不能为空，也不能和已有的重名');
      return;
    }
    if (act === 'rename') {
      const cur = Playlists.active().name;
      const name = prompt('改成什么名字', cur);
      if (name === null) return;
      if (!Playlists.rename(Playlists.active().id, name)) alert('名字不能为空');
      return;
    }
    if (act === 'clear') {
      if (!confirm('清空「' + Playlists.active().name + '」里的所有歌？')) return;
      Playlists.clearActive();
      return;
    }
    if (act === 'remove') {
      const cur = Playlists.active();
      if (!confirm('删除歌单「' + cur.name + '」及里面的 ' + cur.songs.length + ' 首歌？')) return;
      if (!Playlists.remove(cur.id)) alert('至少要留一张歌单');
      return;
    }
  });
}

/**
 * 挂载侧栏歌单面板
 * @param {HTMLElement} el 容器
 * @param {{onPlay:(i:number)=>void}} opts 点歌回调
 */
export function mountPlaylistPanel(el, opts = {}) {
  if (!el) return;
  panelEl = el;
  onPlayCb = typeof opts.onPlay === 'function' ? opts.onPlay : null;
  if (!state) load();
  bind();
  render();
}
