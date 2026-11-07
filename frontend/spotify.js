// ================================================================
//  Spotify 内嵌播放面板（独立小模块，零依赖）
//  --------------------------------------------------------------
//  设计取舍：不做 OAuth / Web Playback SDK。
//    那套要 Premium 账号 + 在 Spotify 后台登记 redirect URI + 客户端密钥，
//    而这个站点没有构建步骤、也不能把密钥放前端。
//  改用官方 embed：只要一个可访问的链接，就能播歌单/单曲/专辑/艺人页。
//
//  对外只暴露两个东西：
//    parseSpotify(input)  → { type, id } | null      （纯函数，可单独测）
//    mountSpotify(root)   → 把面板绑到指定容器上      （谁想用谁 import）
// ================================================================

const TYPES = ['playlist', 'track', 'album', 'artist', 'episode', 'show'];
const STORE_KEY = 'kuhai_spotify_items';
const MAX_ITEMS = 8;

/**
 * 把各种形态的 Spotify 输入归一成 { type, id }
 * 支持：网页链接（含 /intl-xx/ 前缀与 ?si= 参数）、spotify:type:id、裸 URI
 */
export function parseSpotify(input) {
  const s = String(input || '').trim();
  if (!s) return null;

  // spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
  const uri = s.match(/^spotify:([a-z]+):([A-Za-z0-9]+)$/);
  if (uri && TYPES.includes(uri[1])) return { type: uri[1], id: uri[2] };

  // https://open.spotify.com/[intl-xx/]type/id[?si=...]
  const url = s.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?([a-z]+)\/([A-Za-z0-9]+)/);
  if (url && TYPES.includes(url[1])) return { type: url[1], id: url[2] };

  return null;
}

/** 生成官方 embed 地址（theme=0 跟随播放器明暗，避免白底晃眼） */
export function embedUrl(type, id) {
  return `https://open.spotify.com/embed/${type}/${id}?utm_source=generator&theme=0`;
}

const LABEL = {
  playlist: '歌单', track: '单曲', album: '专辑',
  artist: '艺人', episode: '播客单集', show: '播客',
};

function loadItems() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((it) => it && TYPES.includes(it.type) && typeof it.id === 'string').slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

function saveItems(items) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
  } catch {
    /* 隐私模式或配额满，忽略即可，不影响本次播放 */
  }
}

/**
 * 把面板挂到 root 上。root 里需要这些元素（id 固定，便于其它板块复用同一份 markup）：
 *   spInput / spLoad / spMsg / spChips / spFrame
 */
export function mountSpotify(root) {
  if (!root) return;
  const input = root.querySelector('#spInput');
  const loadBtn = root.querySelector('#spLoad');
  const msg = root.querySelector('#spMsg');
  const chips = root.querySelector('#spChips');
  const frame = root.querySelector('#spFrame');
  if (!input || !loadBtn || !frame) return;

  let items = loadItems();

  const say = (text, isErr = false) => {
    if (!msg) return;
    msg.textContent = text;
    msg.classList.toggle('err', !!isErr);
  };

  const render = () => {
    if (chips) {
      chips.innerHTML = items.map((it, i) => `
        <button class="sp-chip${i === 0 ? ' active' : ''}" data-i="${i}" title="切到这一项">
          ${LABEL[it.type] || it.type} · ${it.id.slice(0, 6)}…
        </button>`).join('');
      chips.querySelectorAll('.sp-chip').forEach((btn) => {
        btn.addEventListener('click', () => {
          const i = Number(btn.dataset.i);
          const it = items[i];
          if (!it) return;
          items = [it, ...items.filter((x) => x !== it)];
          saveItems(items);
          render();
        });
      });
    }

    const cur = items[0];
    if (!cur) {
      frame.innerHTML = '<div class="sp-empty">还没有载入内容。把歌单链接粘到上面，或先试一个公开歌单。</div>';
      return;
    }
    // 只在内容变化时重建 iframe，避免每次点击都让正在播的歌重头开始
    const want = embedUrl(cur.type, cur.id);
    const existing = frame.querySelector('iframe');
    if (existing && existing.dataset.src === want) return;
    frame.innerHTML = `<iframe data-src="${want}" src="${want}" width="100%" height="352"
      frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
      loading="lazy" title="Spotify 内嵌播放"></iframe>`;
  };

  const add = (raw) => {
    const parsed = parseSpotify(raw);
    if (!parsed) {
      say('没认出这是 Spotify 链接。支持 open.spotify.com/playlist|track|album|artist/… 或 spotify:type:id。', true);
      return false;
    }
    items = [parsed, ...items.filter((x) => !(x.type === parsed.type && x.id === parsed.id))];
    saveItems(items);
    say(`已载入：${LABEL[parsed.type] || parsed.type} ${parsed.id}`);
    render();
    input.value = '';
    return true;
  };

  loadBtn.addEventListener('click', () => add(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); add(input.value); }
  });

  render();
  return { add, items: () => items };
}
