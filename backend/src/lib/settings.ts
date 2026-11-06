// 站点设置存储：全站只有一个 JSON 行（site_settings.id = 1）。
// 所有需要持久化配置的领域（界面显示、分类、文案、门禁）都通过这里读写，
// 避免各自手写 SQL，也避免「读-改-写」时互相覆盖字段。

export type SettingsBag = Record<string, any>;

/** 读取原始设置对象（不做默认值合并，失败返回 {}） */
export async function readSettings<T extends SettingsBag = SettingsBag>(
  db: D1Database
): Promise<T> {
  const row = await db
    .prepare('SELECT data FROM site_settings WHERE id = 1')
    .first<{ data: string }>();
  try {
    return JSON.parse(row?.data || '{}') as T;
  } catch {
    return {} as T;
  }
}

/** 整体写回 */
export async function writeSettings(db: D1Database, data: SettingsBag): Promise<void> {
  await db
    .prepare("UPDATE site_settings SET data = ?, updated_at = datetime('now','localtime') WHERE id = 1")
    .bind(JSON.stringify(data ?? {}))
    .run();
}

/** 只改指定字段：读一次 → 就地修改 → 写回，其它领域的字段原样保留 */
export async function patchSettings(
  db: D1Database,
  mutate: (current: SettingsBag) => void
): Promise<SettingsBag> {
  const current = await readSettings(db);
  mutate(current);
  await writeSettings(db, current);
  return current;
}
