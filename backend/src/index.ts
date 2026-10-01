import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  user: { id: number; username: string };
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use('*', cors());

// ==================== 密码哈希（Web Crypto PBKDF2）====================
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100000;
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const toHex = (arr: Uint8Array) =>
    [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2$${iterations}$${toHex(salt)}$${toHex(new Uint8Array(bits))}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = new Uint8Array((parts[2].match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));
  const expected = parts[3];
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const hashHex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hashHex === expected;
}

// ==================== JWT 辅助 ====================
async function getAuth(c: any) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return null;
  try {
    return await verify(token, c.env.JWT_SECRET, 'HS256');
  } catch {
    return null;
  }
}

// ==================== 健康检查 ====================
app.get('/', (c) => c.json({ ok: true, service: 'forum-api' }));

// ==================== 认证 ====================
const handleRegister = async (c: any) => {
  const { username, email, password, nickname } = await c.req.json();
  if (!username || !password) {
    return c.json({ message: '用户名和密码不能为空' }, 400);
  }

  const finalEmail = email || `${username}@local`;

  const db = c.env.DB;
  const exists = await db
    .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .bind(username, finalEmail)
    .first();

  if (exists) return c.json({ message: '用户名或邮箱已被注册' }, 409);

  const hash = await hashPassword(password);
  const result = await db
    .prepare('INSERT INTO users (username, email, password_hash, nickname) VALUES (?, ?, ?, ?)')
    .bind(username, finalEmail, hash, nickname || '')
    .run();

  const id = result.meta.last_row_id as number;
  const token = await sign({ id, username }, c.env.JWT_SECRET, 'HS256');
  return c.json({ token, user: { id, username } }, 201);
};

const handleLogin = async (c: any) => {
  const { username: identifier, password } = await c.req.json();
  const db = c.env.DB;

  const user = await db
    .prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .bind(identifier, identifier)
    .first<{ id: number; username: string; password_hash: string; is_banned: number }>();

  if (!user) return c.json({ message: '用户名或密码错误' }, 401);
  if (user.is_banned) return c.json({ message: '账号已被封禁' }, 403);

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return c.json({ message: '用户名或密码错误' }, 401);

  const token = await sign({ id: user.id, username: user.username }, c.env.JWT_SECRET, 'HS256');
  return c.json({ token, user: { id: user.id, username: user.username } });
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

// ==================== 帖子 ====================
app.get('/api/posts', async (c) => {
  const db = c.env.DB;
  const page = Number(c.req.query('page')) || 1;
  const size = Math.min(Number(c.req.query('size')) || 10, 100);
  const offset = (page - 1) * size;

  const { results } = await db
    .prepare(
      `SELECT p.id, p.title, p.content, p.views, p.created_at,
              u.id AS author_id, u.username AS author_name
       FROM posts p JOIN users u ON u.id = p.author_id
       ORDER BY p.id DESC LIMIT ? OFFSET ?`
    )
    .bind(size, offset)
    .all();

  const total = await db.prepare('SELECT COUNT(*) AS n FROM posts').first<{ n: number }>();
  return c.json({ rows: results, page, size, total: total?.n ?? 0 });
});

app.get('/api/posts/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;

  const post = await db
    .prepare(
      `SELECT p.*, u.username AS author_name
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.id = ?`
    )
    .bind(id)
    .first();

  if (!post) return c.json({ message: '帖子不存在' }, 404);

  await db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').bind(id).run();
  return c.json(post);
});

app.post('/api/posts', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const { title, content, images } = await c.req.json();
  if (!title || !content) return c.json({ message: '标题和内容不能为空' }, 400);

  const result = await c.env.DB
    .prepare('INSERT INTO posts (title, content, author_id, images) VALUES (?, ?, ?, ?)')
    .bind(title, content, payload.id, JSON.stringify(images ?? []))
    .run();

  return c.json({ id: result.meta.last_row_id, title, content }, 201);
});

