// ================================================================
//  装配层：只做「创建 app / 中间件 / 挂载模块 / 健康检查」
//  --------------------------------------------------------------
//  业务代码一律在各领域模块里，本文件不再写任何一条业务路由。
// ================================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { Env } from './types';
// 领域模块（各自闭环，互相之间仅在 accounts → gate 处单向依赖）
import gateRoutes from './modules/gate';
import accountRoutes from './modules/accounts';
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
app.route('/', accountRoutes);
app.route('/', userRoutes);
app.route('/', notificationRoutes);
app.route('/', adminRoutes);
app.route('/', mediaRoutes);
app.route('/', postRoutes);
app.route('/', gamePostRoutes);
app.route('/', siteRoutes);

// 健康检查
app.get('/', (c) => c.json({ ok: true, service: 'forum-api' }));

export default app;
