import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';
import bcrypt from 'bcryptjs-webcrypto';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  user: { id: number; username: string };
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use('*', cors());

// ==================== 健康检查 ====================
app.get('/', (c) => c.json({ ok: true, service: 'forum-api' }));

// ==================== JWT 辅助 ====================
async function getAuth(c: any) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return null;
  try {
    return await verify(token, c.env.JWT_SECRET);
  } catch {
    return null;
  }
}

// ==================== 认证 ====================
app.post('/api/auth/register', async (c) => {
  const { username, email, password } = await c.req.json();
  if (!username || !email || !password) {
    return c.json({ message: '用户名、邮箱、密码不能为空' }, 400);
  }

  const db = c.env.DB;
  const exists = await db
    .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .bind(username, email)
    .first();

  if (exists) return c.json({ message: '用户名或邮箱已被注册' }, 409);

  const hash = await bcrypt.hash(password, 10);
  const result = await db
    .prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)')
    .bind(username, email, hash)
    .run();

  const id = result.meta.last_row_id as number;
  const token = await sign({ id, username }, c.env.JWT_SECRET, 'HS256');
  return c.json({ token, user: { id, username } }, 201);
});

app.post('/api/auth/login', async (c) => {
  const { username, password } = await c.req.json();
  const db = c.env.DB;

  const user = await db
    .prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .bind(username, username)
    .first<{ id: number; username: string; password_hash: string; is_banned: number }>();

  if (!user) return c.json({ message: '用户名或密码错误' }, 401);
  if (user.is_banned) return c.json({ message: '账号已被封禁' }, 403);

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return c.json({ message: '用户名或密码错误' }, 401);

  const token = await sign({ id: user.id, username: user.username }, c.env.JWT_SECRET, 'HS256');
  return c.json({ token, user: { id: user.id, username: user.username } });
});

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

export default app;
