// ================================================================
//  门禁（访问控制）模块
//  --------------------------------------------------------------
//  职责边界：只管「能不能进站」这一件事。
//    · 进站密码（哈希存储，首次使用默认密码自动落库）
//    · 通行证签发 / 校验（X-Gate-Token，带门禁版本号与有效期）
//    · 门禁开关、有效期、提示词、强制踢出
//  不负责账号注册/登录（那是 lib/auth.ts 的登录态），也不碰帖子业务。
//  对外只暴露：default 路由 + requireGate / loadGate / saveGate。
//  配置统一存 site_settings.data.gate，并兼容历史的
//  data.gamePasswordHash / data.gamePasswordHint 两个旧字段。
// ================================================================

import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import type { Env } from '../types';
import { getAuth, isAdmin } from '../lib/auth';
import { hashPassword, verifyPassword } from '../lib/security';
import { readSettings, writeSettings } from '../lib/settings';

export const GATE_TOKEN_HEADER = 'X-Gate-Token';
export const GATE_SCOPE = 'game';

/** 首次进入时使用的默认访问密码（落库后可在后台修改） */
export const DEFAULT_GATE_PASSWORD = '利益or节操';
export const DEFAULT_GATE_HINT =
  '本站为独立游戏分享社区，进入密码由站长管理，忘记密码请向站长索取。';
export const DEFAULT_GATE_TTL = 12 * 3600;
export const MIN_GATE_TTL = 3600; // 1 小时
export const MAX_GATE_TTL = 30 * 86400; // 30 天

export type GateConfig = {
  /** 关掉后无需密码即可进站（通行证也不再校验） */
  enabled: boolean;
  /** 空字符串表示还没设置过密码 */
  passwordHash: string;
  hint: string;
  /** 通行证有效期（秒） */
  ttl: number;
  /** 门禁版本：改密码 / 强制踢出都会 +1，旧通行证全部失效 */
  version: number;
};

function normalizeTtl(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const ttl = Math.floor(n);
  return ttl >= MIN_GATE_TTL && ttl <= MAX_GATE_TTL ? ttl : fallback;
}

/** 从设置里读出完整门禁配置（含旧字段迁移），永远返回可用对象 */
export async function loadGate(db: D1Database): Promise<GateConfig> {
  const settings = await readSettings(db);
  const raw = (settings.gate && typeof settings.gate === 'object' ? settings.gate : {}) as any;

  const hint = String(raw.hint ?? settings.gamePasswordHint ?? DEFAULT_GATE_HINT)
    .trim()
    .slice(0, 200);

  return {
    enabled: raw.enabled !== false,
    passwordHash: String(raw.passwordHash ?? settings.gamePasswordHash ?? ''),
    hint: hint || DEFAULT_GATE_HINT,
    ttl: normalizeTtl(raw.ttl, DEFAULT_GATE_TTL),
    version: Number(raw.version) >= 1 ? Math.floor(Number(raw.version)) : 1,
  };
}

/** 写回门禁配置；顺手清理旧字段，保证只有一套状态 */
export async function saveGate(db: D1Database, cfg: GateConfig): Promise<void> {
  const settings = await readSettings(db);
  settings.gate = {
    enabled: cfg.enabled,
    passwordHash: cfg.passwordHash,
    hint: cfg.hint,
    ttl: normalizeTtl(cfg.ttl, DEFAULT_GATE_TTL),
    version: Math.max(1, Math.floor(cfg.version)),
  };
  delete settings.gamePasswordHash;
  delete settings.gamePasswordHint;
  await writeSettings(db, settings);
}

/** 签发通行证（带上当前门禁版本） */
export async function issueGateToken(
  c: any,
  cfg: GateConfig,
  userId?: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, any> = {
    scope: GATE_SCOPE,
    ver: cfg.version,
    iat: now,
    exp: now + cfg.ttl,
  };
  if (userId) payload.id = userId; // 登录账号时携带账号 id，访客通行证不带
  return await sign(payload, c.env.JWT_SECRET, 'HS256');
}

