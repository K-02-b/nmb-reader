import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Post, PostBookmark, Thread, ThreadQuery } from '../api/types';
import { useApp } from '../state/AppContext';
import { useTagVocab } from '../state/TagVocabContext';
import { ThreadRow } from '../components/ThreadRow';
import { Pagination } from '../components/Pagination';
import { QuotePopup } from '../components/QuotePopup';
import { ToolsDock, type DockItem } from '../components/ToolsDock';
import { FilterPanel } from '../components/FilterPanel';
import { BookmarkPanel } from '../components/BookmarkPanel';
import { useDock } from '../components/useDock';
import { IconBookmark, IconDocumentSearch, IconFilter } from '../components/icons';
import {
  clearBookmarkFilter,
  defaultBookmarkFilter,
  filterBookmarks,
  loadBookmarkFilter,
  saveBookmarkFilter,
  type BookmarkFilter,
} from '../components/bookmarkFilter';
import { loadRecentKeywords, rememberKeyword } from '../components/recentKeywords';
import { HitListPanel } from '../components/HitListPanel';

const PAGE_SIZE = 10;
/** 全文检索命中在面板里的每页条数 */
const HIT_PAGE_SIZE = 10;

/** 跳到某一行时闪一下，和阅读页的楼层高亮保持一致 */
function flashThread(el: Element) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const node = el as HTMLElement;
  node.style.transition = 'background 0.4s';
  node.style.background = 'color-mix(in srgb, var(--accent) 12%, transparent)';
  window.setTimeout(() => {
    node.style.background = '';
  }, 1400);
}

/** 目录页右侧工具栏的三个面板 */
type DockKey = 'filter' | 'search' | 'marks';

/**
 * FLIP 位移补间：记录上一次每个 `[data-flip-id]` 元素的位置，
 * 重新渲染后把位移差反过来播一遍，于是顺序变化看起来是「浮动」过去的。
 */
function useFlipAnimation(orderKey: string) {
  const positions = useRef(new Map<number, number>());
  useLayoutEffect(() => {
    const next = new Map<number, number>();
    document.querySelectorAll<HTMLElement>('[data-flip-id]').forEach((el) => {
      const id = Number(el.dataset.flipId);
      const top = el.getBoundingClientRect().top;
      next.set(id, top);
      const prev = positions.current.get(id);
      if (prev !== undefined && Math.abs(prev - top) > 1) {
        el.animate([{ transform: `translateY(${prev - top}px)` }, { transform: 'translateY(0)' }], {
          duration: 520,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        });
      }
    });
    positions.current = next;
  }, [orderKey]);
}

