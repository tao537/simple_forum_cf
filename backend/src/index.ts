import { Hono } from 'hono';
import { cors } from 'hono/cors';

// 共享内核：安全 / 鉴权，各管一件事，被各领域模块按需引用
import type { Env } from './types';
import { validateCredentials, hashPassword, verifyPassword, BAD_PASSWORDS } from './lib/security';
import { issueToken, getAuth, isAdmin, TOKEN_TTL_SECONDS } from './lib/auth';
// 领域模块：门禁、媒体代理、论坛帖子、游戏帖子、站点配置；各自独立、互不依赖
import gateRoutes, { requireGate, loadGate } from './modules/gate';
import userRoutes from './modules/users';
import notificationRoutes from './modules/notifications';
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
app.route('/', userRoutes);
app.route('/', notificationRoutes);
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
  // 以库里为准返回，角色变更（提升/降级）无需重新登录即可生效
  const row = await c.env.DB
    .prepare('SELECT id, username, nickname, role FROM users WHERE id = ?')
    .bind(payload.id)
    .first<{ id: number; username: string; nickname: string; role: string }>();
  if (!row) return c.json({ message: '用户不存在' }, 404);
  return c.json({ user: { id: row.id, username: row.username, nickname: row.nickname, role: row.role } });
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
  // 口令策略与论坛注册保持一致：至少 8 位 + 弱口令黑名单（统一账号库，不能留第二个口子）
  if (pw.length < 8) return c.json({ message: '密码至少 8 位' }, 400);
  if (BAD_PASSWORDS.has(pw.toLowerCase())) return c.json({ message: '密码过于简单' }, 400);
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
  const token = await issueToken(c, { id: user.id, username: user.username, role: user.role }); // 统一 token（SSO）
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

// ===== 数据导出（CSV）=====
/** CSV 生成：UTF-8 BOM（Excel 直接打开不乱码）+ 转义 + 防公式注入 */
function toCsv(headers: string[], rows: any[], pick: (r: any) => any[]) {
  const esc = (v: any) => {
    let s = String(v ?? '');
    // 以 = + - @ 开头的单元格会被 Excel 当公式执行，前置单引号阻断
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `\uFEFF${[headers.join(','), ...rows.map((r) => pick(r).map(esc).join(','))].join('\n')}`;
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
