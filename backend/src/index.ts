import { Hono } from 'hono';
import { cors } from 'hono/cors';

// 共享内核：安全 / 鉴权，各管一件事，被各领域模块按需引用
import type { Env } from './types';
import { validateCredentials, hashPassword, verifyPassword, BAD_PASSWORDS } from './lib/security';
import { issueToken, getAuth, TOKEN_TTL_SECONDS } from './lib/auth';
// 领域模块：门禁、用户、通知、媒体、论坛帖子、游戏帖子、站点配置、管理后台；各自闭环
import gateRoutes, { requireGate } from './modules/gate';
import userRoutes from './modules/users';
import notificationRoutes from './modules/notifications';
import adminRoutes from './modules/admin';
import mediaRoutes from './modules/media';
import postRoutes from './modules/posts';
import gamePostRoutes from './modules/game-posts';
import siteRoutes from './modules/site';

const app = new Hono<Env>();

app.use('*', cors({
  origin: ['https://kuhai.de5.net', 'https://www.kuhai.de5.net', 'https://api.kuhai.de5.net'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Gate-Token'],
  maxAge: 600,
}));

app.route('/', gateRoutes);
app.route('/', userRoutes);
app.route('/', notificationRoutes);
app.route('/', adminRoutes);
app.route('/', mediaRoutes);
app.route('/', postRoutes);
app.route('/', gamePostRoutes);
app.route('/', siteRoutes);

// ==================== 健康检查 ====================
app.get('/', (c) => c.json({ ok: true, service: 'forum-api' }));

// ==================== 认证 ====================
const handleRegister = async (c: any) => {
  const { username, email, password, nickname } = await c.req.json();

  const credError = validateCredentials(username, password);
  if (credError) return c.json({ message: credError }, 400);

  const finalEmail = email || `${username}@local`;

  const db = c.env.DB;
  const exists = await db
    .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .bind(username, finalEmail)
    .first();

  if (exists) return c.json({ message: '用户名或邮箱已被注册' }, 409);

  const hash = await hashPassword(password);
  // 新用户一律为普通角色，管理员由数据库手工授予
  const role = 'user';

  const result = await db
    .prepare('INSERT INTO users (username, email, password_hash, nickname, role) VALUES (?, ?, ?, ?, ?)')
    .bind(username, finalEmail, hash, nickname || '', role)
    .run();

  const id = result.meta.last_row_id as number;
  const token = await issueToken(c, { id, username, role });
  return c.json({ token, user: { id, username, nickname: nickname || '', role } }, 201);
};

const handleLogin = async (c: any) => {
  const { username: identifier, password } = await c.req.json();
  const db = c.env.DB;

  const user = await db
    .prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .bind(identifier, identifier)
    .first<{ id: number; username: string; nickname: string; role: string; password_hash: string; is_banned: number }>();

  if (!user) return c.json({ message: '用户名或密码错误' }, 401);
  if (user.is_banned) return c.json({ message: '账号已被封禁' }, 403);

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return c.json({ message: '用户名或密码错误' }, 401);

  const token = await issueToken(c, { id: user.id, username: user.username, role: user.role });
  return c.json({
    token,
    user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role },
  });
};

// 注册路由：/api/auth/* 为原路径，/api/users/* 为前端兼容路径（共用同一处理函数）
app.post('/api/auth/register', handleRegister);
app.post('/api/users/register', handleRegister);
app.post('/api/auth/login', handleLogin);
app.post('/api/users/login', handleLogin);

app.get('/api/auth/me', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '未登录' }, 401);
  // 以库里为准返回，角色变更（提升/降级）无需重新登录即可生效
  const row = await c.env.DB
    .prepare('SELECT id, username, nickname, role FROM users WHERE id = ?')
    .bind(payload.id)
    .first<{ id: number; username: string; nickname: string; role: string }>();
  if (!row) return c.json({ message: '用户不存在' }, 404);
  return c.json({ user: { id: row.id, username: row.username, nickname: row.nickname, role: row.role } });
});

// 游戏站注册（账号已与论坛统一，写入 forum-db.users；先进站后可注册）
// 合并后不再"首账号自动 admin"：游戏管理员即统一 role=admin 用户（论坛管理员天然可管理游戏站）
app.post('/api/game/register', async (c) => {
  if (!(await requireGate(c))) return c.json({ message: '请输入访问密码进入游戏站' }, 401);
  const { username, password, nickname, email } = await c.req.json();
  const name = String(username || '').trim();
  const pw = String(password || '');
  const nick = String(nickname || '').trim().slice(0, 20) || name;
  if (!/^[a-zA-Z0-9_\-\u4e00-\u9fa5]{2,20}$/.test(name)) {
    return c.json({ message: '用户名需 2-20 位（字母/数字/下划线/中文）' }, 400);
  }
  // 口令策略与论坛注册保持一致：至少 8 位 + 弱口令黑名单（统一账号库，不能留第二个口子）
  if (pw.length < 8) return c.json({ message: '密码至少 8 位' }, 400);
  if (BAD_PASSWORDS.has(pw.toLowerCase())) return c.json({ message: '密码过于简单' }, 400);
  // email：用户填了就校验，没填自动生成占位（以后可在个人资料补）
  let mail = String(email || '').trim();
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return c.json({ message: '邮箱格式不正确' }, 400);
  }
  const db = c.env.DB;
  if (!mail) {
    const randHex = (n) => {
      const b = new Uint8Array(n);
      crypto.getRandomValues(b);
      return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, n);
    };
    do { mail = `game_${randHex(8)}@kuhai.local`; }
    while (await db.prepare('SELECT id FROM users WHERE email = ?').bind(mail).first());
  }
  const role = 'user';
  const hash = await hashPassword(pw);
  try {
    await db
      .prepare('INSERT INTO users (username, email, password_hash, nickname, role) VALUES (?, ?, ?, ?, ?)')
      .bind(name, mail, hash, nick, role)
      .run();
  } catch {
    return c.json({ message: '用户名或邮箱已被注册' }, 409);
  }
  return c.json({ ok: true, role, message: '注册成功，请登录' });
});

// 游戏站登录（账号已与论坛统一；成功后签发统一 token，可在论坛/游戏站通用）
app.post('/api/game/login', async (c) => {
  if (!(await requireGate(c))) return c.json({ message: '请输入访问密码进入游戏站' }, 401);
  const { username, password } = await c.req.json();
  const db = c.env.DB;
  const user = await db
    .prepare('SELECT * FROM users WHERE username = ?')
    .bind(String(username || '').trim())
    .first<any>();
  if (!user || !(await verifyPassword(String(password || ''), user.password_hash))) {
    return c.json({ message: '账号或密码错误' }, 401);
  }
  if (user.is_banned) return c.json({ message: '账号已被封禁' }, 403);
  const token = await issueToken(c, { id: user.id, username: user.username, role: user.role }); // 统一 token（SSO）
  return c.json({
    token,
    expiresIn: TOKEN_TTL_SECONDS,
    user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role },
  });
});

export default app;
