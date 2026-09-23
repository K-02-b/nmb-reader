/**
 * 书签筛选：条件本身 + 条件的记忆。
 *
 * 记忆分目录页和串内两份，改过就记住，直到「重置」；目录页默认「全部、从晚到早」，串内默认「本串」。
 */
import type { PostBookmark } from '../api/types';

export interface BookmarkFilter {
  /** 串号筛选：'' = 全部；undefined = 用当前上下文的默认（串内 = 本串） */
  threadId?: string;
  /** 标签名，'' = 全部标签 */
  tag: string;
  /** 内容检索：匹配书签名、正文摘要或串标题 */
  keyword: string;
}

export type BookmarkScope = 'directory' | 'thread';

const EMPTY: BookmarkFilter = { threadId: '', tag: '', keyword: '' };

function storageKey(scope: BookmarkScope, username: string | undefined): string {
  return `xdnmb.bookmarkFilter.${scope}.${username ?? 'anonymous'}`;
}

/** 没存过就返回 undefined，交给调用方套默认值 */
export function loadBookmarkFilter(scope: BookmarkScope, username: string | undefined): BookmarkFilter | undefined {
  try {
    const raw = localStorage.getItem(storageKey(scope, username));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<BookmarkFilter>;
    return {
      threadId: typeof value.threadId === 'string' ? value.threadId : '',
      tag: value.tag ?? '',
      keyword: value.keyword ?? '',
    };
  } catch {
    return undefined;
  }
}

export function saveBookmarkFilter(scope: BookmarkScope, username: string | undefined, filter: BookmarkFilter): void {
  try {
    localStorage.setItem(storageKey(scope, username), JSON.stringify(filter));
  } catch {
    /* 存储不可用时忽略 */
  }
}

export function clearBookmarkFilter(scope: BookmarkScope, username: string | undefined): void {
  try {
    localStorage.removeItem(storageKey(scope, username));
  } catch {
    /* 存储不可用时忽略 */
  }
}

/** 当前上下文没改过筛选条件时的样子 */
export function defaultBookmarkFilter(scope: BookmarkScope, threadId?: number): BookmarkFilter {
  return scope === 'thread' && threadId ? { threadId: String(threadId), tag: '', keyword: '' } : EMPTY;
}

/** 按当前条件筛出要显示的书签，并排好序：目录页从晚到早，串内按楼层顺序 */
export function filterBookmarks(items: PostBookmark[], filters: BookmarkFilter, scope: BookmarkScope): PostBookmark[] {
  const threadId = (filters.threadId ?? '').trim();
  const tag = filters.tag.trim();
  const keyword = filters.keyword.trim().toLowerCase();
  const list = items.filter((item) => {
    if (threadId && !String(item.threadId).startsWith(threadId)) return false;
    if (tag && !item.tags.some((t) => t.tagName === tag)) return false;
    if (keyword) {
      const haystack = `${item.title} ${item.excerpt} ${item.threadTitle} No.${item.postId}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
  return scope === 'thread' ? list.sort((a, b) => a.postId - b.postId) : list.sort((a, b) => b.createdAt - a.createdAt);
}
