-- ============================================================
-- 游戏分享站（娱乐游戏）独立数据库 game-db
-- 与苦海论坛（forum-db）完全隔离：无账号体系，进入靠统一访问密码
-- ============================================================

-- 游戏帖子（无 user_id，作者为访客昵称）
CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  author_name TEXT    NOT NULL DEFAULT '匿名玩家',
  author_visitor TEXT NOT NULL DEFAULT '',
  images      TEXT    NOT NULL DEFAULT '[]',
  views       INTEGER NOT NULL DEFAULT 0,
  is_pinned   INTEGER NOT NULL DEFAULT 0,
  is_featured INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 游戏评论（无 user_id，作者为访客昵称）
CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id       INTEGER NOT NULL,
  author_name   TEXT    NOT NULL DEFAULT '匿名玩家',
  author_visitor TEXT NOT NULL DEFAULT '',
  content       TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- 游戏帖子点赞（按访客标识去重）
CREATE TABLE IF NOT EXISTS post_likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  visitor_id TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(post_id, visitor_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- 游戏评论点赞
CREATE TABLE IF NOT EXISTS comment_likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL,
  visitor_id TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(comment_id, visitor_id),
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE
);

-- 游戏站设置（单行表，data 存 JSON：gamePasswordHash 等）
CREATE TABLE IF NOT EXISTS site_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data       TEXT    NOT NULL DEFAULT '{}',
  updated_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
INSERT OR IGNORE INTO site_settings (id, data) VALUES (1, '{}');

-- 索引
CREATE INDEX IF NOT EXISTS idx_game_posts_featured ON posts(is_featured);
CREATE INDEX IF NOT EXISTS idx_game_comments_post ON comments(post_id);
