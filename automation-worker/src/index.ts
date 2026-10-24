/**
 * 苦海 · 自动化发布 Worker
 *
 * Cron 每天定时跑：
 *   1. 门禁 + 管理员登录游戏站
 *   2. 抓取 shinnku 最新游戏
 *   3. 云端 AI 写推荐文案
 *   4. 发帖到游戏站
 *   5. KV 记录已发 ID（去重，不重复发）
 *
 * 部署前：
 *   1. wrangler kv:namespace create PUBLISHED  → 把 id 填进 wrangler.toml
 *   2. wrangler secret put GATE_PASSWORD
 *   3. wrangler secret put ADMIN_USERNAME
 *   4. wrangler secret put ADMIN_PASSWORD
 *   5. wrangler secret put AI_API_KEY
 */

interface Env {
  API_BASE: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
  AI_API_KEY: string;      // secret
  GATE_PASSWORD: string;    // secret
  ADMIN_USERNAME: string;  // secret
  ADMIN_PASSWORD: string;  // secret
  MAX_PER_RUN: string;
  PUBLISHED: KVNamespace;
}

interface GameItem {
  id: string;
  name: string;
  fileUrl: string;
  intro: string;
  section: string;
}

// ---------- HTTP 工具 ----------
async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text) }; }
  catch { return { status: r.status, data: text }; }
}

async function getText(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers });
  return { status: r.status, text: await r.text() };
}

// ---------- 1. 登录游戏站 ----------
async function loginGameStation(env: Env): Promise<{ gateToken: string; authToken: string }> {
  // 门禁
  const gate = await postJson(`${env.API_BASE}/api/game/enter`, { password: env.GATE_PASSWORD });
  if (gate.status !== 200) throw new Error(`门禁失败: ${gate.status} ${JSON.stringify(gate.data)}`);
  const gateToken = (gate.data as { token: string }).token;

  // 账号登录
  const login = await postJson(`${env.API_BASE}/api/game/login`, {
    username: env.ADMIN_USERNAME,
    password: env.ADMIN_PASSWORD,
  });
  if (login.status !== 200) throw new Error(`登录失败: ${login.status} ${JSON.stringify(login.data)}`);
  const authToken = (login.data as { token: string }).token;

  return { gateToken, authToken };
}

// ---------- 2. 抓取 shinnku 最新游戏 ----------
async function fetchShinnkuLatest(limit: number): Promise<GameItem[]> {
  const SITE = 'https://www.shinnku.com';
  const DL_BASE = 'https://zd.shinnku.top/file/shinnku/';

  // 请求目录页（带 RSC 头拿飞行数据）
  const { status, text } = await getText(`${SITE}/files/shinnku/zd`, {
    'RSC': '1',
  });
  if (status !== 200) throw new Error(`shinnku 目录页抓取失败: ${status}`);

  // 从 RSC 数据里抠文件对象（简化版：匹配 {"type":"file","name":...,"info":{"file_path":...,"upload_timestamp":...}}）
  const fileRegex = /\{"type":"file","name":"([^"]+)","info":\{"file_path":"([^"]+)","upload_timestamp":(\d+)[^}]*\}/g;
  const items: GameItem[] = [];
  let m: RegExpExecArray | null;

  while ((m = fileRegex.exec(text)) !== null && items.length < limit * 3) {
    const [, name, filePath, ts] = m;
    // 清洗文件名（去掉 [日期][社团] 前缀和后缀）
    const cleanName = name
      .replace(/\.(rar|7z|zip|apk)$/i, '')
      .replace(/^\[[^\]]+\]\s*/, '')
      .trim();

    items.push({
      id: `shinnku-${filePath}`,
      name: cleanName,
      fileUrl: DL_BASE + filePath.split('/').map(encodeURIComponent).join('/'),
      intro: '',
      section: '熟肉',
    });
  }

  // 按时间倒序取前 N
  items.sort((a, b) => b.id.localeCompare(a.id));
  return items.slice(0, limit);
}

// ---------- 3. AI 写文案 ----------
async function generatePost(env: Env, game: GameItem): Promise<{ title: string; content: string }> {
  const prompt = `你是游戏推荐博主。为以下游戏写一篇推荐帖：

游戏名：${game.name}
下载链接：${game.fileUrl}
分区：${game.section}

要求：
1. 标题吸引人，带游戏名
2. 正文 200-400 字，介绍游戏类型、亮点、适合人群
3. 结尾附上下载链接
4. 用 Markdown 格式
5. 不要编造具体剧情，泛泛介绍即可

只输出 JSON：{"title": "...", "content": "..."}`;

  const r = await fetch(`${env.AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    }),
  });

  if (!r.ok) throw new Error(`AI 调用失败: ${r.status}`);
  const data = await r.json() as { choices: { message: { content: string } }[] };
  const raw = data.choices[0].message.content.trim();

  // 提取 JSON
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { title: parsed.title, content: parsed.content };
    }
  } catch { /* fallthrough */ }

  // 解析失败就用兜底
  return {
    title: game.name,
    content: `## ${game.name}\n\n**下载地址**：${game.fileUrl}\n\n（AI 文案生成失败，请人工补充介绍）`,
  };
}

