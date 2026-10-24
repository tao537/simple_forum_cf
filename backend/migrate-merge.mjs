#!/usr/bin/env node
// ============================================================
// 数据库合并迁移：game-db → forum-db
// 在【backend 目录】、Linux 上运行（node_modules 必须是 Linux 版）：
//   node migrate-merge.mjs            生成 merge-data.sql（不执行，先人工核对）
//   node migrate-merge.mjs --apply    生成后立即用 wrangler 导入 forum-db
//
// 做了什么：
//   1) 读 game-db 的 users/posts/comments/likes/site_settings；
//   2) 账号合并：同名用户以论坛为准并归并（帖子作者映射到论坛 id）；
//      论坛没有的游戏用户，显式分配新 id 插入 forum-db.users，
//      email 自动生成占位（game_<id>_<rand>@kuhai.local），以后可补；
//   3) game_posts/game_comments 保留原 id（新表无冲突），仅重映射 author_user_id；
//   4) 门禁密码 hash 与提示词并入 forum-db.site_settings。
// 安全：默认只生成 SQL，不写库；强烈建议先 wrangler d1 export 备份两个库。
// ============================================================
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRANGLER = join(__dirname, 'node_modules/wrangler/bin/wrangler.js');
const apply = process.argv.includes('--apply');

function q(db, sql) {
  const out = execFileSync('node', [WRANGLER, 'd1', 'execute', db, '--remote', '--json', '--command', sql], {
    encoding: 'utf8', maxBuffer: 1024 * 1024 * 64,
  });
  // wrangler --json 输出 [ { results: [...], success: true } ]
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results || [];
}

const sqlEsc = v => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};
const rand = n => randomBytes(n).toString('hex').slice(0, n);

console.log('① 读取 game-db 数据…');
const gUsers = q('game-db', 'SELECT * FROM users;');
const gPosts = q('game-db', 'SELECT * FROM posts;');
const gComments = q('game-db', 'SELECT * FROM comments;');
const gPostLikes = q('game-db', 'SELECT * FROM post_likes;');
const gCommentLikes = q('game-db', 'SELECT * FROM comment_likes;');
const gSettingsRows = q('game-db', 'SELECT data FROM site_settings WHERE id = 1;');
console.log(`   users ${gUsers.length} / posts ${gPosts.length} / comments ${gComments.length} / likes ${gPostLikes.length + gCommentLikes.length}`);

console.log('② 读取 forum-db users 做账号合并…');
const fUsers = q('forum-db', 'SELECT id, username, email FROM users;');
const fByName = new Map(fUsers.map(u => [String(u.username), u]));
let fMaxId = fUsers.reduce((m, u) => Math.max(m, u.id), 0);
const fEmails = new Set(fUsers.map(u => String(u.email)));

// game user id → forum user id
const idMap = new Map();
const newUserInserts = [];
for (const gu of gUsers) {
  const same = fByName.get(String(gu.username));
  if (same) {
    idMap.set(gu.id, same.id); // 以论坛为准
    continue;
  }
  fMaxId += 1;
  const newId = fMaxId;
  let email = `game_${gu.id}_${rand(5)}@kuhai.local`;
  while (fEmails.has(email)) email = `game_${gu.id}_${rand(5)}@kuhai.local`;
  fEmails.add(email);
  idMap.set(gu.id, newId);
  newUserInserts.push(
    `INSERT INTO users (id, username, email, password_hash, nickname, avatar, role, is_banned, created_at) VALUES ` +
    `(${newId}, ${sqlEsc(gu.username)}, ${sqlEsc(email)}, ${sqlEsc(gu.password_hash)}, ${sqlEsc(gu.nickname || '')}, ${sqlEsc(gu.avatar || '')}, ${sqlEsc(gu.role || 'user')}, ${sqlEsc(gu.is_banned || 0)}, ${sqlEsc(gu.created_at)});`
  );
}
console.log(`   同名归并 ${gUsers.length - newUserInserts.length} 个，新增用户 ${newUserInserts.length} 个`);

const mapUser = v => (v === null || v === undefined) ? null : (idMap.has(v) ? idMap.get(v) : null);

