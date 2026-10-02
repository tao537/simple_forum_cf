import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  // 图片上传（R2），可选。未配置时上传接口返回 501 提示。
  IMG_BUCKET?: any;
};

type Variables = {
  user: { id: number; username: string };
};

type AuthPayload = { id: number; username: string };

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
async function getAuth(c: any): Promise<AuthPayload | null> {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return null;
  try {
    const p = await verify(token, c.env.JWT_SECRET, 'HS256');
    return { id: Number(p.id), username: String(p.username) };
  } catch {
    return null;
  }
}

async function isAdmin(c: any, userId: number): Promise<boolean> {
  const me = await c.env.DB
    .prepare('SELECT role FROM users WHERE id = ?')
    .bind(userId)
    .first<{ role: string }>();
  return me?.role === 'admin';
}

// ==================== 通知辅助 ====================
async function addNotification(
  db: D1Database,
  p: { to: number; from: number; type: string; postId: number; content: string }
) {
  await db
    .prepare('INSERT INTO notifications (user_id, from_user_id, post_id, type, content) VALUES (?,?,?,?,?)')
    .bind(p.to, p.from, p.postId, p.type, p.content)
    .run();
}

async function resolveMentions(db: D1Database, content: string, selfId: number): Promise<{ id: number; username: string }[]> {
  const names = [...new Set((content.match(/@([\u4e00-\u9fa5\w]{2,30})/g) || []).map((x) => x.slice(1)))];
  const out: { id: number; username: string }[] = [];
  for (const n of names) {
    const u = await db.prepare('SELECT id, username FROM users WHERE username = ?').bind(n).first<{ id: number; username: string }>();
    if (u && u.id !== selfId) out.push(u);
  }
  return out;
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
  // 第一个注册的用户自动成为管理员（前端 login.html / admin.html 均提示了此规则）
  const count = await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  const role = (count?.n ?? 0) === 0 ? 'admin' : 'user';

  const result = await db
    .prepare('INSERT INTO users (username, email, password_hash, nickname, role) VALUES (?, ?, ?, ?, ?)')
    .bind(username, finalEmail, hash, nickname || '', role)
    .run();

  const id = result.meta.last_row_id as number;
  const token = await sign({ id, username, role }, c.env.JWT_SECRET, 'HS256');
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

  const token = await sign({ id: user.id, username: user.username, role: user.role }, c.env.JWT_SECRET, 'HS256');
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

// ==================== 帖子列表 ====================
app.get('/api/posts', async (c) => {
  const db = c.env.DB;
  const payload = await getAuth(c);
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const size = Math.min(Number(c.req.query('size')) || 10, 100);
  const offset = (page - 1) * size;
  const keyword = (c.req.query('keyword') || '').trim();
  const sort = c.req.query('sort') || 'new';
  const category = (c.req.query('category') || '').trim();

  const where: string[] = [];
  const binds: any[] = [];
  if (category) { where.push('p.category = ?'); binds.push(category); }
  if (keyword) { where.push('(p.title LIKE ? OR p.content LIKE ?)'); const kw = `%${keyword}%`; binds.push(kw, kw); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  let order = 'p.id DESC';
  if (sort === 'hot') order = '(upvotes + comment_count + p.views) DESC, p.id DESC';
  else if (sort === 'top') order = 'upvotes DESC, p.id DESC';

  const { results } = await db
    .prepare(
      `SELECT p.id, p.title, p.content, p.category, p.images, p.views,
              p.is_pinned AS pinned, p.is_featured AS featured,
              u.id AS author_id, u.username AS author_name,
              substr(p.content, 1, 140) AS summary,
              (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS upvotes,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
              p.created_at, p.updated_at
       FROM posts p JOIN users u ON u.id = p.author_id
       ${whereSql}
       ORDER BY ${order} LIMIT ? OFFSET ?`
    )
    .bind(...binds, size, offset)
    .all();

  const total = await db
    .prepare(`SELECT COUNT(*) AS n FROM posts p ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();

  const rows = results as any[];
  if (payload && rows.length) {
    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    const { results: likes } = await db
      .prepare(`SELECT post_id FROM post_likes WHERE user_id = ? AND post_id IN (${ph})`)
      .bind(payload.id, ...ids)
      .all();
    const likedSet = new Set((likes as any[]).map((l) => l.post_id));
    rows.forEach((r) => (r.liked = likedSet.has(r.id)));
  } else {
    rows.forEach((r) => (r.liked = false));
  }

  return c.json({ rows, page, size, total: total?.n ?? 0 });
});

// 精选（必须在 /:id 之前注册，避免被当作 id 匹配）
app.get('/api/posts/featured', async (c) => {
  const db = c.env.DB;
  const { results } = await db
    .prepare(
      `SELECT p.id, p.title, substr(p.content, 1, 120) AS summary, u.username AS author_name,
              (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS upvotes,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.is_featured = 1 ORDER BY p.id DESC LIMIT 6`
    )
    .all();
  return c.json({ rows: results });
});

// 图片上传（R2，可选）
app.post('/api/posts/upload', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const bucket = c.env.IMG_BUCKET;
  if (!bucket) {
    return c.json({ message: '图片存储未配置（需要 R2 bucket），请先按说明启用' }, 501);
  }

  const fd = await c.req.formData();
  const file = fd.get('file');
  if (!file || typeof file === 'string') return c.json({ message: '请选择图片文件' }, 400);

  const buf = await file.arrayBuffer();
  const ext = (file.name?.split('.').pop() || 'jpg').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'jpg';
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

  await bucket.put(key, buf, { httpMetadata: { contentType: file.type || 'image/jpeg' } });

  const origin = new URL(c.req.url).origin;
  return c.json({ url: `${origin}/img/${key}` }, 201);
});

// 通过 Worker 回读 R2 图片（无需公开 bucket 域名）
app.get('/img/:key', async (c) => {
  const bucket = c.env.IMG_BUCKET;
  if (!bucket) return c.json({ message: 'not found' }, 404);
  const obj = await bucket.get(c.req.param('key'));
  if (!obj) return c.json({ message: 'not found' }, 404);
  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(obj.body as any, { headers });
});

// 发帖
app.post('/api/posts', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const { title, content, category, images } = await c.req.json();
  if (!title || !content) return c.json({ message: '标题和内容不能为空' }, 400);

  const result = await c.env.DB
    .prepare('INSERT INTO posts (title, content, category, author_id, images) VALUES (?, ?, ?, ?, ?)')
    .bind(title, content, category || '', payload.id, JSON.stringify(images ?? []))
    .run();

  return c.json({ id: result.meta.last_row_id, title, content }, 201);
});

// 帖子详情
app.get('/api/posts/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ message: '帖子不存在' }, 404);
  const db = c.env.DB;
  const payload = await getAuth(c);

  const post = await db
    .prepare(
      `SELECT p.*, u.id AS author_id, u.username AS author_name,
              p.is_pinned AS pinned, p.is_featured AS featured,
              (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS upvotes
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.id = ?`
    )
    .bind(id)
    .first<any>();

  if (!post) return c.json({ message: '帖子不存在' }, 404);

  post.liked = payload
    ? !!(await db.prepare('SELECT id FROM post_likes WHERE post_id = ? AND user_id = ?').bind(id, payload.id).first())
    : false;

  const { results: comments } = await db
    .prepare(
      `SELECT c.id, c.post_id, c.user_id AS author_id, u.username AS author_name,
              c.content, c.created_at,
              (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS upvotes
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = ? ORDER BY c.id ASC`
    )
    .bind(id)
    .all();

  const crows = comments as any[];
  if (payload && crows.length) {
    const cids = crows.map((x) => x.id);
    const ph = cids.map(() => '?').join(',');
    const { results: likes } = await db
      .prepare(`SELECT comment_id FROM comment_likes WHERE user_id = ? AND comment_id IN (${ph})`)
      .bind(payload.id, ...cids)
      .all();
    const set = new Set((likes as any[]).map((l) => l.comment_id));
    crows.forEach((x) => (x.liked = set.has(x.id)));
  } else {
    crows.forEach((x) => (x.liked = false));
  }
  post.comments = crows;

  await db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').bind(id).run();
  return c.json(post);
});

// 帖子点赞
app.post('/api/posts/:id/like', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const post = await db
    .prepare('SELECT id, author_id FROM posts WHERE id = ?')
    .bind(id)
    .first<{ id: number; author_id: number }>();
  if (!post) return c.json({ message: '帖子不存在' }, 404);

  const liked = await db
    .prepare('SELECT id FROM post_likes WHERE post_id = ? AND user_id = ?')
    .bind(id, payload.id)
    .first<{ id: number }>();

  if (liked) {
    await db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').bind(id, payload.id).run();
  } else {
    await db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').bind(id, payload.id).run();
    if (post.author_id !== payload.id) {
      await addNotification(db, { to: post.author_id, from: payload.id, type: 'like', postId: id, content: `${payload.username} 赞了你的帖子` });
    }
  }

  const total = await db
    .prepare('SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?')
    .bind(id)
    .first<{ n: number }>();
  return c.json({ liked: !liked, upvotes: total?.n ?? 0 });
});

// 删除帖子
app.delete('/api/posts/:id', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const post = await db
    .prepare('SELECT author_id FROM posts WHERE id = ?')
    .bind(id)
    .first<{ author_id: number }>();

  if (!post) return c.json({ message: '帖子不存在' }, 404);
  if (post.author_id !== payload.id && !(await isAdmin(c, payload.id))) {
    return c.json({ message: '无权删除' }, 403);
  }

  await db.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
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

  if (post.author_id !== payload.id && !(await isAdmin(c, payload.id))) {
    return c.json({ message: '无权修改' }, 403);
  }

  const { title, content, category, images } = await c.req.json();
  if (!title || !content) return c.json({ message: '标题和内容不能为空' }, 400);

  await db
    .prepare(
      `UPDATE posts
       SET title = ?, content = ?, category = ?, images = ?, updated_at = datetime('now','localtime')
       WHERE id = ?`
    )
    .bind(title, content, category || '', JSON.stringify(images ?? []), id)
    .run();

  const updated = await db
    .prepare(
      `SELECT p.*, u.id AS author_id, u.username AS author_name,
              p.is_pinned AS pinned, p.is_featured AS featured,
              (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS upvotes
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.id = ?`
    )
    .bind(id)
    .first<any>();
  updated.liked = payload
    ? !!(await db.prepare('SELECT id FROM post_likes WHERE post_id = ? AND user_id = ?').bind(id, payload.id).first())
    : false;

  return c.json(updated);
});

app.post('/api/posts/:id/pin', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const db = c.env.DB;
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

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
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

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
  const db = c.env.DB;
  const payload = await getAuth(c);

  const { results } = await db
    .prepare(
      `SELECT c.id, c.post_id, c.user_id AS author_id, u.username AS author_name,
              c.content, c.created_at,
              (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS upvotes
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = ? ORDER BY c.id ASC`
    )
    .bind(id)
    .all();

  const rows = results as any[];
  if (payload && rows.length) {
    const ids = rows.map((x) => x.id);
    const ph = ids.map(() => '?').join(',');
    const { results: likes } = await db
      .prepare(`SELECT comment_id FROM comment_likes WHERE user_id = ? AND comment_id IN (${ph})`)
      .bind(payload.id, ...ids)
      .all();
    const set = new Set((likes as any[]).map((l) => l.comment_id));
    rows.forEach((x) => (x.liked = set.has(x.id)));
  } else {
    rows.forEach((x) => (x.liked = false));
  }

  return c.json({ rows });
});

app.post('/api/posts/:id/comments', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const postId = Number(c.req.param('id'));
  const { content } = await c.req.json();
  if (!content) return c.json({ message: '评论内容不能为空' }, 400);

  const db = c.env.DB;
  const post = await db
    .prepare('SELECT id, author_id FROM posts WHERE id = ?')
    .bind(postId)
    .first<{ id: number; author_id: number }>();
  if (!post) return c.json({ message: '帖子不存在' }, 404);

  const result = await db
    .prepare('INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)')
    .bind(postId, payload.id, content)
    .run();

  // 通知：回复帖子作者
  if (post.author_id !== payload.id) {
    await addNotification(db, {
      to: post.author_id, from: payload.id, type: 'reply', postId,
      content: `${payload.username} 评论了你的帖子：${content.slice(0, 40)}`,
    });
  }
  // 通知：@提及
  const mentions = await resolveMentions(db, content, payload.id);
  for (const m of mentions) {
    if (m.id !== post.author_id) {
      await addNotification(db, {
        to: m.id, from: payload.id, type: 'mention', postId,
        content: `${payload.username} 在评论中提到了你：${content.slice(0, 40)}`,
      });
    }
  }

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
    .prepare('SELECT id, post_id, user_id FROM comments WHERE id = ? AND post_id = ?')
    .bind(commentId, postId)
    .first<{ id: number; post_id: number; user_id: number }>();
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
    if (comment.user_id !== payload.id) {
      await addNotification(db, {
        to: comment.user_id, from: payload.id, type: 'like', postId,
        content: `${payload.username} 赞了你的评论`,
      });
    }
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

  if (comment.user_id !== payload.id && !(await isAdmin(c, payload.id))) {
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

// ==================== 站点设置（管理员后台「界面显示设置」）====================
const DEFAULT_SETTINGS = {
  cardSize: 'large',        // large | medium | small
  density: 'comfortable',   // comfortable | compact
  imageMaxWidth: 1280,      // 图片最大宽度 px
  imageQuality: 0.8,        // 压缩质量 0.3-1
  thumbnailSize: 300,       // 缩略图尺寸 px
};

async function getSettings(db: D1Database) {
  const row = await db.prepare('SELECT data FROM site_settings WHERE id = 1').first<{ data: string }>();
  let stored: any = {};
  try { stored = JSON.parse(row?.data || '{}'); } catch { stored = {}; }
  return { ...DEFAULT_SETTINGS, ...stored };
}

// 公开：前端读取显示设置（无需登录）
app.get('/api/settings', async (c) => {
  const settings = await getSettings(c.env.DB);
  return c.json({ settings });
});

// 管理员：更新设置
app.put('/api/settings', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const body = await c.req.json();
  const incoming = (body?.settings ?? {}) as Record<string, any>;
  const current = await getSettings(c.env.DB);
  const merged: any = { ...current, ...incoming };

  if (!['large', 'medium', 'small'].includes(merged.cardSize)) merged.cardSize = current.cardSize;
  if (!['comfortable', 'compact'].includes(merged.density)) merged.density = current.density;

  merged.imageMaxWidth = Number(merged.imageMaxWidth);
  if (![640, 768, 800, 1024, 1280, 1600, 1920].includes(merged.imageMaxWidth)) {
    merged.imageMaxWidth = current.imageMaxWidth;
  }
  merged.imageQuality = Number(merged.imageQuality);
  if (Number.isNaN(merged.imageQuality) || merged.imageQuality < 0.3 || merged.imageQuality > 1) {
    merged.imageQuality = current.imageQuality;
  }

  await c.env.DB
    .prepare("UPDATE site_settings SET data = ?, updated_at = datetime('now','localtime') WHERE id = 1")
    .bind(JSON.stringify(merged))
    .run();
  return c.json({ ok: true, settings: merged });
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
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, payload.id).run();
  return c.json({ ok: true });
});

export default app;
