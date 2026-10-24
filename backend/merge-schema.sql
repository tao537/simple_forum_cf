-- ============================================================
-- 数据库合并：把游戏站数据并入 forum-db（统一账号 + 游戏专用表）
-- 本文件在【forum-db】上执行（wrangler d1 execute forum-db --remote --file merge-schema.sql）
--
-- 设计：
--   1) 账号统一：游戏站与论坛共用 forum-db.users（不再有独立游戏 users）。
--   2) 游戏业务表用 game_ 前缀，与论坛 posts/comments 并存、互不干扰。
--   3) 游戏站保留访客昵称/访客点赞（author_visitor / visitor_id）。
--   4) 门禁密码与提示词并入 forum-db.site_settings 的 data JSON：
--      gamePasswordHash / gamePasswordHint（迁移脚本负责搬运）。
-- 迁移数据见 migrate-merge.mjs（读 game-db，写 forum-db，含用户合并与 id 重映射）。
-- ============================================================

-- ---------- 游戏帖子 ----------
CREATE TABLE IF NOT EXISTS game_posts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT    NOT NULL,
  content        TEXT    NOT NULL,
  author_name    TEXT    NOT NULL DEFAULT '匿名玩家',
  author_visitor TEXT    NOT NULL DEFAULT '',
  author_user_id INTEGER NULL,           -- 指向统一 users.id
  images         TEXT    NOT NULL DEFAULT '[]',
  views          INTEGER NOT NULL DEFAULT 0,
  is_pinned      INTEGER NOT NULL DEFAULT 0,
  is_featured    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ---------- 游戏评论 ----------
CREATE TABLE IF NOT EXISTS game_comments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id        INTEGER NOT NULL,
  author_name    TEXT    NOT NULL DEFAULT '匿名玩家',
  author_visitor TEXT    NOT NULL DEFAULT '',
  author_user_id INTEGER NULL,
  content        TEXT    NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (post_id) REFERENCES game_posts(id) ON DELETE CASCADE,
  FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ---------- 游戏帖子点赞（访客/用户统一按 visitor_id 去重）----------
CREATE TABLE IF NOT EXISTS game_post_likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  visitor_id TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(post_id, visitor_id),
  FOREIGN KEY (post_id) REFERENCES game_posts(id) ON DELETE CASCADE
);

-- ---------- 游戏评论点赞 ----------
CREATE TABLE IF NOT EXISTS game_comment_likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL,
  visitor_id TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(comment_id, visitor_id),
  FOREIGN KEY (comment_id) REFERENCES game_comments(id) ON DELETE CASCADE
);

-- ---------- 索引 ----------
CREATE INDEX IF NOT EXISTS idx_game_posts_featured ON game_posts(is_featured);
CREATE INDEX IF NOT EXISTS idx_game_posts_user    ON game_posts(author_user_id);
CREATE INDEX IF NOT EXISTS idx_game_comments_post ON game_comments(post_id);
CREATE INDEX IF NOT EXISTS idx_game_comments_user ON game_comments(author_user_id);
