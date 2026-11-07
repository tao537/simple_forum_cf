// ================================================================
//  举报模块（reports）
//  --------------------------------------------------------------
//  职责边界：只记录与流转「举报工单」，不删帖、不封人。
//  处置动作仍然由管理员在原有页面里做——本模块只把工单状态改成
//  done / ignored 并留下处理备注。
//
//  存储选型：KV（IMG_KV）而不是 D1。
//  原因：举报属于低频、少量、按前缀就能列出来的东西，
//  用 KV 可以零迁移上线（不需要给 D1 加表、不需要跑 SQL），
//  代价是只支持按键前缀列举、不支持复杂查询——对"待处理工单"
//  这个场景够用。同一份 KV 已经被图片模块使用，不新增绑定。
//
//  路由：
//    POST   /api/reports                提交举报（需登录）
//    GET    /api/admin/reports          列出工单（管理员，?status=open|done|ignored|all）
//    PATCH  /api/admin/reports/:key     改状态 + 备注（管理员）
// ================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { getSessionUser, isAdminUser } from '../lib/auth';

const routes = new Hono<Env>();

const PREFIX = 'report:';
const TARGET_TYPES = ['post', 'game-post'];
const STATUSES = ['open', 'done', 'ignored'];
const MAX_REASON = 200;

type Report = {
  key: string;
  targetType: string;
  targetId: number | string;
  targetTitle: string;
  reason: string;
  reporter: string;
  reporterId: number;
  status: 'open' | 'done' | 'ignored';
  note: string;
  createdAt: number;
  handledAt: number | null;
  handledBy: string;
};

function kv(env: Env['Bindings']) {
  return env.IMG_KV;
}

function randHex(n: number): string {
  const chars = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

/** 提交举报：登录用户对某个帖子提交，同一人同一目标只保留一条未处理的工单 */
routes.post('/api/reports', async (c) => {
  const me = await getSessionUser(c);
  if (!me) return c.json({ message: '请先登录后再举报' }, 401);

  const store = kv(c.env);
  if (!store) return c.json({ message: '举报存储未配置，请联系管理员' }, 503);

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ message: '请求体不是合法 JSON' }, 400);
  }

  const targetType = String(body.targetType || '').trim();
  if (!TARGET_TYPES.includes(targetType)) {
    return c.json({ message: '举报对象类型不对' }, 400);
  }
  const targetId = Number(body.targetId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return c.json({ message: '举报对象 id 不对' }, 400);
  }
  const reason = String(body.reason || '').trim().slice(0, MAX_REASON);
  if (reason.length < 2) {
    return c.json({ message: '请写一句举报理由（至少 2 个字）' }, 400);
  }
  const targetTitle = String(body.targetTitle || '').trim().slice(0, 120);

  // 同一个人对同一个目标的未处理工单：不重复堆叠，直接告诉他已在队列里
  const list = await store.list({ prefix: PREFIX, limit: 200 });
  for (const k of list.keys) {
    const raw = await store.get(k.name);
    if (!raw) continue;
    try {
      const r = JSON.parse(raw) as Report;
      if (r.status === 'open' && r.reporterId === me.id
          && r.targetType === targetType && String(r.targetId) === String(targetId)) {
        return c.json({ ok: true, duplicated: true, message: '你已经举报过这一条，管理员还没处理' });
      }
    } catch {
      continue;
    }
  }

  const now = Date.now();
  const key = `${PREFIX}${now}-${randHex(6)}`;
  const report: Report = {
    key,
    targetType,
    targetId,
    targetTitle,
    reason,
    reporter: me.username,
    reporterId: me.id,
    status: 'open',
    note: '',
    createdAt: now,
    handledAt: null,
    handledBy: '',
  };

  await store.put(key, JSON.stringify(report), { expirationTtl: 180 * 24 * 3600 });
  return c.json({ ok: true, key });
});

/** 列出工单：默认只给未处理的，按时间倒序 */
routes.get('/api/admin/reports', async (c) => {
  if (!(await isAdminUser(c))) return c.json({ message: '需要管理员权限' }, 403);

  const store = kv(c.env);
  if (!store) return c.json({ message: '举报存储未配置' }, 503);

  const status = String(c.req.query('status') || 'open');
  if (status !== 'all' && !STATUSES.includes(status)) {
    return c.json({ message: 'status 只能是 open / done / ignored / all' }, 400);
  }

  const keys: string[] = [];
  let cursor: string | undefined = undefined;
  for (;;) {
    const page: KVNamespaceListResult<unknown> = await store.list({ prefix: PREFIX, limit: 200, cursor } as any);
    for (const k of page.keys) keys.push(k.name);
    if (page.list_complete) break;
    cursor = (page as { cursor?: string }).cursor;
    if (!cursor) break;
  }

  const items: Report[] = [];
  // 分批取值，避免一次并发读出几百条
  for (let i = 0; i < keys.length; i += 20) {
    const batch = keys.slice(i, i + 20);
    const vals = await Promise.all(batch.map((k) => store.get(k)));
    for (const raw of vals) {
      if (!raw) continue;
      try {
        const r = JSON.parse(raw) as Report;
        if (status !== 'all' && r.status !== status) continue;
        items.push(r);
      } catch {
        continue;
      }
    }
  }

  items.sort((a, b) => b.createdAt - a.createdAt);
  const counts = { open: 0, done: 0, ignored: 0 };
  // counts 要在全量上算，所以再读一遍不合适；这里用已读到的最全量近似：
  // 若当前是过滤后的列表，另给一个轻量统计接口代价太大，故只在 status=all 时精确。
  return c.json({ items: items.slice(0, 200), total: items.length, status });
});

/** 处理工单：只改状态与备注，不碰帖子本身 */
routes.patch('/api/admin/reports/:key', async (c) => {
  if (!(await isAdminUser(c))) return c.json({ message: '需要管理员权限' }, 403);

  const store = kv(c.env);
  if (!store) return c.json({ message: '举报存储未配置' }, 503);

  const key = decodeURIComponent(c.req.param('key'));
  if (!key.startsWith(PREFIX)) return c.json({ message: '工单编号不对' }, 400);

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ message: '请求体不是合法 JSON' }, 400);
  }

  const status = String(body.status || '');
  if (!STATUSES.includes(status)) {
    return c.json({ message: '状态只能是 open / done / ignored' }, 400);
  }
  const note = String(body.note || '').trim().slice(0, MAX_REASON);

  const raw = await store.get(key);
  if (!raw) return c.json({ message: '工单不存在或已过期' }, 404);

  let report: Report;
  try {
    report = JSON.parse(raw) as Report;
  } catch {
    return c.json({ message: '工单内容损坏' }, 500);
  }

  const me = await getSessionUser(c);
  report.status = status as Report['status'];
  report.note = note;
  report.handledAt = status === 'open' ? null : Date.now();
  report.handledBy = status === 'open' ? '' : String(me?.username || '');

  await store.put(key, JSON.stringify(report), { expirationTtl: 180 * 24 * 3600 });
  return c.json({ ok: true, report });
});

export default routes;
