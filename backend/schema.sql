CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  nickname      TEXT    NOT NULL DEFAULT '',
  avatar        TEXT    NOT NULL DEFAULT '',
  role          TEXT    NOT NULL DEFAULT 'user',
  is_banned     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  author_id   INTEGER NOT NULL,
  category    TEXT    NOT NULL DEFAULT '',
  images      TEXT    NOT NULL DEFAULT '[]',
  views       INTEGER NOT NULL DEFAULT 0,
  is_pinned   INTEGER NOT NULL DEFAULT 0,
  is_featured INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  content     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  from_user_id INTEGER,
  post_id      INTEGER,
  type         TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  is_read      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- ==================== 评论点赞 ====================
CREATE TABLE IF NOT EXISTS comment_likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(comment_id, user_id),
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ==================== 帖子点赞 ====================
CREATE TABLE IF NOT EXISTS post_likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(post_id, user_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 为搜索/排序/去重常用列建索引
CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category);
CREATE INDEX IF NOT EXISTS idx_posts_featured ON posts(is_featured);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- ==================== 站点设置（管理员后台「界面显示设置」）====================
-- 单行表（id 恒为 1），data 存整个 JSON：卡片大小、布局密度、图片尺寸/压缩等
CREATE TABLE IF NOT EXISTS site_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data       TEXT    NOT NULL DEFAULT '{}',
  updated_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
INSERT OR IGNORE INTO site_settings (id, data) VALUES (1, '{}');