/**
 * 门禁校验：通过返回 { ok: true }，否则返回 null。
 * 门禁关闭时直接放行（不需要通行证）。
 */
export async function requireGate(c: any): Promise<{ ok: true; disabled?: boolean } | null> {
  const cfg = await loadGate(c.env.DB);
  if (!cfg.enabled) return { ok: true, disabled: true };

  const token = (c.req.header(GATE_TOKEN_HEADER) || '').replace('Bearer ', '').trim();
  if (!token) return null;
  try {
    const p = await verify(token, c.env.JWT_SECRET, 'HS256');
    if (p?.scope !== GATE_SCOPE) return null;
    if (Number(p.ver) !== cfg.version) return null; // 改密码 / 踢出后旧通行证作废
    return { ok: true };
  } catch {
    return null;
  }
}

/** 门禁域的管理接口守卫：只认论坛管理员 token */
async function requireGateAdmin(c: any): Promise<boolean> {
  const payload = await getAuth(c);
  return !!payload && (await isAdmin(c, payload.id));
}

const routes = new Hono<Env>();

// ---------------- 公开接口 ----------------

/** 门禁状态：前端据此决定是否弹出密码框 */
routes.get('/api/game/gate', async (c) => {
  const cfg = await loadGate(c.env.DB);
  return c.json({
    enabled: cfg.enabled,
    hasPassword: !!cfg.passwordHash,
    hint: cfg.hint,
    ttl: cfg.ttl,
  });
});

/** 兼容旧接口：只读提示词（未进站也可读，显示在密码框上方） */
routes.get('/api/game/hint', async (c) => {
  const cfg = await loadGate(c.env.DB);
  return c.json({ hint: cfg.hint });
});

/** 进站：校验访问密码 → 签发通行证 */
routes.post('/api/game/enter', async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const password = typeof body?.password === 'string' ? body.password : '';
  const db = c.env.DB;
  const cfg = await loadGate(db);

  // 门禁关闭：直接发一张通行证，密码框里的内容忽略
  if (!cfg.enabled) {
    const token = await issueGateToken(c, cfg);
    return c.json({ token, expiresIn: cfg.ttl, disabled: true });
  }

  if (!cfg.passwordHash) {
    // 首次使用：默认密码校验通过后自动落库
    if (password !== DEFAULT_GATE_PASSWORD) {
      return c.json({ message: '访问密码错误' }, 401);
    }
    cfg.passwordHash = await hashPassword(DEFAULT_GATE_PASSWORD);
    await saveGate(db, cfg);
  } else if (!(await verifyPassword(password, cfg.passwordHash))) {
    // 历史 hash 损坏时自愈：输入默认密码可重新初始化
    if (password !== DEFAULT_GATE_PASSWORD) {
      return c.json({ message: '访问密码错误' }, 401);
    }
    cfg.passwordHash = await hashPassword(DEFAULT_GATE_PASSWORD);
    await saveGate(db, cfg);
  }

  const token = await issueGateToken(c, cfg);
  return c.json({ token, expiresIn: cfg.ttl });
});

/** 通行证有效性检查（顺带返回当前登录账号） */
routes.get('/api/game/me', async (c) => {
  if (!(await requireGate(c))) return c.json({ message: '未进入游戏站' }, 401);
  const payload = await getAuth(c);
  if (!payload) return c.json({ ok: true, user: null });
  const user = await c.env.DB
    .prepare('SELECT id, username, nickname, role, is_banned FROM users WHERE id = ?')
    .bind(payload.id)
    .first();
  return c.json({ ok: true, user: user ?? null });
});

// ---------------- 管理接口 ----------------

