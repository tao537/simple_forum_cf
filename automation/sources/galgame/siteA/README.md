# 子站点：siteA（模板）

这是一个**可直接改的模板**，不是能跑的站点。`LIST_URL` 为空时它只会打印一行提示、返回空数组，
不会发任何请求。

## 三步改成一个真实站点

1. 复制成你自己的站点文件夹（文件夹名就是站点名）：

   ```bash
   cd automation/sources/galgame
   cp -r siteA siteB        # 以后就是 siteB 站点
   ```

2. 打开 `siteB/index.mjs`，改 3 处：

   | 位置 | 改什么 |
   |---|---|
   | `SITE_NAME` | 改成 `'siteB'`，**必须和文件夹名一致**（它进 id 和 `site` 字段） |
   | `LIST_URL` | 该站点的列表页地址，例如 `'https://example-galgame-site.com/new'` |
   | `parseList()` / `parsePost()` | 按该站点的 HTML 结构调整解析规则 |

3. 验证：

   ```bash
   cd automation
   node fetch.mjs galgame          # 输出 candidates/galgame-YYYY-MM-DD.json
   ```

   `sites.txt` 时代已经过去，不需要再改任何清单文件 —— 聚合器自动发现 `siteB/`。

## `parseList()` 怎么改

列表页 → 帖子详情页链接数组。模板默认规则是「挑一切看起来像详情页的 `<a href>`」：

```js
if (!/(\/\d+\.html$|\/thread\/|\/post\/|\/article\/|\/game\/)/i.test(abs)) continue;
```

换真实站点时：打开浏览器的开发者工具看看帖子链接长什么样（`/12345.html`、`/thread-123-1-1.html`、
`/game/xxx` …），把上面这条正则改成能命中它的规则；如果列表页有分页，在这里返回多页链接的并集即可。

## `parsePost()` 怎么改

帖子页 → `{ name, desc, images, links }`：

| 字段 | 模板默认取值 | 站点结构不同时怎么改 |
|---|---|---|
| `name` | `og:title` → `twitter:title` → `<title>` | 没有 og 就取正文里的 `<h1>` / `<h2>` |
| `desc` | `<article>` → `<div id="content">` → `class` 含 `post-content`/`article-content`/`entry-content` 的块 → `og:description` | 先确定"正文容器"的选择器，再交给 `htmlToText()` |
| `images` | 正文里所有 `<img>` 的 `data-src` / `data-original` / `src` | 附件图在别的容器里就改抓取范围；懒加载属性名也常不同 |
| `links` | 正文里所有 `<a href>` | 链接范围就是"正文容器"的范围，一般不用改 |

调试小技巧：把抓到的 HTML 存下来慢慢调解析规则最省事。

```js
// 临时调试用：把页面 HTML 落到 /tmp 再看
import { writeFileSync } from 'node:fs';
writeFileSync('/tmp/siteB-post.html', html, 'utf8');
```

## 图片和链接的意义

- `images`：写文案时要用的图（`images[0]` 还会被聚合器放进兼容字段 `cover`）
- `links`：帖子里出现的**所有**链接（网盘、论坛、官网、外链…）。脚本只负责采集、**不做任何判断** ——
  哪个是有效资源、是百度网盘还是夸克，由你手工筛。所以广告、友链、无关外链也会一起收进来，这是有意的。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `本模板还没配置（LIST_URL 为空），本次跳过` | 正常，还没填站点地址 |
| `列表页没解析出帖子链接` | `parseList()` 的正则没命中，按上面的方法改 |
| `没解析到标题` | `parsePost()` 的选择器不对 |
| `⚠️ http://... 抓取失败，已跳过：fetch failed（UND_ERR_CONNECT_TIMEOUT）` | 网络/代理不通（用 `./run-with-proxy.sh fetch.mjs galgame` 跑），或该站点反爬 |
| 正文有乱码 | 站点用了非常见编码，在 `fetchHtml()` 里指定 `TextDecoder` 的编码 |

## 注意

- 请求间隔保持 **2 秒**（`REQUEST_INTERVAL`），别把别人站点打挂；单站点单次别抓太多（`MAX_POSTS`）
- 不做登录、不绕验证码；需要登录才能看内容的站点请勿加入
- 本文件里的抓取逻辑只影响 `siteA` 这一个站点，写错了也不会影响别家