// ---------- 3.5 搜索 Steam 封面图 ----------
async function findSteamCover(gameName: string): Promise<string | null> {
  try {
    const r = await fetch(
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&l=schinese&cc=cn`
    );
    if (!r.ok) return null;
    const data = await r.json() as { items: { id: number; name: string }[] };
    if (!data.items?.length) return null;
    const appid = data.items[0].id;
    return `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`;
  } catch {
    return null;
  }
}

// ---------- 4. 发帖 ----------
async function postToGameStation(
  env: Env,
  tokens: { gateToken: string; authToken: string },
  game: GameItem,
  post: { title: string; content: string },
) {
  // 自动搜索 Steam 封面图
  const cover = await findSteamCover(game.name);
  const images = cover ? [cover] : [];

  const r = await postJson(
    `${env.API_BASE}/api/game/posts`,
    { title: post.title, content: post.content, images },
    {
      'X-Gate-Token': tokens.gateToken,
      'Authorization': `Bearer ${tokens.authToken}`,
    },
  );
  if (r.status !== 201) throw new Error(`发帖失败: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data as { id: number };
}

// ---------- 主流程 ----------
export default {
  // Cron 触发
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runPipeline(env));
  },

  // HTTP 手动触发（方便测试：GET /run）
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      const result = await runPipeline(env);
      return Response.json(result);
    }
    return new Response('OK', { status: 200 });
  },
};

async function runPipeline(env: Env) {
  const log: string[] = [];
  const logLine = (s: string) => { console.log(s); log.push(s); };

  try {
    logLine('=== 流水线开始 ===');

    // 0. 检查今天是否已经发够 3 个
    const today = new Date().toISOString().slice(0, 10);
    const todayKey = `posted_count_${today}`;
    const todayCount = parseInt((await env.PUBLISHED.get(todayKey)) || '0', 10);
    const target = parseInt(env.MAX_PER_RUN || '3', 10);
    if (todayCount >= target) {
      logLine(`⏭️  今天已经发了 ${todayCount} 个，目标 ${target} 个，跳过`);
      return { ok: true, skipped: true, posted: 0, reason: 'already_done', log };
    }
    logLine(`今天已发 ${todayCount}/${target} 个，继续抓`);

    // 1. 登录
    logLine('登录游戏站...');
    const tokens = await loginGameStation(env);
    logLine('✅ 登录成功');

    // 2. 抓取 50 条，从中选没发过的
    const need = target - todayCount;
    logLine(`抓取 shinnku 最新 50 条，需要选 ${need} 个新的...`);
    const games = await fetchShinnkuLatest(50);
    logLine(`抓到 ${games.length} 个游戏`);

    // 3. 逐个处理（去重，发够 need 个就停）
    let posted = 0;
    let skipped = 0;
    for (const game of games) {
      if (posted >= need) break; // 发够了就停

      // KV 去重
      const seen = await env.PUBLISHED.get(game.id);
      if (seen) {
        skipped++;
        logLine(`⏭️  跳过（已发过）: ${game.name}`);
        continue;
      }

      logLine(`📝 AI 写文案: ${game.name}`);
      const post = await generatePost(env, game);

      logLine(`📤 发帖: ${post.title}`);
      await postToGameStation(env, tokens, game, post);

      // 记录已发
      await env.PUBLISHED.put(game.id, new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 90 }); // 保留 90 天
      posted++;
      logLine(`✅ 已发: ${game.name}`);
    }

    // 4. 更新今天已发计数
    const newCount = todayCount + posted;
    await env.PUBLISHED.put(todayKey, String(newCount), { expirationTtl: 60 * 60 * 24 }); // 保留 1 天
    logLine(`今日累计已发: ${newCount}/${target}`);

    logLine(`=== 完成：本次发 ${posted} 条，跳过 ${skipped} 条 ===`);
    return { ok: true, posted, skipped, todayCount: newCount, log };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine(`❌ 失败: ${msg}`);
    return { ok: false, error: msg, log };
  }
}
