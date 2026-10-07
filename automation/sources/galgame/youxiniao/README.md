# 子站点：youxiniao（游戏鸟手游网 · 安卓频道）

这是 `sources/galgame/` 下的一个**真实站点**（不是模板）：抓 <https://www.youxiniao.com/android/>
里的安卓游戏，产出可直接进 `review.mjs` 的候选数据。

## 一句话流程

列表页（`/android/`）→ 逐个详情页 → **再请求一次下载接口** `GET /downs/detail/<id>/<type>` → 合并成一条候选。

## 站点信息

| 项目 | 值 |
|---|---|
| `SITE_NAME` | `youxiniao`（必须与文件夹名一致，它进 id 和 source 字段） |
| `LIST_URL` | `https://www.youxiniao.com/android/` |
| 详情页 URL | `/game/<拼音slug>/`、`/soft/<拼音slug>/`（**无数字 id**、末尾带斜杠） |
| 每页条数 | 28 条，**没有翻页器** |
| 想要更多 / 更新的条目 | 把 `LIST_URL` 换成 `https://www.youxiniao.com/new/Game_1.html`（时间倒序的「游戏更新」列表，`Game_N.html` 可翻页，实测 47 / 45 条每页，N 很大也是 200） |
| 请求节奏 | 帖子之间 2 秒（`REQUEST_INTERVAL`）；同一条内「详情页 → 下载接口」之间 1 秒（`API_INTERVAL`） |

## 三个必须知道的坑（改代码前先读）

### 1. 详情页没有 `og:` 标签，标题只能取 `<h1>`

`<title>` 是「正当防卫3手机版下载-正当防卫3手机版免费下载地址v1.0.15092314 - 游戏鸟」——
又长又带站名尾巴。所以 `parsePost()` 取 `<h1>`（在 `<div class="info"><dl><dt>` 里，全页唯一）。

### 2. 下载地址不在静态 HTML 里 —— 必须调下载接口

页面上的下载按钮是 JS 行为，`href` 是 `javascript:;`：

```html
<div class="downBtn downbtn" id="2671839" type="1">
  <a class="adrBtn adr" href="javascript:;" rel="nofollow"><p><strong>安卓下载</strong>
    <i class="panbaidu" style="display:none;">通过网盘下载获取资源</i></p></a>
</div>
```

逻辑在 <https://www.youxiniao.com/pc/v1/js/gameBDetail.js>：`$.get('/downs/detail/' + id + '/' + type)`。
我们照做 —— `GET https://www.youxiniao.com/downs/detail/<id>/<type>`（带 `Referer: 详情页URL` +
`X-Requested-With`）返回：

```json
{"code":1,"data":{"name":"正当防卫3手机版免费下载地址",
 "and_url":"https://…/zdfw3941400.apk?tk=<临时token>","ios_url":"",
 "pc_url":"https://lddl01.ldmnq.com/downloader/ldplayerinst9.exe?n=…",
 "and_ver":"v1.0.15092314","and_size":"593.00","type":"角色扮演","icon":"https://…_APP.png","cate":"game"}}
```

因此 **`parsePost()` 改成了 `async`**，`fetchGames()` 里的调用处是 `await parsePost(html, url)`。
`and_url` 有时是网盘直链（`pan.xunlei.com` / `pan.quark.cn` / `pan.baidu.com` / `123pan.com`）——
前端就是靠这个判断要不要显示「通过网盘下载获取资源」。

⚠️ 两个坑中坑：

- `and_url` / `ios_url` / `pc_url` 里**空的必须先跳过**：`absoluteUrl('', base)` 会返回站点首页，
  会把「<https://www.youxiniao.com/>」当成下载链接写进 `links`。
- `and_url` 带 `tk=` 临时 token，**有时效**。抓完尽快人工确认，过期就重抓。

### 3. 图片有 Referer 防盗链

`https://pic1.youxiniao.com/...` 不带 Referer 一律 **403 Forbidden（denied by Referer ACL，Tengine）**；
白名单是 `*.youxiniao.com`，**用图片自己的 origin 当 Referer 就能过**：

```bash
curl -H 'Referer: https://pic1.youxiniao.com/' 'https://pic1.youxiniao.com/yxn/….jpg'   # 200  image/jpeg
curl 'https://pic1.youxiniao.com/yxn/….jpg'                                              # 403  403.html
```

⚠️ 当前 `publish-game.mjs` 的 `downloadDirect()` / `downloadViaProxy()` 下载图片时**没有带 Referer**，
直接发这些图会被 403，`sniffImage()` 会判成「魔数不是 jpg/png/webp/gif」。
发游戏鸟的条目之前要先处理这一点（下载图片时带上图片 origin 作为 Referer）。

## 图片用的是哪些

- **截图**：`alt` 形如「<标题>截图1」的 `<img src="…jpg">`，实测 4 张、2560×1600。
  `images[0]` 会被聚合器当 `cover`，所以**截图放最前**。
- **图标**：`<div class="bgpic"><img src="…_APP.png">` 只有 **120×120**，太小，
  **仅在没有截图时兜底**，不跟截图混放（否则论坛「游戏截图」区块里会多出一张小图标）。

## 怎么验证

```bash
cd automation
node --check sources/galgame/youxiniao/index.mjs    # 语法检查
node fetch.mjs galgame                              # 真跑（生成 candidates/galgame-YYYY-MM-DD.json）
```

只想单独跑本站点、不写仓库文件：

```bash
cd automation
node --input-type=module -e "const m=await import('./sources/galgame/youxiniao/index.mjs');console.log((await m.fetchGames({})).length)"
```

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `列表页没解析出帖子链接` | `.rank_loop` 结构变了。`parseList()` 在找不到 blocks 时会退回整页扫 `/game|soft/`，那时会混进侧栏条目，需要重新定位容器 |
| `没解析到标题` | `<h1>` 结构变了 |
| `⚠️ 下载接口失败（id=…）` | 接口改了 / 需要新 header。该条照常入库，只是 `links` 少几条 |
| 正文特别长、还夹着「下载排行」等字样 | 正文容器匹配过宽。必须用精确的 `<div class="cont">`：模糊匹配实测会吞到 **16231 字符**（一路匹配到后面的 `</div></section>`），精确匹配只有 **802 字符** |
| 抓到的是 HTML 而不是图片 / 图 403 | 防盗链，见上面第 3 点 |
| 页面显示「暂无下载」 | 游戏鸟对**上海出口 IP** 前端就屏蔽下载；换个出口节点 |

## 注意

- 请求间隔保持 2 秒（`REQUEST_INTERVAL`），单次别抓太多（`MAX_POSTS` 默认 10）
- 不做登录、不绕验证码
- 本目录只影响 `youxiniao` 一个站点，写错不会影响 `siteA` 或其它站点
