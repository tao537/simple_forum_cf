import { Hono } from 'hono';
import type { Env } from '../types';
import { readSettings, writeSettings } from '../lib/settings';
import { getAuth, isAdmin } from '../lib/auth';

// 界面显示设置的默认值
const DEFAULT_SETTINGS = {
  cardSize: 'large',        // large | medium | small
  density: 'comfortable',   // comfortable | compact
  imageMaxWidth: 1280,      // 图片最大宽度 px
  imageQuality: 0.8,        // 压缩质量 0.3-1
  thumbnailSize: 300,       // 缩略图尺寸 px
};

const DEFAULT_CATEGORIES = ['壁纸', '资源', '求助', '闲聊'];

const DEFAULT_SITE_CONTENT = {
  bannerTitle: '金榜题名 · 高考必胜',
  bannerSubtitle: '苦海无涯，学海作舟 —— 乾坤未定，你我皆是黑马',
  announcement: '',
  footerText: '',
};

/** 站点设置读入口：存储值叠加显示默认值（唯一入口，避免各路由各读一遍） */
async function getSiteSettings(db: D1Database): Promise<any> {
  const stored = await readSettings(db);
  return { ...DEFAULT_SETTINGS, ...stored };
}

const routes = new Hono<Env>();

// ==================== 界面显示设置 ====================

// 公开：前端读取显示设置（无需登录）
routes.get('/api/settings', async (c) => {
  const settings = await getSiteSettings(c.env.DB);
  return c.json({ settings });
});

// 管理员：更新设置（非法值一律回落到当前值，避免前端把坏配置写进来）
routes.put('/api/settings', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const body = await c.req.json();
  const incoming = (body?.settings ?? {}) as Record<string, any>;
  const current = await getSiteSettings(c.env.DB);
  const merged: any = { ...current, ...incoming };

  if (!['large', 'medium', 'small'].includes(merged.cardSize)) merged.cardSize = current.cardSize;
  if (!['comfortable', 'compact'].includes(merged.density)) merged.density = current.density;

  merged.imageMaxWidth = Number(merged.imageMaxWidth);
  if (![640, 768, 800, 1024, 1280, 1600, 1920].includes(merged.imageMaxWidth)) {
    merged.imageMaxWidth = current.imageMaxWidth;
  }
  merged.imageQuality = Number(merged.imageQuality);
  if (Number.isNaN(merged.imageQuality) || merged.imageQuality < 0.3 || merged.imageQuality > 1) {
    merged.imageQuality = current.imageQuality;
  }

  await writeSettings(c.env.DB, merged);
  return c.json({ ok: true, settings: merged });
});

// ==================== 分类管理 ====================

routes.get('/api/admin/categories', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const settings = await getSiteSettings(c.env.DB);
  return c.json({ categories: Array.isArray(settings.categories) ? settings.categories : DEFAULT_CATEGORIES });
});

routes.put('/api/admin/categories', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const { categories } = await c.req.json();
  const list = Array.isArray(categories)
    ? categories.map((x: any) => String(x || '').trim().slice(0, 20)).filter(Boolean).slice(0, 30)
    : [];
  const settings = await getSiteSettings(c.env.DB);
  settings.categories = list;
  // 只改 categories，其余字段原样写回（site_settings 只有一行，必须整行回写）
  await writeSettings(c.env.DB, settings);
  return c.json({ ok: true, categories: list });
});

// ==================== 站点文案（banner 标语 / 公告 / 页脚）====================

routes.get('/api/admin/site-content', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const settings = await getSiteSettings(c.env.DB);
  return c.json({ content: { ...DEFAULT_SITE_CONTENT, ...(settings.siteContent || {}) } });
});

routes.put('/api/admin/site-content', async (c) => {
  const payload = await getAuth(c);
  if (!payload) return c.json({ message: '请先登录' }, 401);
  if (!(await isAdmin(c, payload.id))) return c.json({ message: '需要管理员权限' }, 403);

  const { content } = await c.req.json();
  const merged = { ...DEFAULT_SITE_CONTENT, ...(content || {}) };
  merged.bannerTitle = String(merged.bannerTitle || '').slice(0, 60);
  merged.bannerSubtitle = String(merged.bannerSubtitle || '').slice(0, 120);
  merged.announcement = String(merged.announcement || '').slice(0, 500);
  merged.footerText = String(merged.footerText || '').slice(0, 300);

  const settings = await getSiteSettings(c.env.DB);
  settings.siteContent = merged;
  await writeSettings(c.env.DB, settings);
  return c.json({ ok: true, content: merged });
});

// 公开读取站点文案 + 分类（前端渲染 banner / 公告 / 页脚 / 分类）
routes.get('/api/site-content', async (c) => {
  const settings = await getSiteSettings(c.env.DB);
  return c.json({
    content: { ...DEFAULT_SITE_CONTENT, ...(settings.siteContent || {}) },
    categories: Array.isArray(settings.categories) ? settings.categories : DEFAULT_CATEGORIES,
  });
});

export { DEFAULT_SETTINGS, DEFAULT_CATEGORIES, DEFAULT_SITE_CONTENT, getSiteSettings };
export default routes;
