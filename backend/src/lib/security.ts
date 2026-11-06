// 安全基础能力：输入清洗、口令策略、密码哈希。
// 只依赖 Web Crypto，不碰数据库和路由，便于单独复用与替换。

/** 站内图片地址白名单（防存储型 XSS） */
const IMG_RE = /^(\/img\/|https:\/\/api\.kuhai\.de5\.net\/img\/)[A-Za-z0-9._-]{1,120}$/;

export function sanitizeImages(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((u): u is string => typeof u === 'string' && IMG_RE.test(u))
    .slice(0, 9);
}

/** 弱口令黑名单 */
export const BAD_PASSWORDS = new Set([
  '123456', '12345678', '123456789', '888888', '666666', '66666666',
  'admin123', 'password', 'qwerty', '11111111', '00000000',
]);

/** 注册类接口的统一口令校验，返回错误文案（null 表示通过） */
export function validateCredentials(username: unknown, password: unknown): string | null {
  const name = String(username ?? '');
  const pass = String(password ?? '');
  if (!name || !pass) return '用户名和密码不能为空';
  if (!/^[\w\u4e00-\u9fa5]{2,20}$/.test(name)) {
    return '用户名只能为 2-20 位中文、字母、数字或下划线';
  }
  if (pass.length < 8) return '密码至少 8 位';
  if (BAD_PASSWORDS.has(pass.toLowerCase())) return '密码过于简单';
  return null;
}

/** 密码哈希（PBKDF2-SHA256，100000 轮） */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100000;
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const toHex = (arr: Uint8Array) =>
    [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2$${iterations}$${toHex(salt)}$${toHex(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = new Uint8Array((parts[2].match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));
  const expected = parts[3];
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const hashHex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hashHex === expected;
}
