import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import type { PostBookmark, Thread } from '../../api/types';
import { useApp } from '../../state/AppContext';
import { useTagVocab } from '../../state/TagVocabContext';
import { BookmarkPanel } from '../../components/BookmarkPanel';
import {
  clearBookmarkFilter,
  defaultBookmarkFilter,
  loadBookmarkFilter,
  saveBookmarkFilter,
  type BookmarkFilter,
} from '../../components/bookmarkFilter';
import { MobileThreadCard } from '../components/MobileThreadCard';

type TabKey = 'posts' | 'threads';

/**
 * 手机端书签页：楼层书签（与桌面右侧「书签」面板同一份数据与筛选）＋ 收藏的串。
 *
 * 桌面端把楼层书签放在侧栏、串收藏混在目录里；手机端合成一页，两种口径用分段条切。
 */
export function MobileBookmarksPage() {
  const { session, bookmarks, toggleBookmark, notify } = useApp();
  const { vocab } = useTagVocab();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>('posts');

  const [items, setItems] = useState<PostBookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<BookmarkFilter>(
    () => loadBookmarkFilter('directory', session?.username) ?? defaultBookmarkFilter('directory'),
  );

  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);

  // 楼层书签：与桌面目录页共用同一份记忆条件（scope=directory）
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .fetchPostBookmarks()
      .then((list) => alive && setItems(list))
      .catch(() => alive && setItems([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [session?.username]);

  const loadThreads = useCallback(async () => {
    setThreadsLoading(true);
    const result = await api
      .fetchThreads({ bookmarkedOnly: true, sort: 'updated_desc', pageSize: 100 })
      .catch(() => null);
    setThreads(result?.items ?? []);
    setThreadsLoading(false);
  }, []);

  useEffect(() => {
    if (tab === 'threads') void loadThreads();
  }, [loadThreads, tab]);

  const updateFilter = (next: BookmarkFilter) => {
    setFilter(next);
    saveBookmarkFilter('directory', session?.username, next);
  };

  const removeBookmark = async (bookmark: PostBookmark) => {
    const previous = items;
    setItems((list) =>
      list.filter((item) => !(item.threadId === bookmark.threadId && item.postId === bookmark.postId)),
    );
    try {
      await api.removePostBookmark(bookmark.threadId, bookmark.postId);
      notify(`已移除 No.${bookmark.postId} 的书签`, 'ok');
    } catch (error) {
      setItems(previous);
      notify(error instanceof Error ? error.message : '书签操作失败', 'error');
    }
  };

  const renameBookmark = async (bookmark: PostBookmark, title: string) => {
    const previous = items;
    setItems((list) =>
      list.map((item) =>
        item.threadId === bookmark.threadId && item.postId === bookmark.postId ? { ...item, title } : item,
      ),
    );
    try {
      await api.renamePostBookmark(bookmark.threadId, bookmark.postId, title);
    } catch (error) {
      setItems(previous);
      notify(error instanceof Error ? error.message : '书签名保存失败', 'error');
    }
  };

  return (
    <div className="m-page">
      <div className="m-seg">
        <button className={tab === 'posts' ? 'active' : ''} onClick={() => setTab('posts')}>
          楼层书签（{items.length}）
        </button>
        <button className={tab === 'threads' ? 'active' : ''} onClick={() => setTab('threads')}>
          收藏的串（{bookmarks.length}）
        </button>
      </div>

      {tab === 'posts' ? (
        <div className="card m-panel" style={{ padding: 0 }}>
          <BookmarkPanel
            items={items}
            loading={loading}
            scope="directory"
            filters={filter}
            defaultFilter={defaultBookmarkFilter('directory')}
            onFilters={updateFilter}
            onReset={() => {
              clearBookmarkFilter('directory', session?.username);
              setFilter(defaultBookmarkFilter('directory'));
            }}
            vocab={vocab}
            onJump={(bookmark) => navigate(`/m/t/${bookmark.threadId}?post=${bookmark.postId}`)}
            onRemove={(bookmark) => void removeBookmark(bookmark)}
            onRename={(bookmark, title) => void renameBookmark(bookmark, title)}
          />
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {threadsLoading && <div className="loading">收藏加载中…</div>}
          {!threadsLoading && threads.length === 0 && <div className="empty">还没有收藏的串</div>}
          {!threadsLoading &&
            threads.map((thread) => (
              <MobileThreadCard
                key={thread.threadId}
                thread={thread}
                bookmarked
                onToggleBookmark={(id) => {
                  void toggleBookmark(id);
                  setThreads((list) => list.filter((item) => item.threadId !== id));
                }}
                onBoardClick={(board) => navigate(`/m/home?board=${encodeURIComponent(board)}`)}
                onTagClick={(tag) => navigate(`/m/home?keyword=${encodeURIComponent(tag.tagName)}`)}
              />
            ))}
        </div>
      )}
    </div>
  );
}
