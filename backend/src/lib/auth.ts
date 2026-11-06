// 鉴权内核：签发/解析登录 token、实时校验封禁、管理员判定。
// 门禁（gate）与登录态是两套独立机制：这里只负责「统一账号登录态」，
// 门禁通行证由 modules/gate.ts 自己管理，互不耦合。

import { sign, verify } from 'hono/jwt';
import type { AuthPayload, SessionUser } from '../types';

/** 登录 token 有效期：7 天 */
export const TOKEN_TTL_SECONDS = 7 * 24 * 3600;

export async function issueToken(
  c: any,
  u: { id: number; username: string; role: string }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await sign(
    { id: u.id, username: u.username, role: u.role, iat: now, exp: now + TOKEN_TTL_SECONDS },
    c.env.JWT_SECRET,
    'HS256'
  );
}

function bearer(c: any, header: string): string {
  return (c.req.header(header) || '').replace('Bearer ', '').trim();
}

/** 解析 Authorization → 登录身份；被封禁的账号立即失效 */
export async function getAuth(c: any): Promise<AuthPayload | null> {
  const token = bearer(c, 'Authorization');
  if (!token) return null;
  try {
    const p = await verify(token, c.env.JWT_SECRET, 'HS256');
    const id = Number(p.id);
    if (!Number.isInteger(id)) return null;

    // 实时校验封禁状态（封禁立即生效）
    const row = await c.env.DB
      .prepare('SELECT is_banned FROM users WHERE id = ?')
      .bind(id)
      .first<{ is_banned: number }>();
    if (!row || row.is_banned) return null;

    return { id, username: String(p.username) };
  } catch {
    return null;
  }
}

export async function isAdmin(c: any, userId: number): Promise<boolean> {
  const me = await c.env.DB
    .prepare('SELECT role FROM users WHERE id = ?')
    .bind(userId)
    .first<{ role: string }>();
  return me?.role === 'admin';
}

/** 登录账号的完整信息（论坛与游戏站共用同一张 users 表） */
export async function getSessionUser(c: any): Promise<SessionUser | null> {
  const token = bearer(c, 'Authorization');
  if (!token) return null;
  try {
    const p = await verify(token, c.env.JWT_SECRET, 'HS256');
    const id = Number(p.id);
    if (!Number.isInteger(id)) return null;
    const user = await c.env.DB
      .prepare('SELECT id, username, nickname, role, is_banned FROM users WHERE id = ?')
      .bind(id)
      .first<SessionUser>();
    if (!user || user.is_banned) return null;
    return user;
  } catch {
    return null;
  }
}

/** 当前登录者是否为管理员（未登录 / 已封禁 / 非管理员都为 false） */
export async function isAdminUser(c: any): Promise<boolean> {
  const u = await getSessionUser(c);
  return !!u && u.role === 'admin' && !u.is_banned;
}
