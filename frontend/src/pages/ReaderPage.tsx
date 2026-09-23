import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Post, PostBookmark, Thread } from '../api/types';
import { useApp } from '../state/AppContext';
import { useTagVocab } from '../state/TagVocabContext';
import { PostCard } from '../components/PostCard';
import { QuotePopup } from '../components/QuotePopup';
import { ToolsDock, type DockItem } from '../components/ToolsDock';
import { useDock } from '../components/useDock';
import { IconBookmark, IconSearch } from '../components/icons';
import {
  clearBookmarkFilter,
  defaultBookmarkFilter,
  filterBookmarks,
  loadBookmarkFilter,
  saveBookmarkFilter,
  type BookmarkFilter,
} from '../components/bookmarkFilter';
import { HitListPanel } from '../components/HitListPanel';
import { BookmarkPanel } from '../components/BookmarkPanel';
import { ExportDialog } from '../components/ExportDialog';
import { loadRecentKeywords, rememberKeyword } from '../components/recentKeywords';
import { loadReadPosition, saveReadPosition, scrollToPost, topPostId } from '../components/readPosition';
import { Pagination } from '../components/Pagination';
import { TagChip } from '../components/TagChip';
import { fmtRelative } from '../components/format';

/** 速览一次取多少条（接口 pageSize 上限 200） */
const PEEK_PAGE_SIZE = 200;

/** 阅读页右侧工具栏的两个面板 */
type DockKey = 'search' | 'marks';

