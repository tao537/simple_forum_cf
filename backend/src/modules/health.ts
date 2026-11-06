// ================================================================
//  站点体检模块
//  --------------------------------------------------------------
//  职责边界：把「原本要靠外部脚本 curl 六项接口才能确认的健康状态」
//  变成后台一个页面就能看的结果。只读，不改任何数据。
//
//  检查项（每项返回 ok / warn / bad + 一句人话说明）：
//    1. 公开设置是否漏字段（密码哈希有没有被整包吐出来）
//    2. 门禁开关是否开启
//    3. 门禁口令是否还是出厂默认
//    4. 管理员账号数量是否为 0
//    5. 管理员是否还在用历史默认密码
//    6. 内容数据质量（未分类帖子 / 无封面游戏帖）
//    7. 今日活跃度与数据规模
// ================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { getAuth, isAdmin } from '../lib/auth';
import { verifyPassword } from '../lib/security';
import { DEFAULT_GATE_PASSWORD, loadGate } from './gate';

const routes = new Hono<Env>();

/** 历史上被硬重置过的管理员口令，仍在用就提示（只做比对，不回显） */
const LEGACY_ADMIN_PASSWORD = 'admin@2026';
/** 公开设置允许外露的字段；出现在配置里之外的敏感键都算漏 */
const SENSITIVE_SETTING_KEYS = ['passwordHash', 'gamePasswordHash', 'jwtSecret', 'gate'];

type Level = 'ok' | 'warn' | 'bad';
function check(id: string, title: string, level: Level, detail: string) {
  return { id, title, level, detail };
}

routes.get('/api/admin/health', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const db = c.env.DB;
  const items: Array<{ id: string; title: string; level: Level; detail: string }> = [];

  // 1. 公开设置是否漏字段
  try {
    const row = await db.prepare('SELECT data FROM site_settings LIMIT 1').first<{ data: string }>();
    const raw = String(row?.data || '{}');
    const hits = SENSITIVE_SETTING_KEYS.filter((k) => raw.includes(k));
    if (hits.length) {
      items.push(check('settings-leak', '公开设置字段', 'bad',
        `站点配置里出现敏感键：${hits.join('、')}。公开接口必须按白名单返回，否则会被整包吐出。`));
    } else {
      items.push(check('settings-leak', '公开设置字段', 'ok', '站点配置里没有密码哈希等敏感键。'));
    }
  } catch {
    items.push(check('settings-leak', '公开设置字段', 'warn', '读取站点配置失败，无法确认。'));
  }

  // 2 & 3. 门禁
  try {
    const gate = await loadGate(db);
    items.push(gate.enabled
      ? check('gate-enabled', '门禁开关', 'ok', '已开启，进入游戏站需要访问密码。')
      : check('gate-enabled', '门禁开关', 'warn', '门禁是关闭的，任何知道网址的人都能直接进游戏站。'));

    if (!gate.passwordHash) {
      items.push(check('gate-default-pw', '门禁口令', 'bad', '还没有设置访问密码。'));
    } else {
      const usingDefault = await verifyPassword(DEFAULT_GATE_PASSWORD, gate.passwordHash);
      items.push(usingDefault
        ? check('gate-default-pw', '门禁口令', 'bad', '仍是出厂默认口令，等于没设密码。请到「🔐 门禁」换一个。')
        : check('gate-default-pw', '门禁口令', 'ok', '已改成自有口令。'));
    }
  } catch {
    items.push(check('gate-enabled', '门禁开关', 'warn', '读取门禁状态失败。'));
    items.push(check('gate-default-pw', '门禁口令', 'warn', '读取门禁口令状态失败。'));
  }

  // 4 & 5. 管理员
  try {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first<{ n: number }>();
    const admins = row?.n ?? 0;
    items.push(admins > 0
      ? check('admin-count', '管理员账号', 'ok', `当前有 ${admins} 个管理员。`)
      : check('admin-count', '管理员账号', 'bad', '一个管理员都没有，后台将无人可用。'));

    if (admins > 0) {
      const { results } = await db
        .prepare("SELECT username, password_hash FROM users WHERE role = 'admin' LIMIT 10")
        .all();
      const legacy: string[] = [];
      for (const r of (results as any[])) {
        if (await verifyPassword(LEGACY_ADMIN_PASSWORD, String(r.password_hash || ''))) {
          legacy.push(String(r.username));
        }
      }
      items.push(legacy.length
        ? check('admin-legacy-pw', '管理员口令强度', 'warn', `这些管理员还在用历史默认密码：${legacy.join('、')}。建议立即修改。`)
        : check('admin-legacy-pw', '管理员口令强度', 'ok', '管理员都没有在用历史默认密码。'));
    }
  } catch {
    items.push(check('admin-count', '管理员账号', 'warn', '读取管理员数量失败。'));
  }

  // 6. 内容数据质量
  try {
    const uncategorized = (await db
      .prepare("SELECT COUNT(*) AS n FROM posts WHERE category = '' OR category IS NULL")
      .first<{ n: number }>())?.n ?? 0;
    const noCover = (await db
      .prepare("SELECT COUNT(*) AS n FROM game_posts WHERE images IS NULL OR images = '' OR images = '[]'")
      .first<{ n: number }>())?.n ?? 0;
    const detail = `未分类帖子 ${uncategorized} 篇；无封面游戏帖 ${noCover} 篇。`;
    const level: Level = uncategorized + noCover > 0 ? 'warn' : 'ok';
    items.push(check('content-quality', '内容数据质量', level, detail));
  } catch {
    items.push(check('content-quality', '内容数据质量', 'warn', '统计内容数据失败。'));
  }

  // 7. 今日活跃 + 规模
  try {
    const count = async (sql: string): Promise<number> =>
      (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
    const newPosts = await count("SELECT COUNT(*) AS n FROM posts WHERE date(created_at) = date('now','localtime')");
    const newUsers = await count("SELECT COUNT(*) AS n FROM users WHERE date(created_at) = date('now','localtime')");
    const users = await count('SELECT COUNT(*) AS n FROM users');
    const posts = await count('SELECT COUNT(*) AS n FROM posts');
    const gPosts = await count('SELECT COUNT(*) AS n FROM game_posts');
    items.push(check('activity', '今日活跃与规模', 'ok',
      `今日新帖 ${newPosts}、新注册 ${newUsers}；累计用户 ${users}、帖子 ${posts}、游戏帖 ${gPosts}。`));
  } catch {
    items.push(check('activity', '今日活跃与规模', 'warn', '统计活跃数据失败。'));
  }

  const bad = items.filter((i) => i.level === 'bad').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  return c.json({ items, bad, warn, checkedAt: new Date().toISOString() });
});

export default routes;