/** 读取门禁配置（不含哈希） */
routes.get('/api/admin/gate', async (c) => {
  if (!(await requireGateAdmin(c))) return c.json({ message: '需要管理员权限' }, 403);
  const cfg = await loadGate(c.env.DB);
  // 是否仍在用出厂默认口令：仅管理端做一次 PBKDF2 校验，用于后台红条提醒
  const usingDefaultPassword = cfg.passwordHash
    ? await verifyPassword(DEFAULT_GATE_PASSWORD, cfg.passwordHash)
    : false;
  return c.json({
    enabled: cfg.enabled,
    hasPassword: !!cfg.passwordHash,
    usingDefaultPassword,
    hint: cfg.hint,
    ttl: cfg.ttl,
    version: cfg.version,
  });
});

/** 更新门禁配置：enabled / ttl / hint / password 均可单独提交 */
routes.put('/api/admin/gate', async (c) => {
  if (!(await requireGateAdmin(c))) return c.json({ message: '需要管理员权限' }, 403);

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ message: '请求体必须是 JSON' }, 400);
  }

  const db = c.env.DB;
  const cfg = await loadGate(db);
  let passwordChanged = false;

  if (typeof body.enabled === 'boolean') {
    cfg.enabled = body.enabled;
  }

  if (body.ttl !== undefined) {
    const ttl = normalizeTtl(body.ttl, -1);
    if (ttl < 0) return c.json({ message: '有效期需在 1 小时到 30 天之间' }, 400);
    cfg.ttl = ttl;
  }

  if (body.hint !== undefined) {
    cfg.hint = String(body.hint || '').trim().slice(0, 200) || DEFAULT_GATE_HINT;
  }

  if (body.password !== undefined && body.password !== '') {
    const pw = String(body.password);
    if (pw.length < 4 || pw.length > 50) {
      return c.json({ message: '访问密码长度需 4-50 位' }, 400);
    }
    cfg.passwordHash = await hashPassword(pw);
    cfg.version += 1; // 改密码 → 已进站用户全部重新验证
    passwordChanged = true;
  }

  await saveGate(db, cfg);

  return c.json({
    ok: true,
    passwordChanged,
    gate: {
      enabled: cfg.enabled,
      hasPassword: !!cfg.passwordHash,
      hint: cfg.hint,
      ttl: cfg.ttl,
      version: cfg.version,
    },
  });
});

/** 强制踢出：版本 +1，所有已签发通行证立即失效 */
routes.post('/api/admin/gate/kick', async (c) => {
  if (!(await requireGateAdmin(c))) return c.json({ message: '需要管理员权限' }, 403);
  const db = c.env.DB;
  const cfg = await loadGate(db);
  cfg.version += 1;
  await saveGate(db, cfg);
  return c.json({ ok: true, version: cfg.version });
});

// ---------------- 兼容旧接口（前端历史调用） ----------------

routes.put('/api/admin/game/password', async (c) => {
  if (!(await requireGateAdmin(c))) return c.json({ message: '需要管理员权限' }, 403);
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ message: '请求体必须是 JSON' }, 400);
  }
  const pw = typeof body?.password === 'string' ? body.password : '';
  if (pw.length < 4 || pw.length > 50) {
    return c.json({ message: '访问密码长度需 4-50 位' }, 400);
  }
  const db = c.env.DB;
  const cfg = await loadGate(db);
  cfg.passwordHash = await hashPassword(pw);
  cfg.version += 1;
  await saveGate(db, cfg);
  return c.json({ ok: true });
});

routes.put('/api/admin/game/hint', async (c) => {
  if (!(await requireGateAdmin(c))) return c.json({ message: '需要管理员权限' }, 403);
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ message: '请求体必须是 JSON' }, 400);
  }
  const hint = String(body?.hint || '').trim().slice(0, 200) || DEFAULT_GATE_HINT;
  const db = c.env.DB;
  const cfg = await loadGate(db);
  cfg.hint = hint;
  await saveGate(db, cfg);
  return c.json({ ok: true, hint });
});

export default routes;