export function ReaderPage() {
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
  const [keyword, setKeyword] = useState('');
  const [pagingMode, setPagingMode] = useState(settings.pagingMode);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** 要跳过去的那一楼：滚到它并把 app-header 底边和它的顶边对齐 */
  const [jumpTarget, setJumpTarget] = useState<number | null>(
    searchParams.get('post') ? Number(searchParams.get('post')) : null,
  );
  const [suggestOpen, setSuggestOpen] = useState(false);
  /** 引用弹框：只记根楼层，链路在弹框内部维护 */
  const [quoteRoot, setQuoteRoot] = useState<number | null>(
    searchParams.get('quote') ? Number(searchParams.get('quote')) : null,
  );
  const [suggestKind, setSuggestKind] = useState('分类不对');
  const [suggestDetail, setSuggestDetail] = useState('');

  // ---- 右侧工具栏：检索面板的速览结果 + 书签面板 ----

  const [peekKeyword, setPeekKeyword] = useState('');
  const [peekHits, setPeekHits] = useState<Post[]>([]);
  const [peekTotal, setPeekTotal] = useState(0);
  const [peekPage, setPeekPage] = useState(1);
  const [peekBusy, setPeekBusy] = useState(false);
  /** 跳到别处前记下的阅读位置，用来「返回原处」 */
  const [returnTo, setReturnTo] = useState<{ page: number; postId: number } | null>(null);
  const pendingScroll = useRef<{ page: number; postId: number } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const { active: tool, toggle: toggleTool, close: closeTool } = useDock<DockKey>();
  const [postBookmarks, setPostBookmarks] = useState<PostBookmark[]>([]);
  const [bookmarksLoading, setBookmarksLoading] = useState(true);
  const [bookmarkFilter, setBookmarkFilter] = useState<BookmarkFilter>(
    () => loadBookmarkFilter('thread', session?.username) ?? defaultBookmarkFilter('thread', threadId),
  );
  const [recentKeywords, setRecentKeywords] = useState<string[]>([]);

  /** 点引用：弹框预览，不跳转 */
  const openQuote = useCallback((postId: number) => {
    setQuoteRoot(postId);
  }, []);

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
        navigate(`/t/${target.threadId}?post=${postId}`);
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

  /** 记住当前阅读位置，之后可以一键回去 */
  const rememberPosition = useCallback(() => {
    setReturnTo((prev) => prev ?? { page, postId: topPostId() ?? 0 });
  }, [page]);

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

  /** 串内检索：命中只在右侧面板里看，正文不动 */
  const runSearch = async (raw?: string) => {
    const kw = (raw ?? keyword).trim();
    if (!kw) return;
    setRecentKeywords(rememberKeyword(session?.username, kw));
    setPeekBusy(true);
    const result = await api.fetchPosts(threadId, 1, PEEK_PAGE_SIZE, 'custom', kw).catch(() => null);
    setPeekBusy(false);
    if (!result) return;
    if (result.total === 0) {
      setPeekKeyword(kw);
      setPeekHits([]);
      setPeekTotal(0);
      setPeekPage(1);
      notify(`没有命中「${kw}」的楼层`, 'info');
      return;
    }
    setPeekHits(result.items);
    setPeekTotal(result.total);
    setPeekPage(1);
    setPeekKeyword(kw);
  };

  /** 翻到命中的第几页 */
  const goToHitPage = async (next: number) => {
    setPeekBusy(true);
    const result = await api.fetchPosts(threadId, next, PEEK_PAGE_SIZE, 'custom', peekKeyword).catch(() => null);
    setPeekBusy(false);
    if (!result) return;
    setPeekHits(result.items);
    setPeekPage(next);
  };

  /** 速览里点「跳到该楼」：先记下现在的位置；面板保持打开，方便接着看别的命中 */
  const jumpFromPeek = async (postId: number) => {
    rememberPosition();
    await goToPost(postId);
  };

  // 楼层书签：切串时重新拉；只有自己能看见
  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    api
      .fetchPostBookmarks(threadId)
      .then((list) => alive && setPostBookmarks(list))
      .catch(() => alive && setPostBookmarks([]));
    return () => {
      alive = false;
    };
  }, [threadId]);

  // 拉一次全部书签：串内默认只看本串，但面板里能切到别的串或全部
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
  }, [threadId]);

  // 最近三次检索词（按用户名存在浏览器本地）
  useEffect(() => {
    setRecentKeywords(loadRecentKeywords(session?.username));
  }, [session?.username]);

  const bookmarkedOfThread = useMemo(
    () => new Set(postBookmarks.filter((item) => item.threadId === threadId).map((item) => item.postId)),
    [postBookmarks, threadId],
  );
  /** 面板里真正显示的那批（默认只看本串，可切到别的串或全部） */
  const visibleBookmarks = useMemo(
    () => filterBookmarks(postBookmarks, bookmarkFilter, 'thread'),
    [bookmarkFilter, postBookmarks],
  );

  const updateBookmarkFilter = (next: BookmarkFilter) => {
    setBookmarkFilter(next);
    saveBookmarkFilter('thread', session?.username, next);
  };

  const resetBookmarkFilter = () => {
    clearBookmarkFilter('thread', session?.username);
    setBookmarkFilter(defaultBookmarkFilter('thread', threadId));
  };

  /** 加/取消楼层书签；先本地更新，失败再回滚（接口返回 204，不能用返回值判断成败） */
  const togglePostBookmark = async (postId: number) => {
    const had = bookmarkedOfThread.has(postId);
    const prev = postBookmarks;
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
      setPostBookmarks(prev);
      notify(error instanceof Error ? error.message : '书签操作失败', 'error');
    }
  };

  /** 从书签面板移除：可能是别的串的，所以按书签自己的串号删 */
  const removeBookmark = async (bookmark: PostBookmark) => {
    const prev = postBookmarks;
    setPostBookmarks((list) =>
      list.filter((item) => !(item.threadId === bookmark.threadId && item.postId === bookmark.postId)),
    );
    try {
      await api.removePostBookmark(bookmark.threadId, bookmark.postId);
      notify(`已移除 No.${bookmark.postId} 的书签`, 'ok');
    } catch (error) {
      setPostBookmarks(prev);
      notify(error instanceof Error ? error.message : '书签操作失败', 'error');
    }
  };

  /** 改书签名字：乐观更新，失败回滚 */
  const renameBookmark = async (bookmark: PostBookmark, title: string) => {
    const prev = postBookmarks;
    setPostBookmarks((list) =>
      list.map((item) =>
        item.threadId === bookmark.threadId && item.postId === bookmark.postId ? { ...item, title } : item,
      ),
    );
    try {
      await api.renamePostBookmark(bookmark.threadId, bookmark.postId, title);
    } catch (error) {
      setPostBookmarks(prev);
      notify(error instanceof Error ? error.message : '书签名保存失败', 'error');
    }
  };

  /** 从书签面板跳楼：同样先记住当前位置 */
  const jumpFromBookmark = async (bookmark: PostBookmark) => {
    rememberPosition();
    if (bookmark.threadId === threadId) {
      await goToPost(bookmark.postId);
      return;
    }
    // 直接跳到那一楼，不再弹引用框
    navigate(`/t/${bookmark.threadId}?post=${bookmark.postId}`);
  };

  /** 更新：后台提交下载任务 */
  const updateThread = async () => {
    setUpdating(true);
    const task = await run(() => api.submitTask(threadId, 'XD', ''), undefined);
    setUpdating(false);
    if (!task) return;
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
      const [t, p] = await Promise.all([
        api.fetchThread(threadId),
        api.fetchPosts(threadId, page, settings.pageSize, pagingMode, '', poOnly),
      ]);
      setThread(t);
      setPosts(p.items);
      setTotal(p.total);
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

  // 翻页回到页首（「返回原处」例外，它要滚到指定楼层）
  const firstPage = useRef(true);
  useEffect(() => {
    if (firstPage.current) {
      firstPage.current = false;
      return;
    }
    if (!pendingScroll.current) window.scrollTo({ top: 0 });
  }, [page]);

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

  // 跳到某一楼：不在本页就先查出它在第几页，翻过去再滚。
  // 滚到位时 .post 的 scroll-margin-top 正好让顶边贴住导航栏下沿（不是屏幕顶部，也不是居中）。
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
            navigate(`/t/${found.threadId}?post=${target}`);
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
  const filtered = poOnly;
  const totalPages = filtered
    ? Math.max(1, Math.ceil(total / settings.pageSize))
    : pagingMode === 'island'
      ? Math.max(1, thread?.pageCount ?? 1)
      : Math.max(1, Math.ceil(total / settings.pageSize));

  const visiblePosts = useMemo(() => posts.filter((p) => !isCookieBlocked(p.cookie)), [posts, isCookieBlocked]);
  const hiddenCount = posts.length - visiblePosts.length;
  const bookmarked = bookmarks.some((b) => b.threadId === threadId);

  if (error) {
    return (
      <div className="card">
        <h3>无法打开这个串</h3>
        <p className="error-text">{error}</p>
        <p className="hint">常见原因：串号不存在、不是主串、或该串尚未下载。可以到管理页提交下载申请。</p>
        <div className="row">
          <Link className="btn" to="/home">
            返回目录
          </Link>
          <Link className="btn" to="/admin">
            去管理页
          </Link>
        </div>
      </div>
    );
  }

  const dockItems: Array<DockItem<DockKey>> = [
    { key: 'search', label: '串内检索', icon: <IconSearch /> },
    { key: 'marks', label: '书签', icon: <IconBookmark />, badge: visibleBookmarks.length },
  ];

  const renderDockPanel = (key: DockKey) => {
    if (key === 'search') {
      return (
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
          emptyHint="输入关键词后回车，命中在这里看，正文不动。"
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
      );
    }
    return (
      <BookmarkPanel
        items={postBookmarks}
        loading={bookmarksLoading}
        scope="thread"
        filters={bookmarkFilter}
        defaultFilter={defaultBookmarkFilter('thread', threadId)}
        onFilters={updateBookmarkFilter}
        onReset={resetBookmarkFilter}
        vocab={vocab}
        onJump={(bookmark) => void jumpFromBookmark(bookmark)}
        onRemove={(bookmark) => void removeBookmark(bookmark)}
        onRename={(bookmark, title) => void renameBookmark(bookmark, title)}
      />
    );
  };

  return (
    <>
      <div className="card">
        <div className="card-title">
          <h3>{thread?.title ?? '加载中…'}</h3>
          <div className="row row-wrap">
            {canDownload && (
              <button
                className="btn btn-sm"
                disabled={updating}
                title="后台提交下载任务（只补最后一页及之后）"
                onClick={() => void updateThread()}
              >
                {updating ? '提交中…' : '更新'}
              </button>
            )}
            {canManage && (
              <button
                className="btn btn-sm"
                title="到管理页修改这个串的信息与标签"
                onClick={() => navigate(`/admin?tab=threads&thread=${threadId}`)}
              >
                管理
              </button>
            )}
            <button className="btn btn-sm" title="导出为 Word / PDF" onClick={() => setExportOpen(true)}>
              导出
            </button>
            <button className="btn btn-sm" onClick={() => void toggleBookmark(threadId)}>
              {bookmarked ? '取消收藏' : '收藏'}
            </button>
            <button
              className={`btn btn-sm ${poOnly ? 'btn-primary' : ''}`}
              title="只留下楼主自己的楼层"
              onClick={() => {
                setPoOnly((v) => !v);
                setPage(1);
              }}
            >
              {poOnly ? '取消只看Po' : '只看Po'}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                blockThread(threadId);
                navigate('/home');
              }}
            >
              屏蔽此串
            </button>
            {thread && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  blockCookie(thread.cookie);
                  navigate('/home');
                }}
              >
                屏蔽 Po 饼干
              </button>
            )}
            <button className="btn btn-sm btn-ghost" onClick={() => setSuggestOpen((v) => !v)}>
              建议修正
            </button>
          </div>
        </div>
        <div className="thread-meta">
          <span className="mono">No.{threadId}</span>
          {thread?.board && (
            <button
              className="badge badge-board"
              onClick={() => navigate(`/home?board=${encodeURIComponent(thread.board as string)}`)}
              title={`只看「${thread.board}」板块`}
            >
              {thread.board}
            </button>
          )}
          {thread && <span className="mono">ID:{thread.cookie}</span>}
          <span>· {thread?.replies ?? 0} 回复</span>
          <span>· {thread?.pageCount ?? 0} 页</span>
          <span>· {thread?.imageCount ?? 0} 图</span>
          <span>· 更新于 {thread ? fmtRelative(thread.updatedAt) : '-'}</span>
          {thread?.tags.map((tag) => (
            <TagChip key={`${tag.tagType}-${tag.tagName}`} tag={tag} />
          ))}
        </div>

        {suggestOpen && (
          <div className="card mt-12" style={{ background: 'var(--surface-2)' }}>
            <div className="row row-wrap">
              <select
                className="select"
                style={{ width: 150 }}
                value={suggestKind}
                onChange={(e) => setSuggestKind(e.target.value)}
              >
                {['分类不对', '缺标签', '系列/卷次有误', '信息缺失', '其他'].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
              <input
                className="input"
                style={{ flex: 1, minWidth: 200 }}
                placeholder="补充说明，例如：应该归到「规则怪谈」"
                value={suggestDetail}
                onChange={(e) => setSuggestDetail(e.target.value)}
              />
              <button
                className="btn btn-primary"
                onClick={() => {
                  void run(() => api.suggestFix(threadId, suggestKind, suggestDetail), '建议已提交，等待管理员处理');
                  setSuggestDetail('');
                  setSuggestOpen(false);
                }}
              >
                提交
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card mt-12">
        {poOnly && (
          <p className="hint">
            只看 Po
            <button
              className="link-btn"
              style={{ marginLeft: 8 }}
              onClick={() => {
                setPoOnly(false);
                setPage(1);
              }}
            >
              显示全部楼层
            </button>
          </p>
        )}

        {/* 顶部页码：不用滚到底就能翻页；分页方式也跟着放这儿 */}
        <div className="reader-pager-top">
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          <label className="switch" title="不按岛上的页码，每页固定楼数">
            <input
              type="checkbox"
              checked={pagingMode === 'custom' || filtered}
              disabled={filtered}
              onChange={(e) => {
                setPagingMode(e.target.checked ? 'custom' : 'island');
                setPage(1);
              }}
            />
            按 {settings.pageSize} 条/页
          </label>
        </div>
        {hiddenCount > 0 && <p className="hint">本页已按黑名单隐藏 {hiddenCount} 楼</p>}
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
        {quoteRoot !== null && (
          <QuotePopup
            key={quoteRoot}
            rootPostId={quoteRoot}
            threadId={threadId}
            onGoToPost={(id) => {
              rememberPosition();
              void goToPost(id);
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
        {/* 悬浮在左侧、不随正文滚动：从速览跳走之后一键回到原来的阅读位置 */}
        {returnTo &&
          createPortal(
            <button className="btn btn-sm btn-primary return-fab" title="回到跳转前的阅读位置" onClick={backToPosition}>
              ← 返回原处（第 {returnTo.page} 页）
            </button>,
            document.body,
          )}

        <div className="reader-foot">
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </div>
      </div>

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
