import { Hono } from 'hono';
import type { Env } from '../types';
import { sanitizeImages } from '../lib/security';
import { getAuth, isAdmin, getSessionUser, isAdminUser } from '../lib/auth';
import { requireGate } from './gate';

// 游戏站访客标识（未登录发帖/点赞按访客去重）
const VISITOR_RE = /^v[a-z0-9]{12,40}$/;

// 门禁未通过时的统一响应：游戏站的所有读写都要先过门禁
async function gateDenied(c: any) {
  if (await requireGate(c)) return null;
  return c.json({ message: '请输入访问密码进入游戏站' }, 401);
}

// 作者本人（访客标识或统一账号）或任意管理员
async function canAuthorOrManage(
  c: any,
  row: { author_visitor?: string | null; author_user_id?: number | null },
  visitorId: string
): Promise<boolean> {
  const adminPayload = await getAuth(c);
  const guser = await getSessionUser(c);
  const isAuthor =
    (!!row.author_visitor && row.author_visitor === visitorId) ||
    (!!guser && row.author_user_id === guser.id);
  const canManage =
    (!!adminPayload && (await isAdmin(c, adminPayload.id))) || (await isAdminUser(c));
  return isAuthor || canManage;
}

// 仅管理员（论坛管理员或游戏站管理员）
async function requireManager(c: any): Promise<boolean> {
  const adminPayload = await getAuth(c);
  const isGameAdmin = await isAdminUser(c);
  const isForumAdmin = !!adminPayload && (await isAdmin(c, adminPayload.id));
  return isGameAdmin || isForumAdmin;
}

const routes = new Hono<Env>();