app.delete('/api/posts/:id', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const id = Number(c.req.param('id'));
  const post = await c.env.DB
    .prepare('SELECT author_id FROM posts WHERE id = ?')
    .bind(id)
    .first<{ author_id: number }>();

  if (!post) return c.json({ message: '帖子不存在' }, 404);
  if (post.author_id !== payload.id) return c.json({ message: '无权删除' }, 403);

  await c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// ==================== 帖子管理（编辑 / 置顶 / 精选）====================
app.put('/api/posts/:id', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const id = Number(c.req.param('id'));
  const db = c.env.DB;

  const post = await db
    .prepare('SELECT author_id FROM posts WHERE id = ?')
    .bind(id)
    .first<{ author_id: number }>();

  if (!post) return c.json({ message: '帖子不存在' }, 404);

  const me = await db
    .prepare('SELECT role FROM users WHERE id = ?')
    .bind(payload.id)
    .first<{ role: string }>();

  if (post.author_id !== payload.id && me?.role !== 'admin') {
    return c.json({ message: '无权修改' }, 403);
  }

  const { title, content, images } = await c.req.json();
  if (!title || !content) return c.json({ message: '标题和内容不能为空' }, 400);

  await db
    .prepare(
      `UPDATE posts
       SET title = ?, content = ?, images = ?, updated_at = datetime('now','localtime')
       WHERE id = ?`
    )
    .bind(title, content, JSON.stringify(images ?? []), id)
    .run();

  const updated = await db
    .prepare(
      `SELECT p.*, u.username AS author_name
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.id = ?`
    )
    .bind(id)
    .first();

  return c.json(updated);
});

app.post('/api/posts/:id/pin', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const db = c.env.DB;
  const me = await db
    .prepare('SELECT role FROM users WHERE id = ?')
    .bind(payload.id)
    .first<{ role: string }>();

  if (me?.role !== 'admin') return c.json({ message: '需要管理员权限' }, 403);

  const id = Number(c.req.param('id'));
  const result = await db
    .prepare('UPDATE posts SET is_pinned = CASE is_pinned WHEN 0 THEN 1 ELSE 0 END WHERE id = ?')
    .bind(id)
    .run();

  if (!result.meta.changes) return c.json({ message: '帖子不存在' }, 404);

  const row = await db
    .prepare('SELECT is_pinned FROM posts WHERE id = ?')
    .bind(id)
    .first<{ is_pinned: number }>();

  return c.json({ pinned: !!row?.is_pinned });
});

app.post('/api/posts/:id/feature', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const db = c.env.DB;
  const me = await db
    .prepare('SELECT role FROM users WHERE id = ?')
    .bind(payload.id)
    .first<{ role: string }>();

  if (me?.role !== 'admin') return c.json({ message: '需要管理员权限' }, 403);

  const id = Number(c.req.param('id'));
  const result = await db
    .prepare('UPDATE posts SET is_featured = CASE is_featured WHEN 0 THEN 1 ELSE 0 END WHERE id = ?')
    .bind(id)
    .run();

  if (!result.meta.changes) return c.json({ message: '帖子不存在' }, 404);

  const row = await db
    .prepare('SELECT is_featured FROM posts WHERE id = ?')
    .bind(id)
    .first<{ is_featured: number }>();

  return c.json({ featured: !!row?.is_featured });
});

// ==================== 评论 ====================
app.get('/api/posts/:id/comments', async (c) => {
  const id = Number(c.req.param('id'));
  const { results } = await c.env.DB
    .prepare(
      `SELECT c.id, c.content, c.created_at,
              u.id AS user_id, u.username
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = ? ORDER BY c.id ASC`
    )
    .bind(id)
    .all();

  return c.json({ rows: results });
});

app.post('/api/posts/:id/comments', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const postId = Number(c.req.param('id'));
  const { content } = await c.req.json();
  if (!content) return c.json({ message: '评论内容不能为空' }, 400);

  const result = await c.env.DB
    .prepare('INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)')
    .bind(postId, payload.id, content)
    .run();

  return c.json({ id: result.meta.last_row_id, content }, 201);
});

// ==================== 评论管理（点赞 / 删除）====================
app.post('/api/posts/:postId/comments/:commentId/like', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const postId = Number(c.req.param('postId'));
  const commentId = Number(c.req.param('commentId'));
  const db = c.env.DB;

  const comment = await db
    .prepare('SELECT id FROM comments WHERE id = ? AND post_id = ?')
    .bind(commentId, postId)
    .first<{ id: number }>();

  if (!comment) return c.json({ message: '评论不存在' }, 404);

  const liked = await db
    .prepare('SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?')
    .bind(commentId, payload.id)
    .first<{ id: number }>();

  if (liked) {
    await db
      .prepare('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?')
      .bind(commentId, payload.id)
      .run();
  } else {
    await db
      .prepare('INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)')
      .bind(commentId, payload.id)
      .run();
  }

  const total = await db
    .prepare('SELECT COUNT(*) AS n FROM comment_likes WHERE comment_id = ?')
    .bind(commentId)
    .first<{ n: number }>();

  return c.json({ liked: !liked, upvotes: total?.n ?? 0 });
});

