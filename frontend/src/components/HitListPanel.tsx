import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Post } from '../api/types';
import { PostView } from './PostView';
import { NewTabLink } from './postLink';
import { Pagination } from './Pagination';

/**
 * 命中列表面板：阅读页的「串内检索」和目录页的「全文检索」共用。
 *
 * 输入框、最近三次记忆、命中列表的排版、↑/↓ 跳条、页码都在这儿；
 * 每条下面放什么操作由调用方给，翻页也是调用方决定（服务端翻页或本地切片）。
 * 检索词规则见 `query.ts`：空格分词，英文双引号内的整段完全匹配。
 */
export function HitListPanel({
  keyword,
  onKeyword,
  onSearch,
  recent,
  onPickRecent,
  busy,
  hits,
  total,
  page,
  pageSize,
  onPage,
  onQuote,
  highlight,
  actions,
  emptyHint,
  searchHint,
  hideImage,
  collapse,
}: {
  keyword: string;
  onKeyword: (value: string) => void;
  onSearch: (keyword?: string) => void;
  recent: string[];
  onPickRecent: (keyword: string) => void;
  busy: boolean;
  /** 当前这一页的命中 */
  hits: Post[];
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  onQuote: (postId: number) => void;
  /** 高亮用的关键词：这批命中是按它搜出来的 */
  highlight: string;
  actions: (post: Post, index: number) => ReactNode;
  emptyHint: string;
  searchHint: string;
  /** 全文检索用：命中列表不放图 */
  hideImage?: boolean;
  /** 全文检索用：每层正文固定高度，超出可展开 */
  collapse?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 视口顶部附近的那一条，用来显示「第几条」并支持 ↑/↓ 跳条 */
  const [active, setActive] = useState(0);
  const ticking = useRef(false);

  const scrollTo = useCallback(
    (index: number) => {
      const target = Math.max(0, Math.min(index, hits.length - 1));
      setActive(target);
      bodyRef.current
        ?.querySelector(`#peek-${hits[target]?.id}`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    [hits],
  );

  // 滚轮滚动时更新「第几条」（rAF 节流，200 条也不卡）
  const syncActive = useCallback(() => {
    if (ticking.current) return;
    ticking.current = true;
    window.requestAnimationFrame(() => {
      ticking.current = false;
      const body = bodyRef.current;
      if (!body) return;
      const top = body.getBoundingClientRect().top;
      let nearest = 0;
      let best = Number.POSITIVE_INFINITY;
      body.querySelectorAll<HTMLElement>('[data-peek-index]').forEach((el) => {
        const distance = Math.abs(el.getBoundingClientRect().top - top);
        if (distance < best) {
          best = distance;
          nearest = Number(el.dataset.peekIndex);
        }
      });
      setActive(nearest);
    });
  }, []);

  // 换了关键词就把列表拉回顶部
  const firstHit = hits[0]?.id;
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    setActive(0);
  }, [firstHit]);

  // ↑/↓ 在命中之间跳；Esc 关面板由工具栏统一处理
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        scrollTo(active + 1);
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        scrollTo(active - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, scrollTo]);

  const hitPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <div className="tools-form">
        <input
          className="input"
          placeholder="内容或串号"
          title="空格分词，各词都要出现；英文双引号内视为一个整体，要求完全匹配"
          value={keyword}
          onChange={(e) => onKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSearch();
          }}
        />
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => onSearch()}>
          {busy ? '检索中…' : '检索'}
        </button>
      </div>

      {recent.length > 0 && (
        <div className="tools-sub">
          <span className="faint nowrap">最近</span>
          <div className="recent-keywords">
            {recent.map((item) => (
              <button key={item} className="chip" title={`用「${item}」再搜一次`} onClick={() => onPickRecent(item)}>
                {item}
              </button>
            ))}
          </div>
        </div>
      )}

      {hitPages > 1 && (
        <div className="tools-pager">
          <Pagination page={page} totalPages={hitPages} onChange={onPage} />
        </div>
      )}

      <div className="tools-body" ref={bodyRef} onScroll={syncActive}>
        {hits.length === 0 ? (
          <p className="hint tools-empty">{busy ? '检索中…' : `${emptyHint}${searchHint}`}</p>
        ) : (
          hits.map((post, index) => (
            <PostView
              key={post.id}
              post={post}
              id={`peek-${post.id}`}
              data-peek-index={index}
              highlight={highlight}
              onQuote={onQuote}
              hideImage={hideImage}
              collapse={collapse}
              actions={
                <>
                  {actions(post, index)}
                  <NewTabLink threadId={post.threadId} postId={post.id} />
                </>
              }
            />
          ))
        )}
      </div>

      {hits.length > 0 && (
        <footer className="tools-foot">
          <button className="btn btn-sm" disabled={active <= 0} onClick={() => scrollTo(active - 1)}>
            上一条
          </button>
          <span className="faint nowrap">
            {active + 1}/{hits.length} · 命中 {total} 楼
          </span>
          <button className="btn btn-sm" disabled={active >= hits.length - 1} onClick={() => scrollTo(active + 1)}>
            下一条
          </button>
        </footer>
      )}
    </>
  );
}