console.log('③ 生成游戏业务表 INSERT…');
const postInserts = gPosts.map(p => {
  const uid = mapUser(p.author_user_id);
  return `INSERT INTO game_posts (id, title, content, author_name, author_visitor, author_user_id, images, views, is_pinned, is_featured, created_at, updated_at) VALUES ` +
    `(${p.id}, ${sqlEsc(p.title)}, ${sqlEsc(p.content)}, ${sqlEsc(p.author_name || '匿名玩家')}, ${sqlEsc(p.author_visitor || '')}, ${uid === null ? 'NULL' : uid}, ${sqlEsc(p.images || '[]')}, ${sqlEsc(p.views || 0)}, ${sqlEsc(p.is_pinned || 0)}, ${sqlEsc(p.is_featured || 0)}, ${sqlEsc(p.created_at)}, ${sqlEsc(p.updated_at)});`;
});
const commentInserts = gComments.map(c => {
  const uid = mapUser(c.author_user_id);
  return `INSERT INTO game_comments (id, post_id, author_name, author_visitor, author_user_id, content, created_at) VALUES ` +
    `(${c.id}, ${c.post_id}, ${sqlEsc(c.author_name || '匿名玩家')}, ${sqlEsc(c.author_visitor || '')}, ${uid === null ? 'NULL' : uid}, ${sqlEsc(c.content)}, ${sqlEsc(c.created_at)});`;
});
const postLikeInserts = gPostLikes.map(l =>
  `INSERT OR IGNORE INTO game_post_likes (post_id, visitor_id, created_at) VALUES (${l.post_id}, ${sqlEsc(l.visitor_id)}, ${sqlEsc(l.created_at)});`);
const commentLikeInserts = gCommentLikes.map(l =>
  `INSERT OR IGNORE INTO game_comment_likes (comment_id, visitor_id, created_at) VALUES (${l.comment_id}, ${sqlEsc(l.visitor_id)}, ${sqlEsc(l.created_at)});`);

// 门禁设置合并
let settingUpdate = '';
try {
  const gData = JSON.parse(gSettingsRows?.[0]?.data || '{}');
  const keys = ['gamePasswordHash', 'gamePasswordHint'];
  const picked = Object.fromEntries(keys.filter(k => gData[k]).map(k => [k, gData[k]]));
  if (Object.keys(picked).length) {
    const fRows = q('forum-db', 'SELECT data FROM site_settings WHERE id = 1;');
    const fData = JSON.parse(fRows?.[0]?.data || '{}');
    const merged = { ...fData, ...picked };
    settingUpdate = `UPDATE site_settings SET data = ${sqlEsc(JSON.stringify(merged))}, updated_at = datetime('now','localtime') WHERE id = 1;`;
  }
} catch (e) {
  console.log('   ⚠️ 门禁设置合并跳过：', e.message);
}

const sql = [
  '-- 自动生成：game-db → forum-db 合并迁移（migrate-merge.mjs）',
  'BEGIN TRANSACTION;',
  ...newUserInserts,
  ...postInserts,
  ...commentInserts,
  ...postLikeInserts,
  ...commentLikeInserts,
  settingUpdate,
  'COMMIT;',
  '',
].filter(Boolean).join('\n');

const outPath = join(__dirname, 'merge-data.sql');
writeFileSync(outPath, sql, 'utf8');
console.log(`④ 已生成 ${outPath}`);
console.log(`   新用户 ${newUserInserts.length} / 帖子 ${postInserts.length} / 评论 ${commentInserts.length} / 点赞 ${postLikeInserts.length + commentLikeInserts.length} / 门禁设置 ${settingUpdate ? '已合并' : '无'}`);

if (!apply) {
  console.log('\n下一步：人工核对 merge-data.sql 后，运行：');
  console.log('  node migrate-merge.mjs --apply');
  process.exit(0);
}

console.log('\n⑤ 导入 forum-db…');
execFileSync('node', [WRANGLER, 'd1', 'execute', 'forum-db', '--remote', '--file', outPath], { stdio: 'inherit' });
console.log('✅ 迁移完成。确认无误后可在 wrangler.jsonc 移除 GAME_DB 绑定，并部署后端。');
