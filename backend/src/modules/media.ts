// ================================================================
//  媒体代理模块：音乐试听 / 小说阅读 / 影视搜索
//  统一处理「上游接口需要 CORS 与 UA、前端不能直连」的问题。
//  只做代理与数据裁剪，不涉及站内数据表。
// ================================================================

import { Hono } from 'hono';
import type { Env } from '../types';

const routes = new Hono<Env>();

// ---------------- 音乐（iTunes 搜索，30 秒预览可直接播放） ----------------

routes.get('/api/music/search', async (c) => {
  const keyword = String(c.req.query('keyword') || '').trim();
  if (!keyword) return c.json({ songs: [] });

  try {
    const resp = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(keyword)}&media=music&limit=20`
    );
    const data = await resp.json<any>();

    if (!data?.results?.length) {
      return c.json({ songs: [], error: '没找到相关歌曲' });
    }

    const songs = data.results.map((item: any) => ({
      id: item.trackId,
      name: item.trackName,
      artist: item.artistName,
      album: item.collectionName || '',
      artwork: item.artworkUrl100?.replace('100x100', '300x300') || '',
      preview: item.previewUrl || '',
      duration: Math.round(item.trackTimeMillis / 1000),
    }));

    return c.json({ songs });
  } catch (e: any) {
    console.error('音乐搜索失败:', e);
    return c.json({ songs: [], error: '搜索失败: ' + e.message });
  }
});

routes.get('/api/music/url', async (c) => {
  const id = String(c.req.query('id') || '').trim();
  if (!id) return c.json({ url: '' });

  try {
    const resp = await fetch(`https://itunes.apple.com/lookup?id=${id}`);
    const data = await resp.json<any>();
    if (data?.results?.[0]?.previewUrl) {
      return c.json({ url: data.results[0].previewUrl });
    }
  } catch (e) {
    console.error('获取播放地址失败:', e);
  }

  return c.json({ url: '' });
});

// ---------------- 小说（中文维基文库 API 代理） ----------------
// 维基文库在国内被墙，手机端只能经由本 Worker 读取；公版/自由许可文本。

const WIKISOURCE_API = 'https://zh.wikisource.org/w/api.php';
// Wikimedia 要求请求带可辨识的 User-Agent，否则可能被 403
const WIKISOURCE_UA = 'KuhaiNovel/1.0 (https://kuhai.de5.net)';

/** 统一请求维基文库 API（带 KV 缓存 1 天，减少上游压力） */
async function wsJson(c: any, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ ...params, format: 'json', utf8: '1' }).toString();
  const key = `novel:ws:${qs}`;
  try {
    const cached = await c.env.IMG_KV.get(key);
    if (cached) return JSON.parse(cached);
  } catch {
    /* KV 不可用时直接请求 */
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(`${WIKISOURCE_API}?${qs}`, {
      headers: { 'User-Agent': WIKISOURCE_UA, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`维基文库返回 ${resp.status}`);
    const data = await resp.json<any>();
    try {
      await c.env.IMG_KV.put(key, JSON.stringify(data), { expirationTtl: 86400 });
    } catch {
      /* 缓存失败不影响结果 */
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

routes.get('/api/novel/search', async (c) => {
  const keyword = String(c.req.query('keyword') || '').trim();
  if (!keyword) return c.json({ books: [] });

  try {
    const data = await wsJson(c, {
      action: 'query',
      list: 'search',
      srsearch: keyword,
      srnamespace: '0',
      srlimit: '20',
    });
    const books = (data?.query?.search || []).map((it: any) => ({
      id: it.title,
      title: it.title,
      author: '中文维基文库',
      cover: '',
      category: '',
      description: String(it.snippet || '').replace(/<[^>]+>/g, ''),
      words: it.wordcount || 0,
      status: '',
    }));
    if (!books.length) return c.json({ books: [], error: '没有找到相关作品' });
    return c.json({ books, source: '中文维基文库（CC BY-SA）' });
  } catch (e: any) {
    return c.json({ books: [], error: e.message });
  }
});

routes.get('/api/novel/chapters', async (c) => {
  const id = String(c.req.query('id') || '').trim();
  if (!id) return c.json({ chapters: [] });

  try {
    const data = await wsJson(c, {
      action: 'query',
      prop: 'links',
      titles: id,
      plnamespace: '0',
      pllimit: '500',
    });
    // MediaWiki 默认把 pages 返回成对象（以 pageid 为键），这里统一取第一个
    const pages: any = data?.query?.pages || {};
    const page: any = Array.isArray(pages) ? pages[0] : Object.values(pages)[0];
    const titles: string[] = (page?.links || []).map((l: any) => l.title);

    let chapters = titles
      .filter((t) => t.startsWith(`${id}/`))
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }))
      .map((t, i) => ({ index: i, title: t.slice(id.length + 1), link: t }));

    // 没有子页面（单页作品）时整页作为一章
    if (!chapters.length) chapters = [{ index: 0, title: id, link: id }];

    return c.json({ chapters, total: chapters.length });
  } catch (e: any) {
    return c.json({ chapters: [], error: e.message });
  }
});

routes.get('/api/novel/content', async (c) => {
  const link = String(c.req.query('link') || '').trim();
  if (!link) return c.json({ content: '' });

  try {
    const data = await wsJson(c, {
      action: 'query',
      prop: 'extracts',
      explaintext: '1',
      titles: link,
    });
    const pages: any = data?.query?.pages || {};
    const page: any = Array.isArray(pages) ? pages[0] : Object.values(pages)[0];
    const text = page?.extract || '';
    // 去掉章节页顶部的导航行（如「回目录　下一回」）
    const cleaned = text
      .split('\n')
      .filter((line: string) =>
        line.replace(/[\s\u3000]/g, '').replace(/(回目录|上一回|下一回|目錄|目录)/g, '').length > 0
      )
      .join('\n')
      .trim();
    if (!cleaned) return c.json({ content: '', error: '该页面没有可读正文' });
    return c.json({ content: cleaned, source: '中文维基文库（CC BY-SA）' });
  } catch (e: any) {
    return c.json({ content: '', error: e.message });
  }
});

// ---------------- 影视（苹果 CMS 资源站代理） ----------------

const MAC_CMS_BASE = 'https://api.apibdzy.com/api.php/provide/vod/';

routes.get('/api/video/search', async (c) => {
  const keyword = String(c.req.query('keyword') || '').trim();
  if (!keyword) return c.json({ list: [] });

  try {
    const url = `${MAC_CMS_BASE}?ac=videolist&wd=${encodeURIComponent(keyword)}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const data = await resp.json<any>();

    const list = (data?.list || []).map((item: any) => ({
      id: item.vod_id,
      name: item.vod_name,
      pic: item.vod_pic,
      blurb: item.vod_blurb || '',
      remarks: item.vod_remarks || '',
      typeName: item.type_name || '',
      year: item.vod_year || '',
      area: item.vod_area || '',
      playUrl: item.vod_play_url || '',
    }));

    return c.json({ list });
  } catch (e: any) {
    console.error('影视搜索代理失败:', e);
    return c.json({ list: [], error: '搜索失败: ' + e.message });
  }
});

export default routes;
