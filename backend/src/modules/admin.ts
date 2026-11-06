// ================================================================
//  管理后台域模块
//  --------------------------------------------------------------
//  职责边界：只服务「后台面板」调用的接口，全部要求论坛管理员身份。
//    · 站点统计仪表盘（用户/帖子/评论/点赞今日增量/分类分布/热门帖）
//    · 游戏站管理增强（统计、帖子列表、删除、置顶、精选、改图）
//    · CSV 导出（帖子 / 用户，含 UTF-8 BOM 与防公式注入）
//  唯一的外部依赖：读取门禁状态时用 gate 模块公开的 loadGate（单向、只读），
//  以免把门禁配置结构在第二处再解析一遍。
// ================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { getAuth, isAdmin } from '../lib/auth';
import { loadGate } from './gate';

const routes = new Hono<Env>();

/** 管理员网关：未登录 401 / 非管理员 403 / 通过返回 null */
async function requireAdmin(c: any) {
  const payload = await getAuth(c);
  if (!payload) return { res: c.json({ message: '请先登录' }, 401) };
  if (!(await isAdmin(c, payload.id))) return { res: c.json({ message: '需要管理员权限' }, 403) };
  return { payload };
}

// ==================== 站点统计仪表盘 ====================

routes.get('/api/admin/stats', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

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

// ==================== 游戏站管理 ====================

routes.get('/api/admin/game/stats', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

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

routes.get('/api/admin/game/posts', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

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

routes.delete('/api/admin/game/posts/:id', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

  const id = Number(c.req.param('id'));
  const result = await c.env.DB.prepare('DELETE FROM game_posts WHERE id = ?').bind(id).run();
  if (!result.meta.changes) return c.json({ message: '帖子不存在' }, 404);
  return c.json({ ok: true });
});

// 管理后台专用：游戏帖置顶/精选（仅需论坛管理员身份，不依赖游戏 token）
routes.post('/api/admin/game/posts/:id/pin', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

  const id = Number(c.req.param('id'));
  const result = await c.env.DB
    .prepare('UPDATE game_posts SET is_pinned = CASE is_pinned WHEN 0 THEN 1 ELSE 0 END WHERE id = ?')
    .bind(id)
    .run();
  if (!result.meta.changes) return c.json({ message: '帖子不存在' }, 404);
  const row = await c.env.DB.prepare('SELECT is_pinned FROM game_posts WHERE id = ?')
    .bind(id)
    .first<{ is_pinned: number }>();
  return c.json({ pinned: !!row?.is_pinned });
});

routes.post('/api/admin/game/posts/:id/feature', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

  const id = Number(c.req.param('id'));
  const result = await c.env.DB
    .prepare('UPDATE game_posts SET is_featured = CASE is_featured WHEN 0 THEN 1 ELSE 0 END WHERE id = ?')
    .bind(id)
    .run();
  if (!result.meta.changes) return c.json({ message: '帖子不存在' }, 404);
  const row = await c.env.DB.prepare('SELECT is_featured FROM game_posts WHERE id = ?')
    .bind(id)
    .first<{ is_featured: number }>();
  return c.json({ featured: !!row?.is_featured });
});

// 更新帖子图片
routes.put('/api/admin/game/posts/:id/images', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

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

// ==================== 数据导出（CSV）====================

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

routes.get('/api/admin/export/posts', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

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

routes.get('/api/admin/export/users', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

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

export default routes;
