// ================================================================
//  通知域模块
//  --------------------------------------------------------------
//  职责边界：只做「当前登录用户收件箱」的读与标记已读。
//    · 列表（最近 50 条，带来源用户名）
//    · 未读计数
//    · 单条已读 / 全部已读
//  「产生通知」不属于这里：写通知走 lib/notify.ts 的 addNotification，
//  由帖子、评论等业务模块在动作发生时调用。
// ================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { getAuth } from '../lib/auth';

const routes = new Hono<Env>();

routes.get('/api/notifications', async (c) => {
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

routes.get('/api/notifications/unread', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  const row = await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
    .bind(payload.id)
    .first<{ n: number }>();
  return c.json({ count: row?.n ?? 0 });
});

// 前端使用 POST；原实现为 PUT，已对齐
routes.post('/api/notifications/:id/read', async (c) => {
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

routes.post('/api/notifications/all/read', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);

  await c.env.DB
    .prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0')
    .bind(payload.id)
    .run();
  return c.json({ ok: true });
});

export default routes;
