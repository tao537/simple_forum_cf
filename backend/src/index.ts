import { Hono } from 'hono';
import { cors } from 'hono/cors';

// 共享内核：安全 / 鉴权，各管一件事，被各领域模块按需引用
import type { Env } from './types';
import { validateCredentials, hashPassword, verifyPassword, BAD_PASSWORDS } from './lib/security';
import { issueToken, getAuth, isAdmin, TOKEN_TTL_SECONDS } from './lib/auth';
// 领域模块：门禁、媒体代理、论坛帖子、游戏帖子、站点配置；各自独立、互不依赖
import gateRoutes, { requireGate, loadGate } from './modules/gate';
import mediaRoutes from './modules/media';
import postRoutes from './modules/posts';
import gamePostRoutes from './modules/game-posts';
import siteRoutes from './modules/site';

const app = new Hono<Env>();

app.use('*', cors({
  origin: ['https://kuhai.de5.net', 'https://www.kuhai.de5.net', 'https://api.kuhai.de5.net'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Gate-Token'],
  maxAge: 600,
}));

app.route('/', gateRoutes);
app.route('/', mediaRoutes);
app.route('/', postRoutes);
app.route('/', gamePostRoutes);
app.route('/', siteRoutes);

// ==================== 健康检查 ====================
app.get('/', (c) => c.json({ ok: true, service: 'forum-api' }));

// ==================== 认证 ====================
const handleRegister = async (c: any) => {
  const { username, email, password, nickname } = await c.req.json();

  const credError = validateCredentials(username, password);
  if (credError) return c.json({ message: credError }, 400);

  const finalEmail = email || `${username}@local`;

  const db = c.env.DB;
  const exists = await db
    .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .bind(username, finalEmail)
    .first();

  if (exists) return c.json({ message: '用户名或邮箱已被注册' }, 409);

  const hash = await hashPassword(password);
  // 新用户一律为普通角色，管理员由数据库手工授予
  const role = 'user';

  const result = await db
    .prepare('INSERT INTO users (username, email, password_hash, nickname, role) VALUES (?, ?, ?, ?, ?)')
    .bind(username, finalEmail, hash, nickname || '', role)
    .run();

  const id = result.meta.last_row_id as number;
  const token = await issueToken(c, { id, username, role });
  return c.json({ token, user: { id, username, nickname: nickname || '', role } }, 201);
};

const handleLogin = async (c: any) => {
  const { username: identifier, password } = await c.req.json();
  const db = c.env.DB;

  const user = await db
    .prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .bind(identifier, identifier)
    .first<{ id: number; username: string; nickname: string; role: string; password_hash: string; is_banned: number }>();

  if (!user) return c.json({ message: '用户名或密码错误' }, 401);
  if (user.is_banned) return c.json({ message: '账号已被封禁' }, 403);

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return c.json({ message: '用户名或密码错误' }, 401);

  const token = await issueToken(c, { id: user.id, username: user.username, role: user.role });
  return c.json({
    token,
    user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role },
  });
};

// 注册路由：/api/auth/* 为原路径，/api/users/* 为前端兼容路径（共用同一处理函数）
app.post('/api/auth/register', handleRegister);
app.post('/api/users/register', handleRegister);
app.post('/api/auth/login', handleLogin);
app.post('/api/users/login', handleLogin);

app.get('/api/auth/me', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '未登录' }, 401);
  return c.json({ user: payload });
});

// ==================== 用户管理（管理员）====================
app.get('/api/users', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const db = c.env.DB;
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const { results } = await db
    .prepare(
      'SELECT id, username, nickname, email, role, is_banned, created_at FROM users ORDER BY id ASC'
    )
    .all();
  return c.json({ users: results });
});

