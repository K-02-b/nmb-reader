import { useMemo, useState } from 'react';
import type { PostBookmark, TagVocabulary } from '../api/types';
import { filterBookmarks, type BookmarkFilter } from './bookmarkFilter';
import { NewTabLink } from './postLink';

/** 标签下拉里的分组顺序，与串信息页一致 */
const TAG_GROUPS: Array<[keyof TagVocabulary, string]> = [
  ['genre', '类型'],
  ['series', '系列'],
  ['status', '状态'],
  ['tags', '标签'],
];

/**
 * 书签面板：目录页与串内共用。
 *
 * 默认（也是「重置」后的样子）目录页显示全部、按添加时间从晚到早；串内只看本串。
 * 可按内容 / 名字、标签、串号收窄；每条还能起个名字。
 */
export function BookmarkPanel({
  items,
  loading,
  scope,
  filters,
  defaultFilter,
  onFilters,
  onReset,
  vocab,
  onJump,
  onRemove,
  onRename,
}: {
  items: PostBookmark[];
  loading?: boolean;
  /** 决定默认口径与排序：目录页按添加时间从晚到早，串内按楼层顺序 */
  scope: 'directory' | 'thread';
  filters: BookmarkFilter;
  /** 当前上下文的默认条件，用来判断「重置」是否可用 */
  defaultFilter: BookmarkFilter;
  onFilters: (next: BookmarkFilter) => void;
  onReset: () => void;
  vocab: TagVocabulary;
  onJump: (bookmark: PostBookmark) => void;
  onRemove: (bookmark: PostBookmark) => void;
  onRename: (bookmark: PostBookmark, title: string) => void;
}) {
  /** 正在改名的那条（key = 串号-楼号）与草稿 */
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState('');

  const visible = useMemo(() => filterBookmarks(items, filters, scope), [filters, items, scope]);

  const placeholder = scope === 'thread' ? '本串' : '全部串';
  const dirty =
    (filters.threadId ?? '') !== (defaultFilter.threadId ?? '') ||
    filters.tag !== defaultFilter.tag ||
    filters.keyword.trim() !== (defaultFilter.keyword ?? '').trim();

  const keyOf = (bookmark: PostBookmark) => `${bookmark.threadId}-${bookmark.postId}`;

  const startEdit = (bookmark: PostBookmark) => {
    setEditing(keyOf(bookmark));
    setDraft(bookmark.title ?? '');
  };

  const commitEdit = (bookmark: PostBookmark) => {
    if (editing !== keyOf(bookmark)) return;
    setEditing('');
    if ((bookmark.title ?? '') !== draft.trim()) onRename(bookmark, draft.trim());
  };

  return (
    <>
      <div className="tools-filters">
        <input
          className="input"
          placeholder="检索书签内容 / 名字"
          value={filters.keyword}
          onChange={(e) => onFilters({ ...filters, keyword: e.target.value })}
        />
      </div>

      <div className="tools-filters">
        <select className="select" value={filters.tag} onChange={(e) => onFilters({ ...filters, tag: e.target.value })}>
          <option value="">全部标签</option>
          {TAG_GROUPS.map(([key, label]) => (
            <optgroup key={key} label={label}>
              {vocab[key].map((name) => (
                <option key={`${key}-${name}`} value={name}>
                  {name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <input
          className="input mono"
          placeholder={`串号（${placeholder}）`}
          value={filters.threadId ?? ''}
          onChange={(e) => onFilters({ ...filters, threadId: e.target.value })}
        />
        <button className="btn btn-sm" disabled={!dirty} onClick={onReset} title="回到默认：目录页全部、串内只看本串">
          重置
        </button>
      </div>

      <div className="tools-body">
        {loading && <p className="hint tools-empty">书签加载中…</p>}
        {!loading && visible.length === 0 && (
          <p className="hint tools-empty">
            {dirty ? '没有符合条件的书签，可以点「重置」看全部。' : '还没有添加书签。'}
          </p>
        )}
        {!loading && visible.length > 0 && (
          <ul className="bookmark-list">
            {visible.map((item) => {
              const key = keyOf(item);
              const editingThis = editing === key;
              return (
                <li key={key} className="bookmark-item">
                  <div className="bookmark-jump">
                    <button className="bookmark-main" onClick={() => onJump(item)} title={`跳到 No.${item.postId}`}>
                      {scope === 'directory' && (
                        <span className="bookmark-thread">
                          {item.threadTitle || `No.${item.threadId}`}
                          <span className="faint mono"> No.{item.threadId}</span>
                        </span>
                      )}
                      <span className="bookmark-head">
                        <span className="mono">No.{item.postId}</span>
                        {/* 串首不在任何一页上，pageNum 是 0 */}
                        <span className="faint">{item.pageNum > 0 ? `第 ${item.pageNum} 页` : '串首'}</span>
                        {!editingThis && item.title && <span className="bookmark-title">{item.title}</span>}
                      </span>
                      {!editingThis && <span className="bookmark-excerpt">{item.excerpt || '（无内容）'}</span>}
                    </button>
                    {editingThis && (
                      <input
                        className="input bookmark-title-input"
                        autoFocus
                        maxLength={60}
                        placeholder="给这个书签起个名字"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitEdit(item);
                          if (event.key === 'Escape') setEditing('');
                        }}
                        onBlur={() => commitEdit(item)}
                      />
                    )}
                  </div>
                  {/* 「移除」下面就是「编辑」，点开书签名变成输入框 */}
                  <div className="bookmark-side">
                    <button
                      className="link-btn"
                      onClick={() => onRemove(item)}
                      aria-label={`移除 No.${item.postId} 的书签`}
                    >
                      移除
                    </button>
                    <button
                      className="link-btn"
                      // 不 preventDefault 的话：按下时输入框先 blur → 触发提交 → editing 被清掉，
                      // 紧接着这次点击又被当成「编辑」，于是一次点击先保存又打开编辑
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => (editingThis ? commitEdit(item) : startEdit(item))}
                      aria-label={`编辑 No.${item.postId} 的书签名`}
                    >
                      {editingThis ? '保存' : '编辑'}
                    </button>
                    <NewTabLink threadId={item.threadId} postId={item.postId} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {!loading && visible.length > 0 && (
        <footer className="tools-foot">
          <span className="faint nowrap">
            共 {visible.length} 条{dirty && items.length !== visible.length ? `（筛选前 ${items.length} 条）` : ''}
          </span>
        </footer>
      )}
    </>
  );
}
