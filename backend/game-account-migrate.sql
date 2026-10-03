-- ============================================================
-- 游戏站账号体系增量迁移（在已存在的 game-db 上执行一次）
-- 前置检查（只读）：
--   PRAGMA table_info(posts);    看有没有 author_user_id 列
--   PRAGMA table_info(comments); 看有没有 author_user_id 列
-- 若已有 author_user_id 列，跳过下方对应 ALTER 语句
-- ============================================================

-- 1) 游戏站独立账号表（与苦海论坛 users 完全隔离）
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  nickname      TEXT    NOT NULL DEFAULT '',
  avatar        TEXT    NOT NULL DEFAULT '',
  role          TEXT    NOT NULL DEFAULT 'user',
  is_banned     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 2) posts 表加作者账号列
ALTER TABLE posts ADD COLUMN author_user_id INTEGER NULL;

-- 3) comments 表加作者账号列
ALTER TABLE comments ADD COLUMN author_user_id INTEGER NULL;