app.delete('/api/users/:id', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const db = c.env.DB;
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const id = Number(c.req.param('id'));
  if (id === payload.id) return c.json({ message: '不能删除自己' }, 400);

  const target = await db.prepare('SELECT id FROM users WHERE id = ?').bind(id).first<{ id: number }>();
  if (!target) return c.json({ message: '用户不存在' }, 404);

  await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

app.post('/api/users/batch-delete', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const db = c.env.DB;
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const { ids } = await c.req.json();
  const list = Array.isArray(ids) ? ids.map((v) => Number(v)).filter((v) => Number.isInteger(v)) : [];
  if (list.length === 0) return c.json({ message: '请提供要删除的用户 id 列表' }, 400);
  if (list.includes(payload.id)) return c.json({ message: '不能删除自己' }, 400);

  const placeholders = list.map(() => '?').join(',');
  const result = await db
    .prepare(`DELETE FROM users WHERE id IN (${placeholders})`)
    .bind(...list)
    .run();
  return c.json({ ok: true, deleted: result.meta.changes ?? 0 });
});

app.patch('/api/users/:id/role', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const db = c.env.DB;
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const id = Number(c.req.param('id'));
  if (id === payload.id) return c.json({ message: '不能修改自己的角色' }, 400);

  const { role } = await c.req.json();
  if (role !== 'admin' && role !== 'user') {
    return c.json({ message: '角色只能是 admin 或 user' }, 400);
  }

  const target = await db.prepare('SELECT id FROM users WHERE id = ?').bind(id).first<{ id: number }>();
  if (!target) return c.json({ message: '用户不存在' }, 404);

  await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id).run();
  return c.json({ ok: true });
});

