import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import type { Post, PostBookmark, Thread } from '../../api/types';
import { useApp } from '../../state/AppContext';
import { useTagVocab } from '../../state/TagVocabContext';
import { PostCard } from '../../components/PostCard';
import { QuotePopup } from '../../components/QuotePopup';
import { ExportDialog } from '../../components/ExportDialog';
import { HitListPanel } from '../../components/HitListPanel';
import { BookmarkPanel } from '../../components/BookmarkPanel';
import { TagChip } from '../../components/TagChip';
import {
  clearBookmarkFilter,
  defaultBookmarkFilter,
  filterBookmarks,
  loadBookmarkFilter,
  saveBookmarkFilter,
  type BookmarkFilter,
} from '../../components/bookmarkFilter';
import { loadRecentKeywords, rememberKeyword } from '../../components/recentKeywords';
import { loadReadPosition, saveReadPosition, scrollToPost, topPostId } from '../../components/readPosition';
import { fmtRelative } from '../../components/format';
import {
  IconArrowLeft,
  IconBookmark,
  IconMore,
  IconPagerNext,
  IconPagerPrev,
  IconSearch,
} from '../../components/icons';
import { MobileSheet } from '../MobileSheet';
import { toDesktopPath, writeUiMode } from '../device';

/** 串内检索一次取多少条（接口 pageSize 上限 200） */
const PEEK_PAGE_SIZE = 200;

const SUGGEST_KINDS = ['分类不对', '缺标签', '系列/卷次有误', '信息缺失', '其他'];

/**
 * 手机端阅读页。
 *
 * 数据与交互沿用桌面阅读页：同一套 api、同一份本地阅读位置、同一个引用弹框与会话状态（SSE 任务流由 AppContext 提供）。
 * 桌面端右侧的两个面板在这里变成底部抽屉，底部固定一条翻页/检索/书签操作条。
 */
