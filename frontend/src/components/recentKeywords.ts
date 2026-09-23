/**
 * 串内检索的「最近三次」记忆，按用户名存在浏览器本地。
 */
const MAX = 3;

function storageKey(username: string | undefined): string {
  return `xdnmb.recentKeywords.${username ?? 'anonymous'}`;
}

export function loadRecentKeywords(username: string | undefined): string[] {
  try {
    const raw = localStorage.getItem(storageKey(username));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string').slice(0, MAX) : [];
  } catch {
    return [];
  }
}

/** 记一条并返回新的列表（去重、最新的在前、最多 MAX 条） */
export function rememberKeyword(username: string | undefined, keyword: string): string[] {
  const value = keyword.trim();
  if (!value) return loadRecentKeywords(username);
  const next = [value, ...loadRecentKeywords(username).filter((item) => item !== value)].slice(0, MAX);
  try {
    localStorage.setItem(storageKey(username), JSON.stringify(next));
  } catch {
    /* 存储不可用时忽略 */
  }
  return next;
}