// ==================== 个人主页 ====================
app.get('/api/users/:id/profile', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;

  const user = await db
    .prepare('SELECT id, username, nickname, avatar, role, created_at FROM users WHERE id = ?')
    .bind(id)
    .first();
  if (!user) return c.json({ message: '用户不存在' }, 404);

  const postsTotal = await db
    .prepare('SELECT COUNT(*) AS n FROM posts WHERE author_id = ?')
    .bind(id)
    .first<{ n: number }>();
  const commentsTotal = await db
    .prepare('SELECT COUNT(*) AS n FROM comments WHERE user_id = ?')
    .bind(id)
    .first<{ n: number }>();
  const likesTotal = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM comment_likes cl JOIN comments c ON c.id = cl.comment_id WHERE c.user_id = ?`
    )
    .bind(id)
    .first<{ n: number }>();

  const { results: posts } = await db
    .prepare(
      `SELECT p.id, p.title, p.content, p.images, p.views,
              p.is_pinned AS pinned, p.is_featured AS featured,
              (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS upvotes,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
              p.created_at
       FROM posts p WHERE p.author_id = ? ORDER BY p.id DESC LIMIT 20`
    )
    .bind(id)
    .all();

  const { results: comments } = await db
    .prepare(
      `SELECT c.id, c.post_id, p.title AS post_title, c.content, c.created_at,
              (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS upvotes
       FROM comments c LEFT JOIN posts p ON p.id = c.post_id
       WHERE c.user_id = ? ORDER BY c.id DESC LIMIT 20`
    )
    .bind(id)
    .all();

  return c.json({
    user,
    stats: {
      posts: postsTotal?.n ?? 0,
      comments: commentsTotal?.n ?? 0,
      likes: likesTotal?.n ?? 0,
    },
    posts,
    comments,
  });
});

// ==================== 通知 ====================
app.get('/api/notifications', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const { results } = await c.env.DB
    .prepare(
      `SELECT n.id, n.type, n.content, n.is_read, n.created_at, n.post_id,
              u.username AS from_name
       FROM notifications n LEFT JOIN users u ON u.id = n.from_user_id
       WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 50`
    )
    .bind(payload.id)
    .all();

  return c.json({ items: results });
});

app.get('/api/notifications/unread', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const row = await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
    .bind(payload.id)
    .first<{ n: number }>();
  return c.json({ count: row?.n ?? 0 });
});

// 前端使用 POST；原实现为 PUT，已对齐
app.post('/api/notifications/:id/read', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const id = Number(c.req.param('id'));
  const db = c.env.DB;

  const row = await db
    .prepare('SELECT id FROM notifications WHERE id = ? AND user_id = ?')
    .bind(id, payload.id)
    .first<{ id: number }>();
  if (!row) return c.json({ message: '通知不存在' }, 404);

  await db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').bind(id, payload.id).run();
  return c.json({ ok: true });
});

app.post('/api/notifications/all/read', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  await c.env.DB
    .prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0')
    .bind(payload.id)
    .run();
  return c.json({ ok: true });
});

// ==================== 管理统计仪表盘 ====================
app.get('/api/admin/stats', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const db = c.env.DB;
  const count = async (sql: string): Promise<number> =>
    (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;

  const users = await count('SELECT COUNT(*) AS n FROM users');
  const posts = await count('SELECT COUNT(*) AS n FROM posts');
  const comments = await count('SELECT COUNT(*) AS n FROM comments');
  const postLikes = await count('SELECT COUNT(*) AS n FROM post_likes');
  const commentLikes = await count('SELECT COUNT(*) AS n FROM comment_likes');
  const newUsersToday = await count("SELECT COUNT(*) AS n FROM users WHERE date(created_at) = date('now','localtime')");
  const newPostsToday = await count("SELECT COUNT(*) AS n FROM posts WHERE date(created_at) = date('now','localtime')");
  const banned = await count('SELECT COUNT(*) AS n FROM users WHERE is_banned = 1');

  const { results: categories } = await db
    .prepare(
      "SELECT CASE WHEN category = '' THEN '未分类' ELSE category END AS name, COUNT(*) AS count FROM posts GROUP BY category ORDER BY count DESC"
    )
    .all();

  const { results: topPosts } = await db
    .prepare(
      `SELECT p.id, p.title, p.views,
              (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS upvotes,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
       FROM posts p ORDER BY p.views DESC LIMIT 8`
    )
    .all();

  return c.json({
    users, posts, comments, postLikes, commentLikes,
    newUsersToday, newPostsToday, banned,
    categories: categories as any,
    topPosts: topPosts as any,
  });
});

// ==================== 修改密码 ====================
app.put('/api/users/password', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const { oldPassword, newPassword } = await c.req.json();
  if (!oldPassword || !newPassword) {
    return c.json({ message: '原密码和新密码不能为空' }, 400);
  }
  if (String(newPassword).length < 8) {
    return c.json({ message: '新密码长度至少 8 位' }, 400);
  }
  if (BAD_PASSWORDS.has(String(newPassword).toLowerCase())) {
    return c.json({ message: '新密码过于简单' }, 400);
  }

  const db = c.env.DB;
  const user = await db
    .prepare('SELECT id, password_hash FROM users WHERE id = ?')
    .bind(payload.id)
    .first<{ id: number; password_hash: string }>();
  if (!user) return c.json({ message: '用户不存在' }, 404);

  const ok = await verifyPassword(oldPassword, user.password_hash);
  if (!ok) return c.json({ message: '原密码错误' }, 401);

  const hash = await hashPassword(newPassword);
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, payload.id).run();
  return c.json({ ok: true });
});

// 游戏站注册（账号已与论坛统一，写入 forum-db.users；先进站后可注册）
// 合并后不再"首账号自动 admin"：游戏管理员即统一 role=admin 用户（论坛管理员天然可管理游戏站）
app.post('/api/game/register', async (c) => {
  if (!(await requireGate(c))) return c.json({ message: '请输入访问密码进入游戏站' }, 401);
  const { username, password, nickname, email } = await c.req.json();
  const name = String(username || '').trim();
  const pw = String(password || '');
  const nick = String(nickname || '').trim().slice(0, 20) || name;
  if (!/^[a-zA-Z0-9_\-\u4e00-\u9fa5]{2,20}$/.test(name)) {
    return c.json({ message: '用户名需 2-20 位（字母/数字/下划线/中文）' }, 400);
  }
  if (pw.length < 6) return c.json({ message: '密码至少 6 位' }, 400);
  // email：用户填了就校验，没填自动生成占位（以后可在个人资料补）
  let mail = String(email || '').trim();
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return c.json({ message: '邮箱格式不正确' }, 400);
  }
  const db = c.env.DB;
  if (!mail) {
    const randHex = (n) => {
      const b = new Uint8Array(n);
      crypto.getRandomValues(b);
      return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, n);
    };
    do { mail = `game_${randHex(8)}@kuhai.local`; }
    while (await db.prepare('SELECT id FROM users WHERE email = ?').bind(mail).first());
  }
  const role = 'user';
  const hash = await hashPassword(pw);
  try {
    await db
      .prepare('INSERT INTO users (username, email, password_hash, nickname, role) VALUES (?, ?, ?, ?, ?)')
      .bind(name, mail, hash, nick, role)
      .run();
  } catch {
    return c.json({ message: '用户名或邮箱已被注册' }, 409);
  }
  return c.json({ ok: true, role, message: '注册成功，请登录' });
});

// 游戏站登录（账号已与论坛统一；成功后签发统一 token，可在论坛/游戏站通用）
app.post('/api/game/login', async (c) => {
  if (!(await requireGate(c))) return c.json({ message: '请输入访问密码进入游戏站' }, 401);
  const { username, password } = await c.req.json();
  const db = c.env.DB;
  const user = await db
    .prepare('SELECT * FROM users WHERE username = ?')
    .bind(String(username || '').trim())
    .first<any>();
  if (!user || !(await verifyPassword(String(password || ''), user.password_hash))) {
    return c.json({ message: '账号或密码错误' }, 401);
  }
  if (user.is_banned) return c.json({ message: '账号已被封禁' }, 403);
  const token = await issueToken(c, user); // 统一 token（SSO）
  return c.json({
    token,
    expiresIn: TOKEN_TTL_SECONDS,
    user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role },
  });
});

// ================================================================
//  管理后台增强接口（论坛管理员身份，走主库 DB）
// ================================================================

// ===== 游戏站管理 =====
app.get('/api/admin/game/stats', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const db = c.env.DB;
  const count = async (sql: string): Promise<number> =>
    (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;

  const posts = await count('SELECT COUNT(*) AS n FROM game_posts');
  const comments = await count('SELECT COUNT(*) AS n FROM game_comments');
  const postLikes = await count('SELECT COUNT(*) AS n FROM game_post_likes');
  const commentLikes = await count('SELECT COUNT(*) AS n FROM game_comment_likes');
  const newPostsToday = await count("SELECT COUNT(*) AS n FROM game_posts WHERE date(created_at) = date('now','localtime')");

  const gate = await loadGate(db);
  return c.json({
    posts, comments, postLikes, commentLikes, newPostsToday,
    passwordSet: !!gate.passwordHash,
    gateEnabled: gate.enabled,
  });
});

app.get('/api/admin/game/posts', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const db = c.env.DB;
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const size = Math.min(Number(c.req.query('size')) || 20, 100);
  const offset = (page - 1) * size;
  const keyword = (c.req.query('keyword') || '').trim();

  const where: string[] = [];
  const binds: any[] = [];
  if (keyword) { where.push('(title LIKE ? OR content LIKE ?)'); const kw = `%${keyword}%`; binds.push(kw, kw); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { results } = await db
    .prepare(
      `SELECT id, title, author_name, views,
              (SELECT COUNT(*) FROM game_post_likes pl WHERE pl.post_id = p.id) AS upvotes,
              (SELECT COUNT(*) FROM game_comments c WHERE c.post_id = p.id) AS comment_count,
              is_pinned AS pinned, is_featured AS featured, created_at
       FROM game_posts p ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .bind(...binds, size, offset)
    .all();

  const total = await db
    .prepare(`SELECT COUNT(*) AS n FROM game_posts p ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();

  return c.json({ rows: results, page, size, total: total?.n ?? 0 });
});

app.delete('/api/admin/game/posts/:id', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const id = Number(c.req.param('id'));
  const result = await c.env.DB.prepare('DELETE FROM game_posts WHERE id = ?').bind(id).run();
  if (!result.meta.changes) return c.json({ message: '帖子不存在' }, 404);
  return c.json({ ok: true });
});

// 管理后台专用：游戏帖置顶/精选（仅需论坛管理员身份，不依赖游戏 token）
app.post('/api/admin/game/posts/:id/pin', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const id = Number(c.req.param('id'));
  const result = await c.env.DB
    .prepare('UPDATE game_posts SET is_pinned = CASE is_pinned WHEN 0 THEN 1 ELSE 0 END WHERE id = ?')
    .bind(id)
    .run();
  if (!result.meta.changes) return c.json({ message: '帖子不存在' }, 404);
  const row = await c.env.DB.prepare('SELECT is_pinned FROM game_posts WHERE id = ?').bind(id).first<{ is_pinned: number }>();
  return c.json({ pinned: !!row?.is_pinned });
});

app.post('/api/admin/game/posts/:id/feature', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const id = Number(c.req.param('id'));
  const result = await c.env.DB
    .prepare('UPDATE game_posts SET is_featured = CASE is_featured WHEN 0 THEN 1 ELSE 0 END WHERE id = ?')
    .bind(id)
    .run();
  if (!result.meta.changes) return c.json({ message: '帖子不存在' }, 404);
  const row = await c.env.DB.prepare('SELECT is_featured FROM game_posts WHERE id = ?').bind(id).first<{ is_featured: number }>();
  return c.json({ featured: !!row?.is_featured });
});

// 更新帖子图片
app.put('/api/admin/game/posts/:id/images', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const id = Number(c.req.param('id'));
  const { images } = await c.req.json();
  if (!Array.isArray(images)) return c.json({ message: 'images 必须是数组' }, 400);

  const result = await c.env.DB
    .prepare('UPDATE game_posts SET images = ? WHERE id = ?')
    .bind(JSON.stringify(images), id)
    .run();
  if (!result.meta.changes) return c.json({ message: '帖子不存在' }, 404);
  return c.json({ ok: true, images });
});

// ===== 用户管理增强：搜索 / 封禁 =====
app.get('/api/users/search', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const keyword = (c.req.query('keyword') || '').trim();
  const kw = `%${keyword}%`;
  const { results } = await c.env.DB
    .prepare(
      'SELECT id, username, nickname, email, role, is_banned, created_at FROM users WHERE username LIKE ? OR nickname LIKE ? OR email LIKE ? ORDER BY id ASC LIMIT 50'
    )
    .bind(kw, kw, kw)
    .all();
  return c.json({ users: results });
});

app.post('/api/users/:id/ban', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const id = Number(c.req.param('id'));
  if (id === payload.id) return c.json({ message: '不能封禁自己' }, 400);

  const { banned } = await c.req.json();
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first<{ id: number }>();
  if (!target) return c.json({ message: '用户不存在' }, 404);

  await c.env.DB.prepare('UPDATE users SET is_banned = ? WHERE id = ?').bind(banned ? 1 : 0, id).run();
  return c.json({ ok: true, banned: !!banned });
});

// ===== 数据导出（CSV）=====
function toCsv(headers: string[], rows: any[], pick: (r: any) => any[]) {
  const esc = (v: any) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => pick(r).map(esc).join(','))].join('\n');
}

app.get('/api/admin/export/posts', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const { results } = await c.env.DB
    .prepare(
      `SELECT p.id, p.title, p.category, p.views, p.is_pinned, p.is_featured,
              u.username AS author, p.created_at, p.updated_at
       FROM posts p LEFT JOIN users u ON u.id = p.author_id ORDER BY p.id ASC`
    )
    .all();

  const csv = toCsv(
    ['ID', '标题', '分类', '作者', '浏览', '置顶', '精选', '创建时间', '更新时间'],
    results as any[],
    (r) => [r.id, r.title, r.category, r.author, r.views, r.is_pinned, r.is_featured, r.created_at, r.updated_at]
  );
  return c.body(csv, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="posts.csv"',
  });
});

app.get('/api/admin/export/users', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const { results } = await c.env.DB
    .prepare('SELECT id, username, nickname, email, role, is_banned, created_at FROM users ORDER BY id ASC')
    .all();

  const csv = toCsv(
    ['ID', '用户名', '昵称', '邮箱', '角色', '封禁', '注册时间'],
    results as any[],
    (r) => [r.id, r.username, r.nickname, r.email, r.role, r.is_banned, r.created_at]
  );
  return c.body(csv, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="users.csv"',
  });
});

export default app;