export function MobileReaderPage() {
  const { threadId: threadIdParam } = useParams();
  const threadId = Number(threadIdParam);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const {
    session,
    settings,
    bookmarks,
    toggleBookmark,
    blockCookie,
    blockThread,
    isCookieBlocked,
    isThreadBlocked,
    notify,
    mergeTaskList,
    ready,
    run,
  } = useApp();
  const { vocab } = useTagVocab();
  const canManage = Boolean(session?.permissions.includes('thread.edit'));
  const canDownload = Boolean(session?.permissions.includes('thread.download'));

  const [thread, setThread] = useState<Thread | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [total, setTotal] = useState(0);
  /** 带引用参数进来时不去翻旧位置，否则会跟引用跳转打架 */
  const [opened] = useState(() => {
    const explicit = Number(searchParams.get('page') ?? 0);
    const quoted = Boolean(searchParams.get('quote'));
    return { explicit, saved: quoted ? null : loadReadPosition(session?.username, threadId) };
  });
  const [page, setPage] = useState(opened.explicit || opened.saved?.page || 1);
  const [poOnly, setPoOnly] = useState(searchParams.get('po') === '1');
  const [pagingMode, setPagingMode] = useState(settings.pagingMode);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** 要跳过去的那一楼 */
  const [jumpTarget, setJumpTarget] = useState<number | null>(
    searchParams.get('post') ? Number(searchParams.get('post')) : null,
  );
  /** 引用弹框：只记根楼层，链路在弹框内部维护 */
  const [quoteRoot, setQuoteRoot] = useState<number | null>(
    searchParams.get('quote') ? Number(searchParams.get('quote')) : null,
  );
  const [sheet, setSheet] = useState<'more' | 'search' | 'marks' | 'suggest' | null>(null);
  const [updating, setUpdating] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [suggestKind, setSuggestKind] = useState(SUGGEST_KINDS[0]);
  const [suggestDetail, setSuggestDetail] = useState('');

  // ---- 串内检索（抽屉）与书签抽屉 ----
  const [keyword, setKeyword] = useState('');
  const [peekKeyword, setPeekKeyword] = useState('');
  const [peekHits, setPeekHits] = useState<Post[]>([]);
  const [peekTotal, setPeekTotal] = useState(0);
  const [peekPage, setPeekPage] = useState(1);
  const [peekBusy, setPeekBusy] = useState(false);
  const [recentKeywords, setRecentKeywords] = useState<string[]>([]);
  const [postBookmarks, setPostBookmarks] = useState<PostBookmark[]>([]);
  const [bookmarksLoading, setBookmarksLoading] = useState(true);
  const [bookmarkFilter, setBookmarkFilter] = useState<BookmarkFilter>(
    () => loadBookmarkFilter('thread', session?.username) ?? defaultBookmarkFilter('thread', threadId),
  );
  /** 跳到别处前记下的阅读位置，用来「返回原处」 */
  const [returnTo, setReturnTo] = useState<{ page: number; postId: number } | null>(null);
  const pendingScroll = useRef<{ page: number; postId: number } | null>(null);

  const openQuote = useCallback((postId: number) => setQuoteRoot(postId), []);

  /** 记住当前阅读位置，之后可以一键回去 */
  const rememberPosition = useCallback(() => {
    setReturnTo((prev) => prev ?? { page, postId: topPostId() ?? 0 });
  }, [page]);

  /** 「跳到该楼」：先清掉检索条件，否则目标页会被过滤成空白 */
  const goToPost = useCallback(
    async (postId: number) => {
      const target = await api.quotePost(postId).catch(() => null);
      if (!target) {
        notify(`找不到 No.${postId}（可能未被下载）`, 'error');
        return;
      }
      if (target.threadId !== threadId) {
        notify(`该引用属于 No.${target.threadId}，正在跳转`, 'info');
        navigate(`/m/t/${target.threadId}?post=${postId}`);
        return;
      }
      setKeyword('');
      setPagingMode('island');
      setPoOnly(false);
      // 串首的 pageNum 是 0，但接口的 page 从 1 起，得夹一下
      setPage(Math.max(1, target.pageNum));
      setJumpTarget(postId);
      setQuoteRoot(null);
    },
    [navigate, notify, threadId],
  );

  /** 跳过去之后把那一条闪一下 */
  const highlightPost = (postId: number) => {
    const el = document.getElementById(`p${postId}`);
    if (!el) return;
    el.style.transition = 'background 0.4s';
    el.style.background = 'color-mix(in srgb, var(--accent) 12%, transparent)';
    window.setTimeout(() => {
      el.style.background = '';
    }, 1400);
  };

  const backToPosition = () => {
    if (!returnTo) return;
    setReturnTo(null);
    setKeyword('');
    setPoOnly(false);
    if (returnTo.page === page) {
      void scrollToPost(returnTo.postId, true);
      return;
    }
    pendingScroll.current = returnTo;
    setPage(returnTo.page);
  };

  /** 串内检索：命中只在抽屉里看，正文不动 */
  const runSearch = async (raw?: string) => {
    const value = (raw ?? keyword).trim();
    if (!value) return;
    setRecentKeywords(rememberKeyword(session?.username, value));
    setPeekBusy(true);
    const result = await api.fetchPosts(threadId, 1, PEEK_PAGE_SIZE, 'custom', value).catch(() => null);
    setPeekBusy(false);
    if (!result) return;
    setPeekKeyword(value);
    setPeekHits(result.items);
    setPeekTotal(result.total);
    setPeekPage(1);
    if (result.total === 0) notify(`没有命中「${value}」的楼层`, 'info');
  };

  const goToHitPage = async (next: number) => {
    setPeekBusy(true);
    const result = await api.fetchPosts(threadId, next, PEEK_PAGE_SIZE, 'custom', peekKeyword).catch(() => null);
    setPeekBusy(false);
    if (!result) return;
    setPeekHits(result.items);
    setPeekPage(next);
  };

  /** 速览里点「跳到该楼」：先记下现在的位置；抽屉关掉，正文直接换页 */
  const jumpFromPeek = async (postId: number) => {
    rememberPosition();
    setSheet(null);
    await goToPost(postId);
  };

  // 楼层书签：切串时重新拉；只有自己能看见
  useEffect(() => {
    if (!threadId) return;
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
  }, [threadId]);

  useEffect(() => {
    setRecentKeywords(loadRecentKeywords(session?.username));
  }, [session?.username]);

  const bookmarkedOfThread = useMemo(
    () => new Set(postBookmarks.filter((item) => item.threadId === threadId).map((item) => item.postId)),
    [postBookmarks, threadId],
  );
  const visibleBookmarks = useMemo(
    () => filterBookmarks(postBookmarks, bookmarkFilter, 'thread'),
    [bookmarkFilter, postBookmarks],
  );

  const updateBookmarkFilter = (next: BookmarkFilter) => {
    setBookmarkFilter(next);
    saveBookmarkFilter('thread', session?.username, next);
  };

  /** 加/取消楼层书签；先本地更新，失败再回滚（接口返回 204，不能用返回值判断成败） */
  const togglePostBookmark = async (postId: number) => {
    const had = bookmarkedOfThread.has(postId);
    const previous = postBookmarks;
    const post = posts.find((item) => item.id === postId);
    setPostBookmarks((list) =>
      had
        ? list.filter((item) => !(item.threadId === threadId && item.postId === postId))
        : [
            {
              postId,
              threadId,
              threadTitle: thread?.title ?? `No.${threadId}`,
              title: '',
              pageNum: post?.pageNum ?? 0,
              excerpt: (post?.content ?? '').replace(/\s+/g, ' ').slice(0, 90),
              createdAt: 0,
              tags: thread?.tags ?? [],
            },
            ...list,
          ],
    );
    try {
      if (had) await api.removePostBookmark(threadId, postId);
      else await api.addPostBookmark(threadId, postId);
      notify(had ? `已移除 No.${postId} 的书签` : `已把 No.${postId} 加入书签`, 'ok');
    } catch (error) {
      setPostBookmarks(previous);
      notify(error instanceof Error ? error.message : '书签操作失败', 'error');
    }
  };

  const removeBookmark = async (bookmark: PostBookmark) => {
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

  const renameBookmark = async (bookmark: PostBookmark, title: string) => {
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

  /** 从书签抽屉跳楼：同样先记住当前位置 */
  const jumpFromBookmark = async (bookmark: PostBookmark) => {
    rememberPosition();
    setSheet(null);
    if (bookmark.threadId === threadId) {
      await goToPost(bookmark.postId);
      return;
    }
    navigate(`/m/t/${bookmark.threadId}?post=${bookmark.postId}`);
  };

  /** 更新：后台提交下载任务 */
  const updateThread = async () => {
    setUpdating(true);
    const task = await run(() => api.submitTask(threadId, 'XD', ''), undefined);
    setUpdating(false);
    setSheet(null);
    if (!task) return;
    mergeTaskList([task]);
    notify(`已提交更新 No.${threadId}（任务 ${task.taskId}）`, 'ok');
  };

  // 返回原处时等新内容渲染完再滚回去
  useEffect(() => {
    if (loading || pendingScroll.current === null) return;
    const target = pendingScroll.current;
    pendingScroll.current = null;
    void scrollToPost(target.postId, true);
  }, [loading, posts]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [detail, paged] = await Promise.all([
        api.fetchThread(threadId),
        api.fetchPosts(threadId, page, settings.pageSize, pagingMode, '', poOnly),
      ]);
      setThread(detail);
      setPosts(paged.items);
      setTotal(paged.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '加载失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, [page, pagingMode, poOnly, settings.pageSize, threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 打开串时滚回上次读到的那一楼（等这一页渲染完再滚，楼层才在 DOM 里）
  const restoring = useRef(opened.saved?.postId ?? null);
  useEffect(() => {
    if (loading || restoring.current === null) return;
    const postId = restoring.current;
    void scrollToPost(postId).then(() => {
      restoring.current = null;
    });
  }, [loading, posts]);

  // 本地没有记录时，用服务端记住的页码兜底（换设备也能接着看）
  const askServer = useRef(!opened.explicit && !opened.saved);
  useEffect(() => {
    if (!askServer.current) return;
    askServer.current = false;
    void api
      .fetchProgress()
      .then((items) => {
        const found = items.find((item) => item.threadId === threadId);
        if (found && found.page > 1) setPage(found.page);
      })
      .catch(() => undefined);
  }, [threadId]);

  // 记录阅读进度：页码进服务端（多端可续读），楼号进本地（回到精确的那一楼）
  useEffect(() => {
    if (!loading && thread) void api.saveProgress(threadId, page).catch(() => undefined);
  }, [loading, page, thread, threadId]);

  useEffect(() => {
    let raf = 0;
    const remember = () => {
      // 位置还在恢复中就别记，否则会把要回去的那一楼覆盖掉
      if (raf || restoring.current !== null) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        const postId = topPostId();
        if (postId) saveReadPosition(session?.username, threadId, { page, postId });
      });
    };
    window.addEventListener('scroll', remember, { passive: true });
    remember();
    return () => {
      window.removeEventListener('scroll', remember);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [page, posts, session?.username, threadId]);

  // URL 里始终带着页码与跳转目标：刷新/分享都能回到同一处
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('page', String(page));
        if (poOnly) next.set('po', '1');
        else next.delete('po');
        if (jumpTarget) next.set('post', String(jumpTarget));
        else next.delete('post');
        return next;
      },
      { replace: true },
    );
  }, [jumpTarget, page, poOnly, setSearchParams]);

  // 跳到某一楼：不在本页就先查出它在第几页，翻过去再滚
  const resolving = useRef<number | null>(null);
  useEffect(() => {
    // ready 之后黑名单才是同步过的，否则会拿旧设置判断「有没有被屏蔽」
    if (!ready || !jumpTarget || loading) return;
    const target = jumpTarget;
    const post = posts.find((item) => item.id === target);

    if (!post) {
      if (resolving.current === target) {
        resolving.current = null;
        setJumpTarget(null);
        notify(`找不到 No.${target} 的正文，可能还没下载到`, 'warn');
        return;
      }
      resolving.current = target;
      void api
        .quotePost(target)
        .then((found) => {
          if (found.threadId !== threadId) {
            setJumpTarget(null);
            navigate(`/m/t/${found.threadId}?post=${target}`);
            return;
          }
          setPage(Math.max(1, found.pageNum));
        })
        .catch(() => {
          resolving.current = null;
          setJumpTarget(null);
          notify(`找不到 No.${target}（可能未被下载）`, 'warn');
        });
      return;
    }

    resolving.current = null;
    setJumpTarget(null);
    if (isThreadBlocked(threadId)) {
      notify(`No.${threadId} 已被你屏蔽，这次是临时打开的`, 'warn');
    }
    if (isCookieBlocked(post.cookie)) {
      notify(`No.${target} 的饼干 ${post.cookie} 在你的黑名单里，这一楼已被隐藏`, 'warn');
      return;
    }
    void scrollToPost(target, true).then(() => highlightPost(target));
  }, [isCookieBlocked, isThreadBlocked, jumpTarget, loading, navigate, notify, posts, ready, threadId]);

  // 只看 Po 时按过滤结果分页，与后端一致
  const totalPages = poOnly
    ? Math.max(1, Math.ceil(total / settings.pageSize))
    : pagingMode === 'island'
      ? Math.max(1, thread?.pageCount ?? 1)
      : Math.max(1, Math.ceil(total / settings.pageSize));

  const visiblePosts = useMemo(() => posts.filter((post) => !isCookieBlocked(post.cookie)), [posts, isCookieBlocked]);
  const hiddenCount = posts.length - visiblePosts.length;
  const bookmarked = bookmarks.some((item) => item.threadId === threadId);
  const customPaging = pagingMode === 'custom' || poOnly;

  const changePage = (next: number) => {
    const target = Math.min(Math.max(1, next), totalPages);
    if (target === page) return;
    setPage(target);
    window.scrollTo({ top: 0 });
  };

  if (error) {
    return (
      <div className="m-page" style={{ padding: 12 }}>
        <div className="card">
          <h3>无法打开这个串</h3>
          <p className="error-text">{error}</p>
          <p className="hint">常见原因：串号不存在、不是主串、或该串尚未下载。可以到管理页提交下载申请。</p>
          <div className="m-actions">
            <button className="btn" onClick={() => navigate('/m/home')}>
              返回目录
            </button>
            {canDownload && (
              <button className="btn" onClick={() => navigate('/m/admin?tab=submit')}>
                去提交下载申请
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="m-reader">
      <header className="app-header m-reader-head">
        <div className="m-reader-head-inner">
          <button className="m-icon-btn" aria-label="返回目录" title="返回目录" onClick={() => navigate('/m/home')}>
            <IconArrowLeft />
          </button>
          <span className="m-reader-head-title">{thread?.title ?? '加载中…'}</span>
          <button
            className={`m-icon-btn ${bookmarked ? 'active' : ''}`}
            aria-label={bookmarked ? '取消收藏' : '收藏'}
            title={bookmarked ? '取消收藏' : '收藏'}
            onClick={() => void toggleBookmark(threadId)}
          >
            <IconBookmark />
          </button>
          <button className="m-icon-btn" aria-label="更多操作" title="更多操作" onClick={() => setSheet('more')}>
            <IconMore />
          </button>
        </div>
      </header>

      <div className="m-reader-body">
        <div className="card m-reader-card">
          <div className="m-item-meta" style={{ fontSize: '0.8em' }}>
            <span className="mono">No.{threadId}</span>
            {thread?.board && (
              <button
                className="badge badge-board"
                onClick={() => navigate(`/m/home?board=${encodeURIComponent(thread.board as string)}`)}
              >
                {thread.board}
              </button>
            )}
            {thread && <span className="mono">ID:{thread.cookie}</span>}
            <span>{thread?.replies ?? 0} 回复</span>
            <span>{thread?.pageCount ?? 0} 页</span>
            <span>{thread?.imageCount ?? 0} 图</span>
            <span>更新于 {thread ? fmtRelative(thread.updatedAt) : '-'}</span>
          </div>
          {thread && thread.tags.length > 0 && (
            <div className="m-thread-tags" style={{ marginTop: 8 }}>
              {thread.tags.map((tag) => (
                <TagChip key={`${tag.tagType}-${tag.tagName}`} tag={tag} />
              ))}
            </div>
          )}
          <div className="m-actions">
            <button
              className={`btn btn-sm ${poOnly ? 'btn-primary' : ''}`}
              title="只留下楼主自己的楼层"
              onClick={() => {
                setPoOnly((value) => !value);
                setPage(1);
              }}
            >
              {poOnly ? '取消只看 Po' : '只看 Po'}
            </button>
            <button
              className="btn btn-sm"
              title="不按岛上的页码，每页固定楼数"
              onClick={() => {
                setPagingMode(customPaging ? 'island' : 'custom');
                setPage(1);
              }}
            >
              {customPaging ? `按 ${settings.pageSize} 条/页` : '按岛页码'}
            </button>
            {canDownload && (
              <button className="btn btn-sm" disabled={updating} onClick={() => void updateThread()}>
                {updating ? '提交中…' : '更新'}
              </button>
            )}
            <button className="btn btn-sm" onClick={() => setExportOpen(true)}>
              导出
            </button>
          </div>
        </div>

        <div className="card m-reader-card" style={{ padding: 0 }}>
          {hiddenCount > 0 && (
            <p className="hint" style={{ padding: '8px 12px 0' }}>
              本页已按黑名单隐藏 {hiddenCount} 楼
            </p>
          )}
          {loading && <div className="loading">串数据加载中…</div>}
          {!loading && visiblePosts.length === 0 && <div className="empty">本页没有可显示的楼层</div>}
          {!loading &&
            visiblePosts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                onQuote={openQuote}
                onBlockCookie={blockCookie}
                onBlockThread={blockThread}
                bookmarked={bookmarkedOfThread.has(post.id)}
                onToggleBookmark={togglePostBookmark}
              />
            ))}
        </div>
      </div>

      <div className="m-reader-bar">
        <button
          className="m-reader-btn"
          disabled={page <= 1}
          aria-label="上一页"
          title="上一页"
          onClick={() => changePage(page - 1)}
        >
          <IconPagerPrev />
          <span>上一页</span>
        </button>
        <span className="m-reader-page">
          第 <span className="mono">{page}</span> / {totalPages} 页
        </span>
        <button
          className="m-reader-btn"
          disabled={page >= totalPages}
          aria-label="下一页"
          title="下一页"
          onClick={() => changePage(page + 1)}
        >
          <IconPagerNext />
          <span>下一页</span>
        </button>
        <span className="spacer" />
        <button className="m-reader-btn" aria-label="串内检索" title="串内检索" onClick={() => setSheet('search')}>
          <IconSearch />
          <span>检索</span>
        </button>
        <button className="m-reader-btn" aria-label="楼层书签" title="楼层书签" onClick={() => setSheet('marks')}>
          <IconBookmark />
          <span>书签</span>
          {visibleBookmarks.length > 0 && <span className="rail-badge">{visibleBookmarks.length}</span>}
        </button>
      </div>

      {sheet === 'search' && (
        <MobileSheet title="串内检索" onClose={() => setSheet(null)} bare>
          <HitListPanel
            keyword={keyword}
            onKeyword={setKeyword}
            onSearch={(raw) => void runSearch(raw)}
            highlight={peekKeyword}
            recent={recentKeywords}
            onPickRecent={(item) => {
              setKeyword(item);
              void runSearch(item);
            }}
            busy={peekBusy}
            hits={peekHits}
            total={peekTotal}
            page={peekPage}
            pageSize={PEEK_PAGE_SIZE}
            onPage={(next) => void goToHitPage(next)}
            onQuote={openQuote}
            emptyHint="输入关键词后回车，命中在这里看，正文不动；空格分词，英文双引号内完全匹配。"
            searchHint=""
            actions={(post, index) => (
              <>
                <button className="link-btn" onClick={() => void jumpFromPeek(post.id)}>
                  跳到该楼
                </button>
                <button className="link-btn" onClick={() => void togglePostBookmark(post.id)}>
                  {bookmarkedOfThread.has(post.id) ? '移除书签' : '添加书签'}
                </button>
                <span className="faint">本页第 {index + 1} 条</span>
              </>
            )}
          />
        </MobileSheet>
      )}

      {sheet === 'marks' && (
        <MobileSheet title="楼层书签" onClose={() => setSheet(null)} bare>
          <BookmarkPanel
            items={postBookmarks}
            loading={bookmarksLoading}
            scope="thread"
            filters={bookmarkFilter}
            defaultFilter={defaultBookmarkFilter('thread', threadId)}
            onFilters={updateBookmarkFilter}
            onReset={() => {
              clearBookmarkFilter('thread', session?.username);
              setBookmarkFilter(defaultBookmarkFilter('thread', threadId));
            }}
            vocab={vocab}
            onJump={(bookmark) => void jumpFromBookmark(bookmark)}
            onRemove={(bookmark) => void removeBookmark(bookmark)}
            onRename={(bookmark, title) => void renameBookmark(bookmark, title)}
          />
        </MobileSheet>
      )}

      {sheet === 'more' && (
        <MobileSheet title={`No.${threadId} 操作`} onClose={() => setSheet(null)}>
          <div className="m-sheet-actions">
            <button onClick={() => void toggleBookmark(threadId)}>{bookmarked ? '取消收藏此串' : '收藏此串'}</button>
            {canManage && (
              <button onClick={() => navigate(`/m/admin?tab=threads&thread=${threadId}`)}>管理串信息与标签</button>
            )}
            <button onClick={() => setExportOpen(true)}>导出为 Word / PDF</button>
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(String(threadId)).catch(() => undefined);
                notify('串号已复制', 'ok');
              }}
            >
              复制串号
            </button>
            <button
              onClick={() => {
                setSheet('suggest');
              }}
            >
              建议修正
            </button>
            <button
              className="danger"
              onClick={() => {
                blockThread(threadId);
                navigate('/m/home');
              }}
            >
              屏蔽此串
            </button>
            {thread && (
              <button
                className="danger"
                onClick={() => {
                  blockCookie(thread.cookie);
                  navigate('/m/home');
                }}
              >
                屏蔽 Po 饼干 ID:{thread.cookie}
              </button>
            )}
            <button
              onClick={() => {
                writeUiMode('desktop');
                navigate(toDesktopPath(`/m/t/${threadId}`));
              }}
            >
              用电脑版打开此串
            </button>
          </div>
        </MobileSheet>
      )}

      {sheet === 'suggest' && (
        <MobileSheet
          title="建议修正"
          onClose={() => setSheet(null)}
          footer={
            <>
              <span className="spacer" />
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  void run(() => api.suggestFix(threadId, suggestKind, suggestDetail), '建议已提交，等待管理员处理');
                  setSuggestDetail('');
                  setSheet(null);
                }}
              >
                提交
              </button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="m-suggest-kind">问题类型</label>
            <select
              id="m-suggest-kind"
              className="select"
              value={suggestKind}
              onChange={(event) => setSuggestKind(event.target.value)}
            >
              {SUGGEST_KINDS.map((kind) => (
                <option key={kind}>{kind}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="m-suggest-detail">补充说明</label>
            <textarea
              id="m-suggest-detail"
              className="textarea"
              placeholder="例如：应该归到「规则怪谈」"
              value={suggestDetail}
              onChange={(event) => setSuggestDetail(event.target.value)}
            />
          </div>
        </MobileSheet>
      )}

      {quoteRoot !== null && (
        <QuotePopup
          key={quoteRoot}
          rootPostId={quoteRoot}
          threadId={threadId}
          onGoToPost={(postId) => {
            rememberPosition();
            void goToPost(postId);
          }}
          onClose={() => {
            setQuoteRoot(null);
            if (searchParams.get('quote')) {
              const next = new URLSearchParams(searchParams);
              next.delete('quote');
              setSearchParams(next, { replace: true });
            }
          }}
        />
      )}

      {exportOpen && (
        <ExportDialog
          threadId={threadId}
          title={thread?.title ?? `No.${threadId}`}
          onClose={() => setExportOpen(false)}
        />
      )}

      {returnTo &&
        createPortal(
          <button className="btn btn-sm btn-primary m-return-fab" title="回到跳转前的阅读位置" onClick={backToPosition}>
            ← 返回原处（第 {returnTo.page} 页）
          </button>,
          document.body,
        )}
    </div>
  );
}
