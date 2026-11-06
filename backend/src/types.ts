// 全局类型：只描述 Worker 的运行环境与账号结构，不含任何业务逻辑。
// 各模块统一从这里取类型，避免相互 import 造成循环依赖。

export type Bindings = {
  DB: D1Database;
  GAME_DB: D1Database;
  JWT_SECRET: string;
  // 图片存储（Cloudflare KV）
  IMG_KV: KVNamespace;
};

export type Variables = {
  user: { id: number; username: string };
};

export type Env = { Bindings: Bindings; Variables: Variables };

/** 登录接口里解出来的最小身份 */
export type AuthPayload = { id: number; username: string };

/** 统一账号表里的一行（论坛 / 游戏站共用） */
export type SessionUser = {
  id: number;
  username: string;
  nickname: string;
  role: string;
  is_banned: number;
};
