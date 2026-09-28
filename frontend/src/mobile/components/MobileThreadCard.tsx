import { Link } from 'react-router-dom';
import type { Tag, Thread } from '../../api/types';
import { IconBookmark, IconMore } from '../../components/icons';
import { TagChip } from '../../components/TagChip';
import { fmtRelative } from '../../components/format';

interface Props {
  thread: Thread;
  bookmarked: boolean;
  onToggleBookmark: (threadId: number) => void;
  /** 打开「更多操作」抽屉（更新 / 管理 / 屏蔽 / 屏蔽饼干） */
  onMore?: (thread: Thread) => void;
  onBoardClick?: (board: string) => void;
  activeBoard?: string | null;
  onTagClick: (tag: Tag) => void;
}

/**
 * 手机端目录条目：卡片式一条，整块标题区可点进阅读页，次要操作收进右侧两个图标。
 *
 * 桌面端的 ThreadRow 把六个按钮平铺一行，窄屏会挤成两行还容易误触，所以这里只做一套。
 */
export function MobileThreadCard({
  thread,
  bookmarked,
  onToggleBookmark,
  onMore,
  onBoardClick,
  activeBoard,
  onTagClick,
}: Props) {
  const boardActive = Boolean(thread.board) && activeBoard === thread.board;
  const installment = thread.tags.find((tag) => tag.tagType === 'installment')?.tagName;
  // 卷次在标签行里已经单列，正文标签不再重复
  const tags = thread.tags.filter((tag) => tag.tagType !== 'installment');

  return (
    <div className="m-thread" data-anchor="" data-flip-id={thread.threadId}>
      <div className="m-thread-col">
        <Link className="m-thread-main" to={`/m/t/${thread.threadId}`}>
          <span className="m-thread-head">
            <span className="m-thread-title">{thread.title}</span>
            <span className="m-thread-no">No.{thread.threadId}</span>
          </span>
          {thread.excerpt && <p className="m-thread-excerpt">{thread.excerpt}</p>}
          <span className="m-item-meta">
            <span className="mono">ID:{thread.cookie}</span>
            <span>{thread.replies} 回复</span>
            <span>{thread.pageCount} 页</span>
            <span>{thread.imageCount} 图</span>
            <span>{fmtRelative(thread.updatedAt)}</span>
          </span>
        </Link>
        <div className="m-thread-badges">
          {thread.board && (
            <button
              className={`badge badge-board ${boardActive ? 'active' : ''}`}
              onClick={() => onBoardClick?.(thread.board as string)}
              title={boardActive ? `取消「${thread.board}」板块筛选` : `只看「${thread.board}」板块`}
            >
              {thread.board}
              {boardActive && ' ×'}
            </button>
          )}
          {installment && <span className="badge">第 {installment} 部</span>}
          {bookmarked && <span className="badge badge-accent">已收藏</span>}
          {tags.map((tag) => (
            <TagChip key={`${tag.tagType}-${tag.tagName}`} tag={tag} onClick={onTagClick} />
          ))}
        </div>
      </div>

      <div className="m-thread-side">
        <button
          className={`m-icon-btn ${bookmarked ? 'active' : ''}`}
          aria-label={bookmarked ? '取消收藏' : '收藏'}
          title={bookmarked ? '取消收藏' : '收藏'}
          onClick={() => onToggleBookmark(thread.threadId)}
        >
          <IconBookmark />
        </button>
        {onMore && (
          <button className="m-icon-btn" aria-label="更多操作" title="更多操作" onClick={() => onMore(thread)}>
            <IconMore />
          </button>
        )}
      </div>
    </div>
  );
}