app.delete('/api/comments/:id', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const id = Number(c.req.param('id'));
  const db = c.env.DB;

  const comment = await db
    .prepare('SELECT user_id FROM comments WHERE id = ?')
    .bind(id)
    .first<{ user_id: number }>();

  if (!comment) return c.json({ message: '评论不存在' }, 404);

  const me = await db
    .prepare('SELECT role FROM users WHERE id = ?')
    .bind(payload.id)
    .first<{ role: string }>();

  if (comment.user_id !== payload.id && me?.role !== 'admin') {
    return c.json({ message: '无权删除' }, 403);
  }

  await db.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// ==================== 用户管理（管理员）====================
app.get('/api/users', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const db = c.env.DB;
  const me = await db
    .prepare('SELECT role FROM users WHERE id = ?')
    .bind(payload.id)
    .first<{ role: string }>();

  if (me?.role !== 'admin') return c.json({ message: '需要管理员权限' }, 403);

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
  const me = await db
    .prepare('SELECT role FROM users WHERE id = ?')
    .bind(payload.id)
    .first<{ role: string }>();

  if (me?.role !== 'admin') return c.json({ message: '需要管理员权限' }, 403);

  const id = Number(c.req.param('id'));
  if (id === payload.id) return c.json({ message: '不能删除自己' }, 400);

  const target = await db
    .prepare('SELECT id FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: number }>();

  if (!target) return c.json({ message: '用户不存在' }, 404);

  await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

app.post('/api/users/batch-delete', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const db = c.env.DB;
  const me = await db
    .prepare('SELECT role FROM users WHERE id = ?')
    .bind(payload.id)
    .first<{ role: string }>();

  if (me?.role !== 'admin') return c.json({ message: '需要管理员权限' }, 403);

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
  const me = await db
    .prepare('SELECT role FROM users WHERE id = ?')
    .bind(payload.id)
    .first<{ role: string }>();

  if (me?.role !== 'admin') return c.json({ message: '需要管理员权限' }, 403);

  const id = Number(c.req.param('id'));
  if (id === payload.id) return c.json({ message: '不能修改自己的角色' }, 400);

  const { role } = await c.req.json();
  if (role !== 'admin' && role !== 'user') {
    return c.json({ message: '角色只能是 admin 或 user' }, 400);
  }

  const target = await db
    .prepare('SELECT id FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: number }>();

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
      `SELECT COUNT(*) AS n FROM comment_likes cl
       JOIN comments c ON c.id = cl.comment_id
       WHERE c.user_id = ?`
    )
    .bind(id)
    .first<{ n: number }>();

  const { results: posts } = await db
    .prepare(
      `SELECT p.id, p.title, p.content, p.images, p.views, p.is_pinned, p.is_featured, p.created_at
       FROM posts p WHERE p.author_id = ? ORDER BY p.id DESC LIMIT 20`
    )
    .bind(id)
    .all();

  const { results: comments } = await db
    .prepare(
      `SELECT c.id, c.post_id, c.content, c.created_at
       FROM comments c WHERE c.user_id = ? ORDER BY c.id DESC LIMIT 20`
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
      'SELECT id, type, content, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50'
    )
    .bind(payload.id)
    .all();

  return c.json({ rows: results });
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

app.put('/api/notifications/:id/read', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const id = Number(c.req.param('id'));
  const db = c.env.DB;

  const row = await db
    .prepare('SELECT id FROM notifications WHERE id = ? AND user_id = ?')
    .bind(id, payload.id)
    .first<{ id: number }>();

  if (!row) return c.json({ message: '通知不存在' }, 404);

  await db
    .prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .bind(id, payload.id)
    .run();

  return c.json({ ok: true });
});

// ==================== 修改密码 ====================
app.put('/api/users/password', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const { oldPassword, newPassword } = await c.req.json();
  if (!oldPassword || !newPassword) {
    return c.json({ message: '原密码和新密码不能为空' }, 400);
  }
  if (newPassword.length < 6) {
    return c.json({ message: '新密码长度至少 6 位' }, 400);
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
  await db
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(hash, payload.id)
    .run();

  return c.json({ ok: true });
});

export default app;