export function HomePage() {
  const {
    session,
    settings,
    bookmarks,
    toggleBookmark,
    blockThread,
    blockCookie,
    isThreadBlocked,
    isCookieBlocked,
    notify,
    run,
    taskPulse,
  } = useApp();
  const navigate = useNavigate();
  const { active: tool, toggle: toggleTool, close: closeTool } = useDock<DockKey>();
  /** 全文检索里点开的引用：可能跨串，串号能查到就记上，查不到（不在这一页命中里）就留空 */
  const [quote, setQuote] = useState<{ threadId: number | null; postId: number } | null>(null);
  // 支持 ?board=xxx（阅读页点板块会带过来）
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState<ThreadQuery>({
    sort: 'updated_desc',
    board: searchParams.get('board'),
  });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: Thread[]; total: number }>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fulltextKeyword, setFulltextKeyword] = useState('');
  /** 全文检索命中；面板里按 HIT_PAGE_SIZE 条一页本地翻页 */
  const [fulltextHits, setFulltextHits] = useState<Post[]>([]);
  const [fulltextTotal, setFulltextTotal] = useState(0);
  const [fulltextPage, setFulltextPage] = useState(1);
  const [fulltextKeywordApplied, setFulltextKeywordApplied] = useState('');
  /** 命中数撞上接口上限时为 true：界面要明说「被截断了」，不能当成全部结果 */
  const [fulltextTruncated, setFulltextTruncated] = useState(false);
  const [fulltextLimit, setFulltextLimit] = useState(200);
  /** 「在目录显示」要滚到的那一行 */
  const revealRef = useRef<number | null>(null);
  const [fulltextBusy, setFulltextBusy] = useState(false);
  const [recentKeywords, setRecentKeywords] = useState<string[]>([]);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  // ---- 书签面板：默认看全部，筛选条件改过就记住（与串内那份互不影响） ----
  const [postBookmarks, setPostBookmarks] = useState<PostBookmark[]>([]);
  const [bookmarksLoading, setBookmarksLoading] = useState(true);
  const [bookmarkFilter, setBookmarkFilter] = useState<BookmarkFilter>(
    () => loadBookmarkFilter('directory', session?.username) ?? defaultBookmarkFilter('directory'),
  );
  // 标签候选来自全局词汇表
  const { vocab, refresh: refreshVocab } = useTagVocab();
  const canManage = Boolean(session?.permissions.includes('thread.edit'));
  const canDownload = Boolean(session?.permissions.includes('thread.download'));

  /** silent=true 时不显示加载态，保留现有列表，只把顺序换掉（供 FLIP 动画用） */
  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError('');
      try {
        const result = await api.fetchThreads({ ...query, page, pageSize: PAGE_SIZE });
        setData({ items: result.items, total: result.total });
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [page, query],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void refreshVocab();
  }, [refreshVocab]);

  // 最近三次检索词与串内检索共用一份（按用户名存在浏览器本地）
  useEffect(() => {
    setRecentKeywords(loadRecentKeywords(session?.username));
  }, [session?.username]);

  // 有后台任务刚结束时（AppContext 里的全局轮询会给信号）静默刷新目录，顺序变化由 FLIP 补成动画
  const lastPulse = useRef(0);
  useEffect(() => {
    if (taskPulse === lastPulse.current) return;
    lastPulse.current = taskPulse;
    void load(true);
  }, [load, taskPulse]);

  const patch = (next: Partial<ThreadQuery>) => {
    setQuery((prev) => ({ ...prev, ...next }));
    setPage(1);
  };

  const visible = useMemo(
    () => data.items.filter((t) => !isThreadBlocked(t.threadId) && !isCookieBlocked(t.cookie)),
    [data.items, isThreadBlocked, isCookieBlocked],
  );

  // 顺序（含分页）变化时播放位移动画
  useFlipAnimation(visible.map((t) => t.threadId).join(','));

  /** 更新：后台提交下载任务，不跳转，结果用右下角 toast 提示 */
  const updateThread = async (threadId: number) => {
    setUpdatingId(threadId);
    const task = await run(() => api.submitTask(threadId, 'XD', ''), undefined);
    setUpdatingId(null);
    if (!task) return;
    if (task.status === 'queued') {
      notify(
        `已提交更新 No.${threadId}（任务 ${task.taskId}）${task.ahead > 0 ? `，前面还有 ${task.ahead} 个` : ''}`,
        'ok',
      );
    } else {
      notify(`No.${threadId}：${task.message ?? '已进入队列'}`, 'ok');
    }
  };

  /** 管理：跳到管理页的「串信息与标签」并定位展开这个串 */
  const manageThread = (threadId: number) => {
    navigate(`/admin?tab=threads&thread=${threadId}`);
  };

  // 进页面就拉全量楼层书签（跨串）：竖栏上的数量要一开始就对，不能等点开面板才算
  useEffect(() => {
    let alive = true;
    setBookmarksLoading(true);
    api
      .fetchPostBookmarks()
      .then((list) => alive && setPostBookmarks(list))
      .catch(() => alive && setPostBookmarks([]))
      .finally(() => alive && setBookmarksLoading(false));
    return () => {
      alive = false;
    };
  }, [session?.username]);

  const updateBookmarkFilter = (next: BookmarkFilter) => {
    setBookmarkFilter(next);
    saveBookmarkFilter('directory', session?.username, next);
  };

  const resetBookmarkFilter = () => {
    clearBookmarkFilter('directory', session?.username);
    setBookmarkFilter(defaultBookmarkFilter('directory'));
  };

  const renamePostBookmark = async (bookmark: PostBookmark, title: string) => {
    const previous = postBookmarks;
    setPostBookmarks((list) =>
      list.map((item) =>
        item.threadId === bookmark.threadId && item.postId === bookmark.postId ? { ...item, title } : item,
      ),
    );
    try {
      await api.renamePostBookmark(bookmark.threadId, bookmark.postId, title);
    } catch (error) {
      setPostBookmarks(previous);
      notify(error instanceof Error ? error.message : '书签名保存失败', 'error');
    }
  };

  const removePostBookmark = async (bookmark: PostBookmark) => {
    const previous = postBookmarks;
    setPostBookmarks((list) =>
      list.filter((item) => !(item.threadId === bookmark.threadId && item.postId === bookmark.postId)),
    );
    try {
      await api.removePostBookmark(bookmark.threadId, bookmark.postId);
      notify(`已移除 No.${bookmark.postId} 的书签`, 'ok');
    } catch (error) {
      setPostBookmarks(previous);
      notify(error instanceof Error ? error.message : '书签操作失败', 'error');
    }
  };

  const runFulltext = async (raw?: string) => {
    const keyword = (raw ?? fulltextKeyword).trim();
    if (!keyword) return;
    setFulltextKeyword(keyword);
    setRecentKeywords(rememberKeyword(session?.username, keyword));
    setFulltextBusy(true);
    try {
      const result = await api.fullText(keyword);
      const hits = result.hits;
      setFulltextHits(hits);
      setFulltextTotal(hits.length);
      setFulltextPage(1);
      setFulltextKeywordApplied(keyword);
      setFulltextTruncated(result.truncated);
      setFulltextLimit(result.limit);
      if (hits.length === 0) {
        notify(`没有命中「${keyword}」的楼层`, 'info');
      } else if (result.truncated) {
        notify(`命中超过 ${result.limit} 条，只显示前 ${result.limit} 条；换个更具体的关键词能缩小范围`, 'warn');
      } else {
        notify(`全文检索命中 ${hits.length} 条（仅覆盖已下载的串）`, 'ok');
      }
    } finally {
      setFulltextBusy(false);
    }
  };

  /**
   * 在目录里显示某个串：和阅读页的「跳到该楼」一样——本页有就滚过去，
   * 没有就先问后端它排在第几条、翻到那一页再滚过去（不改变筛选条件）。
   */
  const revealThread = async (threadId: number) => {
    const row = document.querySelector(`.thread-row[data-flip-id="${threadId}"]`);
    if (row) {
      flashThread(row);
      return;
    }
    const position = await api.threadPosition(threadId, { ...query, pageSize: PAGE_SIZE }).catch(() => null);
    if (!position) {
      notify('当前筛选条件下看不到这个串', 'warn');
      return;
    }
    revealRef.current = threadId;
    if (position.page === page) {
      revealRef.current = null;
      notify(`No.${threadId} 就在本页，但被黑名单隐藏了`, 'warn');
      return;
    }
    setPage(position.page);
  };

  useEffect(() => {
    if (revealRef.current === null || loading) return;
    const el = document.querySelector(`.thread-row[data-flip-id="${revealRef.current}"]`);
    if (!el) return;
    revealRef.current = null;
    flashThread(el);
  }, [data.items, loading]);

  const dockItems: Array<DockItem<DockKey>> = [
    { key: 'filter', label: '目录筛选', icon: <IconFilter /> },
    { key: 'search', label: '全文检索', icon: <IconDocumentSearch /> },
    {
      key: 'marks',
      label: '书签',
      icon: <IconBookmark />,
      badge: filterBookmarks(postBookmarks, bookmarkFilter, 'directory').length,
    },
  ];

  const renderDockPanel = (key: DockKey) => {
    if (key === 'filter') {
      return (
        <FilterPanel
          query={query}
          vocab={vocab}
          onChange={patch}
          onReset={() => {
            setQuery({ sort: 'updated_desc' });
            setPage(1);
          }}
        />
      );
    }
    if (key === 'search') {
      return (
        <HitListPanel
          keyword={fulltextKeyword}
          onKeyword={setFulltextKeyword}
          onSearch={(raw) => void runFulltext(raw)}
          highlight={fulltextKeywordApplied}
          recent={recentKeywords}
          onPickRecent={(item) => void runFulltext(item)}
          busy={fulltextBusy}
          hits={fulltextHits.slice((fulltextPage - 1) * HIT_PAGE_SIZE, fulltextPage * HIT_PAGE_SIZE)}
          total={fulltextTotal}
          page={fulltextPage}
          pageSize={HIT_PAGE_SIZE}
          onPage={setFulltextPage}
          onQuote={(postId) => {
            // 引用的目标通常不在这一页命中里，串号只能当提示用；弹框自己按楼号去取
            const hit = fulltextHits.find((post) => post.id === postId);
            setQuote({ threadId: hit?.threadId ?? null, postId });
          }}
          emptyHint="输入关键词后回车，命中在这里看；空格分词，英文双引号内完全匹配。只覆盖已下载的串。"
          searchHint=""
          truncated={fulltextTruncated}
          limit={fulltextLimit}
          hideImage
          collapse
          actions={(post) => (
            <>
              <button className="link-btn" onClick={() => revealThread(post.threadId)}>
                在目录显示
              </button>
              <button className="link-btn" onClick={() => navigate(`/t/${post.threadId}?post=${post.id}`)}>
                查看该楼
              </button>
            </>
          )}
        />
      );
    }
    return (
      <BookmarkPanel
        items={postBookmarks}
        loading={bookmarksLoading}
        scope="directory"
        filters={bookmarkFilter}
        defaultFilter={defaultBookmarkFilter('directory')}
        onFilters={updateBookmarkFilter}
        onReset={resetBookmarkFilter}
        vocab={vocab}
        onJump={(bookmark) => navigate(`/t/${bookmark.threadId}?post=${bookmark.postId}`)}
        onRemove={(bookmark) => void removePostBookmark(bookmark)}
        onRename={(bookmark, title) => void renamePostBookmark(bookmark, title)}
      />
    );
  };

  return (
    <>
      <section>
        <div className="card" style={{ padding: 0 }}>
          <div className="card-title" style={{ padding: '14px 16px 0' }}>
            <h3>
              目录 · 共 {data.total} 个串
              {visible.length !== data.items.length && (
                <span className="faint" style={{ fontSize: '0.8em', fontWeight: 400 }}>
                  （本页已按黑名单隐藏 {data.items.length - visible.length} 个）
                </span>
              )}
            </h3>
            <span className="hint">
              当前用户 {session?.username}，已屏蔽 {settings.blacklistThreads.length} 串 /{' '}
              {settings.blacklistCookies.length} 饼干
            </span>
          </div>
          {loading && <div className="loading">串数据加载中…</div>}
          {!loading && error && (
            <div className="empty">
              <p className="error-text">{error}</p>
              <button className="btn" onClick={() => void load()}>
                重新加载
              </button>
            </div>
          )}
          {!loading && !error && visible.length === 0 && <div className="empty">没有匹配的串</div>}
          {!loading &&
            !error &&
            visible.map((thread) => (
              <ThreadRow
                key={thread.threadId}
                thread={thread}
                bookmarked={bookmarks.some((b) => b.threadId === thread.threadId)}
                onToggleBookmark={(id) => void toggleBookmark(id)}
                onBlock={(id) => blockThread(id)}
                onBlockCookie={blockCookie}
                onUpdate={canDownload ? (id) => void updateThread(id) : undefined}
                updating={updatingId === thread.threadId}
                onManage={canManage ? manageThread : undefined}
                onBoardClick={(board) => {
                  // 再点同一板块 = 取消筛选
                  patch({ board: query.board === board ? null : board });
                  setPage(1);
                }}
                activeBoard={query.board}
                onTagClick={(tag) => {
                  if (tag.tagType === 'genre') patch({ genre: tag.tagName });
                  else if (tag.tagType === 'series') patch({ series: tag.tagName });
                  else if (tag.tagType === 'status') patch({ status: tag.tagName });
                  else patch({ tags: [tag.tagName] });
                }}
              />
            ))}
          <Pagination
            page={page}
            totalPages={Math.ceil(data.total / PAGE_SIZE)}
            onChange={setPage}
            totalLabel={`第 ${page} 页`}
          />
        </div>
        {quote && (
          <QuotePopup
            key={`${quote.threadId ?? 'thread'}-${quote.postId}`}
            rootPostId={quote.postId}
            threadId={quote.threadId}
            onGoToPost={(postId, targetThread) => navigate(`/t/${targetThread}?post=${postId}`)}
            onClose={() => setQuote(null)}
          />
        )}
      </section>

      <ToolsDock
        items={dockItems}
        active={tool}
        onToggle={toggleTool}
        onClose={closeTool}
        renderPanel={renderDockPanel}
      />
    </>
  );
}
