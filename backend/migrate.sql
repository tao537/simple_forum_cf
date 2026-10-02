-- ============================================================
-- 迁移脚本：把「已有部署」的 D1 数据库升级到最新表结构
-- 新部署（从未建过表）直接执行 schema.sql 即可，无需本脚本。
--
-- 对已有库执行一次：
--   cd backend
--   npx wrangler d1 execute forum-db --remote --file migrate.sql
-- ============================================================

-- posts 增加分类列（前端发帖/筛选依赖）
ALTER TABLE posts ADD COLUMN category TEXT NOT NULL DEFAULT '';

-- notifications 增加「触发者」和「关联帖子」列（通知体系依赖）
ALTER TABLE notifications ADD COLUMN from_user_id INTEGER;
ALTER TABLE notifications ADD COLUMN post_id INTEGER;

-- 帖子点赞表（前端帖子点赞功能依赖）
CREATE TABLE IF NOT EXISTS post_likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(post_id, user_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 常用查询索引
CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category);
CREATE INDEX IF NOT EXISTS idx_posts_featured ON posts(is_featured);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- 站点设置表（管理员后台「界面显示设置」依赖）
CREATE TABLE IF NOT EXISTS site_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data       TEXT    NOT NULL DEFAULT '{}',
  updated_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
INSERT OR IGNORE INTO site_settings (id, data) VALUES (1, '{}');
