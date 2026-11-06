// 通知域：站内通知落库与 @提及解析，帖子/评论等业务共用的纯能力

// ==================== 通知辅助 ====================
export async function addNotification(
  db: D1Database,
  p: { to: number; from: number; type: string; postId: number; content: string }
) {
  await db
    .prepare('INSERT INTO notifications (user_id, from_user_id, post_id, type, content) VALUES (?,?,?,?,?)')
    .bind(p.to, p.from, p.postId, p.type, p.content)
    .run();
}

export async function resolveMentions(db: D1Database, content: string, selfId: number): Promise<{ id: number; username: string }[]> {
  const names = [...new Set((content.match(/@([\u4e00-\u9fa5\w]{2,30})/g) || []).map((x) => x.slice(1)))];
  const out: { id: number; username: string }[] = [];
  for (const n of names) {
    const u = await db.prepare('SELECT id, username FROM users WHERE username = ?').bind(n).first<{ id: number; username: string }>();
    if (u && u.id !== selfId) out.push(u);
  }
  return out;
}
