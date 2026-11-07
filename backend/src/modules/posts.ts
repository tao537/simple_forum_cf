import { Hono } from 'hono';
import type { Env } from '../types';
import { sanitizeImages } from '../lib/security';
import { getAuth, isAdmin, getSessionUser } from '../lib/auth';
import { addNotification, resolveMentions } from '../lib/notify';

// 论坛帖子与评论域：列表、详情、发帖、点赞、编辑删除、置顶精选、评论、批量操作
const routes = new Hono<Env>();
// ==================== 帖子列表 ====================
routes.get('/api/posts', async (c) => {
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
routes.get('/api/posts/featured', async (c) => {
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

// 搜索联想（按标题模糊匹配，返回 id+title 供前端下拉）
// 必须在 /api/posts/:id 之前注册，避免被当作 id 匹配
routes.get('/api/posts/suggest', async (c) => {
  const keyword = (c.req.query('keyword') || '').trim();
  const limit = Math.max(1, Math.min(8, Number(c.req.query('limit')) || 6));
  if (!keyword) return c.json({ rows: [] });
  const db = c.env.DB;
  const kw = `%${keyword}%`;
  const { results } = await db
    .prepare('SELECT id, title FROM posts WHERE title LIKE ? ORDER BY views DESC, id DESC LIMIT ?')
    .bind(kw, limit)
    .all<{ id: number; title: string }>();
  return c.json({ rows: results });
});

// 图片上传（存 Cloudflare KV，免费 1GB，无需绑卡）
routes.post('/api/posts/upload', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const formData = await c.req.formData().catch(() => null);
  if (!formData) return c.json({ message: '没有文件' }, 400);
  const file = formData.get('file');
  if (!file || typeof file === 'string') return c.json({ message: '没有文件' }, 400);
  if (!file.type.startsWith('image/')) return c.json({ message: '只能上传图片' }, 400);
  if (file.size > 5 * 1024 * 1024) return c.json({ message: '图片不能超过 5MB' }, 400);

  // KV 的 value 支持 ArrayBuffer，直接存二进制（比 base64 省约 33% 空间）
  const bytes = await file.arrayBuffer();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  // 不设 expirationTtl：图片永久保存
  await c.env.IMG_KV.put(`img:${id}`, bytes, {
    metadata: { contentType: file.type || 'image/jpeg' },
  });

  // 返回绝对地址（前端在 kuhai.de5.net，相对路径 /img/... 会打到 Pages 上 404）
  const origin = new URL(c.req.url).origin;
  return c.json({ url: `${origin}/img/${id}` });
});

// 读取 KV 中的图片（前端 <img> 直接引用 /img/:id）
routes.get('/img/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(id)) return c.json({ message: 'not found' }, 404);

  const { value, metadata } = await c.env.IMG_KV.getWithMetadata<{ contentType?: string }>(
    `img:${id}`,
    'arrayBuffer'
  );
  if (!value) return c.json({ message: 'not found' }, 404);

  const headers = new Headers();
  headers.set('Content-Type', metadata?.contentType || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(value, { headers });
});

// 发帖
routes.post('/api/posts', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const { title, content, category, images } = await c.req.json();
  // 先 trim 再校验：全空格的标题是 truthy，不 trim 会存进一条"看不见标题"的帖子
  const safeTitle = typeof title === 'string' ? title.trim() : '';
  const safeContent = typeof content === 'string' ? content.trim() : '';
  if (!safeTitle || !safeContent) return c.json({ message: '标题和内容不能为空' }, 400);

  const safeImages = sanitizeImages(images);

  const result = await c.env.DB
    .prepare('INSERT INTO posts (title, content, category, author_id, images) VALUES (?, ?, ?, ?, ?)')
    .bind(safeTitle, safeContent, category || '', payload.id, JSON.stringify(safeImages))
    .run();

  return c.json({ id: result.meta.last_row_id, title: safeTitle, content: safeContent }, 201);
});

// 帖子详情
routes.get('/api/posts/:id', async (c) => {
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
routes.post('/api/posts/:id/like', async (c) => {
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
routes.delete('/api/posts/:id', async (c) => {
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
routes.put('/api/posts/:id', async (c) => {
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
  // 同创建接口：trim 后再校验，避免"全空格标题"落库
  const safeTitle = typeof title === 'string' ? title.trim() : '';
  const safeContent = typeof content === 'string' ? content.trim() : '';
  if (!safeTitle || !safeContent) return c.json({ message: '标题和内容不能为空' }, 400);

  const safeImages = sanitizeImages(images);

  await db
    .prepare(
      `UPDATE posts
       SET title = ?, content = ?, category = ?, images = ?, updated_at = datetime('now','localtime')
       WHERE id = ?`
    )
    .bind(safeTitle, safeContent, category || '', JSON.stringify(safeImages), id)
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

routes.post('/api/posts/:id/pin', async (c) => {
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

routes.post('/api/posts/:id/feature', async (c) => {
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
routes.get('/api/posts/:id/comments', async (c) => {
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

routes.post('/api/posts/:id/comments', async (c) => {
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
routes.post('/api/posts/:postId/comments/:commentId/like', async (c) => {
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

routes.delete('/api/comments/:id', async (c) => {
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

// ===== 帖子批量操作 =====
routes.post('/api/posts/batch', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const { ids, action } = await c.req.json();
  const list = Array.isArray(ids) ? ids.map((v) => Number(v)).filter((v) => Number.isInteger(v)) : [];
  if (!list.length) return c.json({ message: '请选择帖子' }, 400);

  const ph = list.map(() => '?').join(',');
  let sql = '';
  if (action === 'pin') sql = `UPDATE posts SET is_pinned = 1 WHERE id IN (${ph})`;
  else if (action === 'unpin') sql = `UPDATE posts SET is_pinned = 0 WHERE id IN (${ph})`;
  else if (action === 'feature') sql = `UPDATE posts SET is_featured = 1 WHERE id IN (${ph})`;
  else if (action === 'unfeature') sql = `UPDATE posts SET is_featured = 0 WHERE id IN (${ph})`;
  else if (action === 'delete') sql = `DELETE FROM posts WHERE id IN (${ph})`;
  else return c.json({ message: '不支持的批量操作' }, 400);

  const result = await c.env.DB.prepare(sql).bind(...list).run();
  return c.json({ ok: true, affected: result.meta.changes ?? 0 });
});


export default routes;
