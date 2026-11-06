// ================================================================
//  用户域模块
//  --------------------------------------------------------------
//  职责边界：把「用户」当作数据对象来管理，不含登录态本身。
//    · 列表 / 搜索 / 删除 / 批量删除 / 封禁 / 角色
//    · 个人主页（该用户的帖子与评论聚合）
//    · 自助改密（校验旧密码 + 统一口令策略）
//  登录、注册、签发 token 属于账号域（仍在 index.ts），本模块不碰。
//  对外只暴露：default 路由。
// ================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { getAuth, isAdmin } from '../lib/auth';
import { hashPassword, verifyPassword, BAD_PASSWORDS } from '../lib/security';

const routes = new Hono<Env>();

/** 管理员网关：未登录 401 / 非管理员 403 / 通过返回 null */
async function requireAdmin(c: any) {
  const payload = await getAuth(c);
  if (!payload) return { res: c.json({ message: '请先登录' }, 401) };
  if (!(await isAdmin(c, payload.id))) return { res: c.json({ message: '需要管理员权限' }, 403) };
  return { payload };
}

// ==================== 列表 / 搜索 ====================

routes.get('/api/users', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

  const { results } = await c.env.DB
    .prepare(
      'SELECT id, username, nickname, email, role, is_banned, created_at FROM users ORDER BY id ASC'
    )
    .all();
  return c.json({ users: results });
});

routes.get('/api/users/search', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

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

// ==================== 删除 ====================

routes.delete('/api/users/:id', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

  const id = Number(c.req.param('id'));
  if (id === guard.payload!.id) return c.json({ message: '不能删除自己' }, 400);

  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: number }>();
  if (!target) return c.json({ message: '用户不存在' }, 404);

  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

routes.post('/api/users/batch-delete', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

  const { ids } = await c.req.json();
  const list = Array.isArray(ids) ? ids.map((v) => Number(v)).filter((v) => Number.isInteger(v)) : [];
  if (list.length === 0) return c.json({ message: '请提供要删除的用户 id 列表' }, 400);
  if (list.includes(guard.payload!.id)) return c.json({ message: '不能删除自己' }, 400);

  const placeholders = list.map(() => '?').join(',');
  const result = await c.env.DB
    .prepare(`DELETE FROM users WHERE id IN (${placeholders})`)
    .bind(...list)
    .run();
  return c.json({ ok: true, deleted: result.meta.changes ?? 0 });
});

// ==================== 角色 / 封禁 ====================

routes.patch('/api/users/:id/role', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  if (id === guard.payload!.id) return c.json({ message: '不能修改自己的角色' }, 400);

  const { role } = await c.req.json();
  if (role !== 'admin' && role !== 'user') {
    return c.json({ message: '角色只能是 admin 或 user' }, 400);
  }

  const target = await db.prepare('SELECT id, role FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: number; role: string }>();
  if (!target) return c.json({ message: '用户不存在' }, 404);

  // 防线：不能把最后一个管理员降级，否则后台彻底失联
  if (role !== 'admin' && target.role === 'admin') {
    const admins = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
      .first<{ n: number }>();
    if ((admins?.n ?? 0) <= 1) return c.json({ message: '至少需要保留一个管理员' }, 400);
  }

  await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id).run();
  return c.json({ ok: true });
});

routes.post('/api/users/:id/ban', async (c) => {
  const guard = await requireAdmin(c);
  if (guard.res) return guard.res;

  const id = Number(c.req.param('id'));
  if (id === guard.payload!.id) return c.json({ message: '不能封禁自己' }, 400);

  const { banned } = await c.req.json();
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: number }>();
  if (!target) return c.json({ message: '用户不存在' }, 404);

  await c.env.DB.prepare('UPDATE users SET is_banned = ? WHERE id = ?').bind(banned ? 1 : 0, id).run();
  return c.json({ ok: true, banned: !!banned });
});

// ==================== 个人主页 ====================

routes.get('/api/users/:id/profile', async (c) => {
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

// ==================== 自助改密 ====================

routes.put('/api/users/password', async (c) => {
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

export default routes;