// ==================== 游戏帖子 ====================
routes.get('/api/game/posts', async (c) => {
  const denied = await gateDenied(c);
  if (denied) return denied;

  const db = c.env.DB;
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const size = Math.min(Number(c.req.query('size')) || 12, 100);
  const offset = (page - 1) * size;
  const keyword = (c.req.query('keyword') || '').trim();
  const sort = c.req.query('sort') || 'new';

  const where: string[] = [];
  const binds: any[] = [];
  if (keyword) {
    where.push('(p.title LIKE ? OR p.content LIKE ?)');
    const kw = `%${keyword}%`;
    binds.push(kw, kw);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  let order = 'p.id DESC';
  if (sort === 'hot') order = '(upvotes + comment_count + p.views) DESC, p.id DESC';
  else if (sort === 'top') order = 'upvotes DESC, p.id DESC';

  const { results } = await db
    .prepare(
      `SELECT p.id, p.title, p.content, p.images, p.views,
              p.is_pinned AS pinned, p.is_featured AS featured,
              p.author_name, substr(p.content, 1, 140) AS summary,
              (SELECT COUNT(*) FROM game_post_likes pl WHERE pl.post_id = p.id) AS upvotes,
              (SELECT COUNT(*) FROM game_comments c WHERE c.post_id = p.id) AS comment_count,
              p.created_at, p.updated_at
       FROM game_posts p
       ${whereSql}
       ORDER BY ${order} LIMIT ? OFFSET ?`
    )
    .bind(...binds, size, offset)
    .all();

  const total = await db
    .prepare(`SELECT COUNT(*) AS n FROM game_posts p ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();

  return c.json({ rows: results, page, size, total: total?.n ?? 0 });
});

routes.get('/api/game/posts/featured', async (c) => {
  const denied = await gateDenied(c);
  if (denied) return denied;
  const { results } = await c.env.DB
    .prepare(
      `SELECT p.id, p.title, substr(p.content, 1, 120) AS summary, p.author_name,
              (SELECT COUNT(*) FROM game_post_likes pl WHERE pl.post_id = p.id) AS upvotes,
              (SELECT COUNT(*) FROM game_comments c WHERE c.post_id = p.id) AS comment_count
       FROM game_posts p WHERE p.is_featured = 1 ORDER BY p.id DESC LIMIT 6`
    )
    .all();
  return c.json({ rows: results });
});

// 游戏站搜索联想（按标题模糊匹配，返回 id+title 供前端下拉）
// 必须在 /api/game/posts/:id 之前注册，避免被当作 id 匹配
routes.get('/api/game/posts/suggest', async (c) => {
  const denied = await gateDenied(c);
  if (denied) return denied;
  const keyword = (c.req.query('keyword') || '').trim();
  const limit = Math.max(1, Math.min(8, Number(c.req.query('limit')) || 6));
  if (!keyword) return c.json({ rows: [] });
  const db = c.env.DB;
  const kw = `%${keyword}%`;
  const { results } = await db
    .prepare('SELECT id, title FROM game_posts WHERE title LIKE ? ORDER BY views DESC, id DESC LIMIT ?')
    .bind(kw, limit)
    .all<{ id: number; title: string }>();
  return c.json({ rows: results });
});

// 游戏图片上传（与论坛共用 KV 逻辑）
routes.post('/api/game/posts/upload', async (c) => {
  const denied = await gateDenied(c);
  if (denied) return denied;

  const formData = await c.req.formData().catch(() => null);
  if (!formData) return c.json({ message: '没有文件' }, 400);
  const file = formData.get('file');
  if (!file || typeof file === 'string') return c.json({ message: '没有文件' }, 400);
  if (!file.type.startsWith('image/')) return c.json({ message: '只能上传图片' }, 400);
  if (file.size > 5 * 1024 * 1024) return c.json({ message: '图片不能超过 5MB' }, 400);

  // KV 直接存二进制 ArrayBuffer，不设 expirationTtl（永久保存）
  const bytes = await file.arrayBuffer();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await c.env.IMG_KV.put(`img:${id}`, bytes, {
    metadata: { contentType: file.type || 'image/jpeg' },
  });

  const origin = new URL(c.req.url).origin;
  return c.json({ url: `${origin}/img/${id}` });
});

// 游戏发帖（登录账号用账号身份，未登录用访客昵称）
routes.post('/api/game/posts', async (c) => {
  const denied = await gateDenied(c);
  if (denied) return denied;

  const { title, content, nickname, visitorId, images } = await c.req.json();
  if (!title || !content) return c.json({ message: '标题和内容不能为空' }, 400);
  const guser = await getSessionUser(c);
  const nick = guser ? (guser.nickname || guser.username) : (String(nickname || '').trim().slice(0, 20) || '匿名玩家');
  const vid = !guser && typeof visitorId === 'string' && VISITOR_RE.test(visitorId) ? visitorId : '';
  const safeImages = sanitizeImages(images);

  const result = await c.env.DB
    .prepare('INSERT INTO game_posts (title, content, author_name, author_visitor, author_user_id, images) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(title, content, nick, vid, guser ? guser.id : null, JSON.stringify(safeImages))
    .run();

  return c.json({ id: result.meta.last_row_id, title, content, author_user_id: guser ? guser.id : null }, 201);
});

// 游戏帖子详情
routes.get('/api/game/posts/:id', async (c) => {
  const denied = await gateDenied(c);
  if (denied) return denied;

  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ message: '帖子不存在' }, 404);
  const db = c.env.DB;
  const visitorId = String(c.req.query('visitorId') || '');

  const post = await db
    .prepare(
      `SELECT p.*, p.is_pinned AS pinned, p.is_featured AS featured,
              (SELECT COUNT(*) FROM game_post_likes pl WHERE pl.post_id = p.id) AS upvotes
       FROM game_posts p WHERE p.id = ?`
    )
    .bind(id)
    .first<any>();

  if (!post) return c.json({ message: '帖子不存在' }, 404);

  post.liked = VISITOR_RE.test(visitorId)
    ? !!(await db.prepare('SELECT id FROM game_post_likes WHERE post_id = ? AND visitor_id = ?').bind(id, visitorId).first())
    : false;

  const { results: game_comments } = await db
    .prepare(
      `SELECT c.id, c.post_id, c.author_name, c.author_visitor, c.author_user_id, c.content, c.created_at,
              (SELECT COUNT(*) FROM game_comment_likes cl WHERE cl.comment_id = c.id) AS upvotes
       FROM game_comments c WHERE c.post_id = ? ORDER BY c.id ASC`
    )
    .bind(id)
    .all();

  const crows = game_comments as any[];
  if (VISITOR_RE.test(visitorId) && crows.length) {
    const cids = crows.map((x) => x.id);
    const ph = cids.map(() => '?').join(',');
    const { results: likes } = await db
      .prepare(`SELECT comment_id FROM game_comment_likes WHERE visitor_id = ? AND comment_id IN (${ph})`)
      .bind(visitorId, ...cids)
      .all();
    const set = new Set((likes as any[]).map((l) => l.comment_id));
    crows.forEach((x) => (x.liked = set.has(x.id)));
  } else {
    crows.forEach((x) => (x.liked = false));
  }
  post.comments = crows;

  await db.prepare('UPDATE game_posts SET views = views + 1 WHERE id = ?').bind(id).run();
  return c.json(post);
});

// 游戏帖子点赞
routes.post('/api/game/posts/:id/like', async (c) => {
  const denied = await gateDenied(c);
  if (denied) return denied;

  const id = Number(c.req.param('id'));
  const { visitorId } = await c.req.json();
  if (!VISITOR_RE.test(String(visitorId || ''))) return c.json({ message: '缺少访客标识' }, 400);

  const db = c.env.DB;
  const post = await db.prepare('SELECT id FROM game_posts WHERE id = ?').bind(id).first<{ id: number }>();
  if (!post) return c.json({ message: '帖子不存在' }, 404);

  const liked = await db
    .prepare('SELECT id FROM game_post_likes WHERE post_id = ? AND visitor_id = ?')
    .bind(id, visitorId)
    .first<{ id: number }>();

  if (liked) {
    await db.prepare('DELETE FROM game_post_likes WHERE post_id = ? AND visitor_id = ?').bind(id, visitorId).run();
  } else {
    await db.prepare('INSERT INTO game_post_likes (post_id, visitor_id) VALUES (?, ?)').bind(id, visitorId).run();
  }

  const total = await db.prepare('SELECT COUNT(*) AS n FROM game_post_likes WHERE post_id = ?').bind(id).first<{ n: number }>();
  return c.json({ liked: !liked, upvotes: total?.n ?? 0 });
});

// 游戏评论（登录账号用账号身份，未登录用访客昵称）
routes.post('/api/game/posts/:id/comments', async (c) => {
  const denied = await gateDenied(c);
  if (denied) return denied;

  const postId = Number(c.req.param('id'));
  const { content, nickname, visitorId } = await c.req.json();
  if (!content) return c.json({ message: '评论内容不能为空' }, 400);
  const guser = await getSessionUser(c);
  const nick = guser ? (guser.nickname || guser.username) : (String(nickname || '').trim().slice(0, 20) || '匿名玩家');
  const vid = !guser && typeof visitorId === 'string' && VISITOR_RE.test(visitorId) ? visitorId : '';

  const db = c.env.DB;
  const post = await db.prepare('SELECT id FROM game_posts WHERE id = ?').bind(postId).first<{ id: number }>();
  if (!post) return c.json({ message: '帖子不存在' }, 404);

  const result = await db
    .prepare('INSERT INTO game_comments (post_id, author_name, author_visitor, author_user_id, content) VALUES (?, ?, ?, ?, ?)')
    .bind(postId, nick, vid, guser ? guser.id : null, content)
    .run();

  return c.json({ id: result.meta.last_row_id, content, author_user_id: guser ? guser.id : null }, 201);
});

// 游戏评论点赞
routes.post('/api/game/posts/:postId/comments/:commentId/like', async (c) => {
  const denied = await gateDenied(c);
  if (denied) return denied;

  const postId = Number(c.req.param('postId'));
  const commentId = Number(c.req.param('commentId'));
  const { visitorId } = await c.req.json();
  if (!VISITOR_RE.test(String(visitorId || ''))) return c.json({ message: '缺少访客标识' }, 400);

  const db = c.env.DB;
  const comment = await db
    .prepare('SELECT id FROM game_comments WHERE id = ? AND post_id = ?')
    .bind(commentId, postId)
    .first<{ id: number }>();
  if (!comment) return c.json({ message: '评论不存在' }, 404);

  const liked = await db
    .prepare('SELECT id FROM game_comment_likes WHERE comment_id = ? AND visitor_id = ?')
    .bind(commentId, visitorId)
    .first<{ id: number }>();

  if (liked) {
    await db.prepare('DELETE FROM game_comment_likes WHERE comment_id = ? AND visitor_id = ?').bind(commentId, visitorId).run();
  } else {
    await db.prepare('INSERT INTO game_comment_likes (comment_id, visitor_id) VALUES (?, ?)').bind(commentId, visitorId).run();
  }

  const total = await db.prepare('SELECT COUNT(*) AS n FROM game_comment_likes WHERE comment_id = ?').bind(commentId).first<{ n: number }>();
  return c.json({ liked: !liked, upvotes: total?.n ?? 0 });
});

// 游戏帖子编辑（作者/游戏站管理员/论坛管理员）
routes.put('/api/game/posts/:id', async (c) => {
  const denied = await gateDenied(c);
  if (denied) return denied;

  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const { title, content, visitorId, images } = await c.req.json();
  if (!title || !content) return c.json({ message: '标题和内容不能为空' }, 400);

  const post = await db.prepare('SELECT id, author_visitor, author_user_id FROM game_posts WHERE id = ?').bind(id).first<any>();
  if (!post) return c.json({ message: '帖子不存在' }, 404);

  if (!(await canAuthorOrManage(c, post, String(visitorId || '')))) return c.json({ message: '无权修改' }, 403);

  const safeImages = sanitizeImages(images);
  await db
    .prepare("UPDATE game_posts SET title = ?, content = ?, images = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .bind(title, content, JSON.stringify(safeImages), id)
    .run();

  return c.json({ ok: true });
});

routes.delete('/api/game/posts/:id', async (c) => {
  const denied = await gateDenied(c);
  if (denied) return denied;

  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const visitorId = String(body?.visitorId || '');

  const post = await db.prepare('SELECT id, author_visitor, author_user_id FROM game_posts WHERE id = ?').bind(id).first<any>();
  if (!post) return c.json({ message: '帖子不存在' }, 404);

  if (!(await canAuthorOrManage(c, post, visitorId))) return c.json({ message: '无权删除' }, 403);

  await db.prepare('DELETE FROM game_posts WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

routes.post('/api/game/posts/:id/pin', async (c) => {
  const denied = await gateDenied(c);
  if (denied) return denied;
  if (!(await requireManager(c))) return c.json({ message: '需要管理员权限' }, 403);

  const id = Number(c.req.param('id'));
  const result = await c.env.DB
    .prepare('UPDATE game_posts SET is_pinned = CASE is_pinned WHEN 0 THEN 1 ELSE 0 END WHERE id = ?')
    .bind(id)
    .run();
  if (!result.meta.changes) return c.json({ message: '帖子不存在' }, 404);
  const row = await c.env.DB.prepare('SELECT is_pinned FROM game_posts WHERE id = ?').bind(id).first<{ is_pinned: number }>();
  return c.json({ pinned: !!row?.is_pinned });
});

routes.post('/api/game/posts/:id/feature', async (c) => {
  const denied = await gateDenied(c);
  if (denied) return denied;
  if (!(await requireManager(c))) return c.json({ message: '需要管理员权限' }, 403);

  const id = Number(c.req.param('id'));
  const result = await c.env.DB
    .prepare('UPDATE game_posts SET is_featured = CASE is_featured WHEN 0 THEN 1 ELSE 0 END WHERE id = ?')
    .bind(id)
    .run();
  if (!result.meta.changes) return c.json({ message: '帖子不存在' }, 404);
  const row = await c.env.DB.prepare('SELECT is_featured FROM game_posts WHERE id = ?').bind(id).first<{ is_featured: number }>();
  return c.json({ featured: !!row?.is_featured });
});

routes.delete('/api/game/comments/:id', async (c) => {
  const denied = await gateDenied(c);
  if (denied) return denied;

  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const visitorId = String(body?.visitorId || '');

  const comment = await db.prepare('SELECT id, author_visitor, author_user_id FROM game_comments WHERE id = ?').bind(id).first<any>();
  if (!comment) return c.json({ message: '评论不存在' }, 404);

  if (!(await canAuthorOrManage(c, comment, visitorId))) return c.json({ message: '无权删除' }, 403);

  await db.prepare('DELETE FROM game_comments WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

export default routes;
