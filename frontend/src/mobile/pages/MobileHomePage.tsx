import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { Paged, Tag, Thread, ThreadQuery } from '../../api/types';
import { useApp } from '../../state/AppContext';
import { useTagVocab } from '../../state/TagVocabContext';
import { FilterPanel } from '../../components/FilterPanel';
import { MobileSheet } from '../MobileSheet';
import { MobileThreadCard } from '../components/MobileThreadCard';

/** 与桌面端一致：每页 10 条 */
const PAGE_SIZE = 10;

/** 跳到某一条时闪一下，和阅读页的楼层高亮保持一致 */
function flashThread(el: Element) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const node = el as HTMLElement;
  node.style.transition = 'background 0.4s';
  node.style.background = 'color-mix(in srgb, var(--accent) 12%, transparent)';
  window.setTimeout(() => {
    node.style.background = '';
  }, 1400);
}

/**
 * 手机端目录页。
 *
 * 与桌面目录页共用同一套接口与筛选条件（ThreadQuery）；区别只在呈现：
 * 滚到底自动续页代替页码条，筛选条件收进底部抽屉，条目操作收进「更多」抽屉。
 */
export function MobileHomePage() {
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
    mergeTaskList,
    run,
    taskPulse,
  } = useApp();
  const navigate = useNavigate();
  const { vocab } = useTagVocab();
  // 支持 ?board=xxx（阅读页点板块会带过来）与 ?thread=xxx（全文检索点「在目录显示」）
  const [searchParams] = useSearchParams();
  const revealId = Number(searchParams.get('thread')) || null;

  const [query, setQuery] = useState<ThreadQuery>({
    sort: 'updated_desc',
    board: searchParams.get('board'),
    keyword: searchParams.get('keyword') ?? undefined,
  });
  const [items, setItems] = useState<Thread[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  /** 「更多操作」抽屉里那个串 */
  const [actionThread, setActionThread] = useState<Thread | null>(null);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const canManage = Boolean(session?.permissions.includes('thread.edit'));
  const canDownload = Boolean(session?.permissions.includes('thread.download'));

  // 筛选条件一变就回到第一页（对象只在 patch 时换新，所以可以直接进依赖）
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api
      .fetchThreads({ ...query, page: 1, pageSize: PAGE_SIZE })
      .then((result) => {
        if (!alive) return;
        setItems(result.items);
        setTotal(result.total);
        setPage(1);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [query]);

  const loadMore = useCallback(async () => {
    if (more || loading || items.length >= total) return;
    const next = page + 1;
    setMore(true);
    const result = await api.fetchThreads({ ...query, page: next, pageSize: PAGE_SIZE }).catch(() => null);
    setMore(false);
    if (!result) return;
    setItems((prev) => [...prev, ...result.items]);
    setTotal(result.total);
    setPage(next);
  }, [items.length, loading, more, page, query, total]);

  // 滚到底自动续页：哨兵进入视口就再拉一页，不用像桌面端那样点页码
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: '240px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  /** 重新拉取当前已经翻出来的这些页（后台任务结束后用，保持滚动位置不乱跳） */
  const reload = useCallback(async () => {
    const pages = await Promise.all(
      Array.from({ length: page }, (_, index) =>
        api.fetchThreads({ ...query, page: index + 1, pageSize: PAGE_SIZE }).catch(() => null),
      ),
    );
    const ok = pages.filter((item): item is Paged<Thread> => item !== null);
    if (ok.length === 0) return;
    setItems(ok.flatMap((item) => item.items));
    setTotal(ok[0].total);
  }, [page, query]);

  const lastPulse = useRef(0);
  useEffect(() => {
    if (taskPulse === lastPulse.current) return;
    lastPulse.current = taskPulse;
    void reload();
  }, [reload, taskPulse]);

  // 「在目录显示」：本页有就滚过去；没有就先问后端排第几页，把前几页一次取回来再滚
  const revealHandled = useRef(false);
  useEffect(() => {
    if (!revealId || revealHandled.current) return;
    revealHandled.current = true;
    void (async () => {
      const position = await api.threadPosition(revealId, { ...query, pageSize: PAGE_SIZE }).catch(() => null);
      if (!position) {
        notify('当前筛选条件下看不到这个串', 'warn');
        return;
      }
      const pages = await Promise.all(
        Array.from({ length: position.page }, (_, index) =>
          api.fetchThreads({ ...query, page: index + 1, pageSize: PAGE_SIZE }),
        ),
      );
      setItems(pages.flatMap((item) => item.items));
      setTotal(pages[0].total);
      setPage(position.page);
      window.setTimeout(() => {
        const el = document.querySelector(`[data-flip-id="${revealId}"]`);
        if (el) flashThread(el);
      }, 150);
    })();
  }, [notify, query, revealId]);

  const patch = (next: Partial<ThreadQuery>) => setQuery((prev) => ({ ...prev, ...next }));

  const visible = items.filter((thread) => !isThreadBlocked(thread.threadId) && !isCookieBlocked(thread.cookie));
  const hasMore = items.length < total;

  /** 更新：后台提交下载任务，不跳转，结果用 toast 提示 */
  const updateThread = async (threadId: number) => {
    setUpdatingId(threadId);
    const task = await run(() => api.submitTask(threadId, 'XD', ''), undefined);
    setUpdatingId(null);
    setActionThread(null);
    if (!task) return;
    mergeTaskList([task]);
    notify(
      task.status === 'queued'
        ? `已提交更新 No.${threadId}（任务 ${task.taskId}）`
        : `No.${threadId}：${task.message ?? '已进入队列'}`,
      'ok',
    );
  };

  const onTagClick = (tag: Tag) => {
    if (tag.tagType === 'genre') patch({ genre: tag.tagName });
    else if (tag.tagType === 'series') patch({ series: tag.tagName });
    else if (tag.tagType === 'status') patch({ status: tag.tagName });
    else patch({ tags: [tag.tagName] });
  };

  return (
    <div className="m-page">
      <div className="card">
        <div className="m-toolbar">
          <input
            className="input"
            placeholder="搜标题 / 摘要 / 标签"
            title="空格分词，各词都要出现；英文双引号内视为一个整体，要求完全匹配"
            value={query.keyword ?? ''}
            onChange={(event) => patch({ keyword: event.target.value })}
          />
          <button className="btn btn-sm" onClick={() => setFilterOpen(true)}>
            筛选
          </button>
        </div>
        <p className="hint" style={{ margin: '8px 0 0' }}>
          共 {total} 个串（已载入 {items.length}）
          {visible.length !== items.length && ` · 已按黑名单隐藏 ${items.length - visible.length} 个`}
          {query.board && ` · 板块「${query.board}」`}
        </p>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {loading && <div className="loading">串数据加载中…</div>}
        {!loading && error && (
          <div className="empty">
            <p className="error-text">{error}</p>
            <button className="btn" onClick={() => void reload()}>
              重新加载
            </button>
          </div>
        )}
        {!loading && !error && visible.length === 0 && <div className="empty">没有匹配的串</div>}
        {!loading &&
          !error &&
          visible.map((thread) => (
            <MobileThreadCard
              key={thread.threadId}
              thread={thread}
              bookmarked={bookmarks.some((b) => b.threadId === thread.threadId)}
              onToggleBookmark={(id) => void toggleBookmark(id)}
              onMore={setActionThread}
              onBoardClick={(board) => patch({ board: query.board === board ? null : board })}
              activeBoard={query.board}
              onTagClick={onTagClick}
            />
          ))}
        {!loading && !error && visible.length > 0 && (
          <div className="m-load-more" ref={sentinel}>
            {more ? '加载中…' : hasMore ? '滚到底部继续加载' : '没有更多了'}
          </div>
        )}
      </div>

      {filterOpen && (
        <MobileSheet title="目录筛选" onClose={() => setFilterOpen(false)} bare>
          <FilterPanel
            query={query}
            vocab={vocab}
            onChange={patch}
            onReset={() => setQuery({ sort: 'updated_desc' })}
          />
          <div className="m-sheet-foot">
            <span className="hint">共 {total} 个串</span>
            <span className="spacer" />
            <button className="btn btn-primary btn-sm" onClick={() => setFilterOpen(false)}>
              查看结果
            </button>
          </div>
        </MobileSheet>
      )}

      {actionThread && (
        <MobileSheet title={`No.${actionThread.threadId}`} onClose={() => setActionThread(null)}>
          <p className="m-item-title" style={{ marginTop: 0 }}>
            {actionThread.title}
          </p>
          <div className="m-sheet-actions">
            <button onClick={() => void toggleBookmark(actionThread.threadId)}>
              {bookmarks.some((b) => b.threadId === actionThread.threadId) ? '取消收藏' : '收藏此串'}
            </button>
            {canDownload && (
              <button
                disabled={updatingId === actionThread.threadId}
                onClick={() => void updateThread(actionThread.threadId)}
              >
                {updatingId === actionThread.threadId ? '提交中…' : '更新（补最后一页及之后）'}
              </button>
            )}
            {canManage && (
              <button onClick={() => navigate(`/m/admin?tab=threads&thread=${actionThread.threadId}`)}>
                管理串信息与标签
              </button>
            )}
            <button
              onClick={() => {
                const board = actionThread.board;
                setActionThread(null);
                patch({ board: board ?? null });
              }}
            >
              {actionThread.board ? `只看板块「${actionThread.board}」` : '只看该板块'}
            </button>
            <button className="danger" onClick={() => blockThread(actionThread.threadId)}>
              屏蔽此串
            </button>
            <button className="danger" onClick={() => blockCookie(actionThread.cookie)}>
              屏蔽 Po 饼干 ID:{actionThread.cookie}
            </button>
          </div>
        </MobileSheet>
      )}

      <p className="hint" style={{ margin: 0 }}>
        当前用户 {session?.username}，已屏蔽 {settings.blacklistThreads.length} 串 / {settings.blacklistCookies.length}{' '}
        饼干。
      </p>
    </div>
  );
}
