import type { Tag, Thread } from '../api/types';
import { TagChip } from './TagChip';
import { fmtRelative } from './format';
import { Link } from 'react-router-dom';

interface Props {
  thread: Thread;
  bookmarked: boolean;
  onToggleBookmark: (threadId: number) => void;
  onBlock: (threadId: number) => void;
  /** 屏蔽这个串的楼主饼干 */
  onBlockCookie: (cookie: string) => void;
  onTagClick: (tag: Tag) => void;
  /** 点板块 → 筛选；再点一次取消 */
  onBoardClick?: (board: string) => void;
  /** 当前生效的板块筛选值 */
  activeBoard?: string | null;
  /** 后台提交该串的更新任务（不跳转页面） */
  onUpdate?: (threadId: number) => void;
  /** 跳到管理页并定位到该串（有 thread.edit 权限时才传） */
  onManage?: (threadId: number) => void;
  /** 该串的更新任务正在提交 */
  updating?: boolean;
}

export function ThreadRow({
  thread,
  bookmarked,
  onToggleBookmark,
  onBlock,
  onBlockCookie,
  onTagClick,
  onBoardClick,
  activeBoard,
  onUpdate,
  onManage,
  updating,
}: Props) {
  const boardActive = Boolean(thread.board) && activeBoard === thread.board;
  const installment = thread.tags.find((t) => t.tagType === 'installment')?.tagName;
  return (
    <div className="thread-row" data-flip-id={thread.threadId} data-anchor="">
      <div className="thread-title-line">
        <Link className="thread-title" to={`/t/${thread.threadId}`}>
          {thread.title}
        </Link>
        <span className="thread-no">No.{thread.threadId}</span>
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
      </div>
      <p className="thread-excerpt">{thread.excerpt}</p>
      <div className="thread-meta">
        <span className="mono">ID:{thread.cookie}</span>
        <span>· {thread.replies} 回复</span>
        <span>· {thread.pageCount} 页</span>
        <span>· {thread.imageCount} 图</span>
        <span>· 更新于 {fmtRelative(thread.updatedAt)}</span>
        {thread.tags.map((tag) => (
          <TagChip key={`${tag.tagType}-${tag.tagName}`} tag={tag} onClick={onTagClick} />
        ))}
      </div>
      <div className="thread-actions">
        <Link className="btn btn-sm" to={`/t/${thread.threadId}`}>
          阅读
        </Link>
        <button className="btn btn-sm" onClick={() => onToggleBookmark(thread.threadId)}>
          {bookmarked ? '取消收藏' : '收藏'}
        </button>
        {onUpdate && (
          <button
            className="btn btn-sm"
            disabled={updating}
            title="后台提交该串的下载任务（只补最后一页及之后）"
            onClick={() => onUpdate(thread.threadId)}
          >
            {updating ? '提交中…' : '更新'}
          </button>
        )}
        {onManage && (
          <button
            className="btn btn-sm"
            title="到管理页修改这个串的信息与标签"
            onClick={() => onManage(thread.threadId)}
          >
            管理
          </button>
        )}
        <button className="btn btn-sm btn-ghost" onClick={() => onBlock(thread.threadId)}>
          屏蔽此串
        </button>
        <button
          className="btn btn-sm btn-ghost"
          title={`屏蔽这个串的楼主饼干 ID:${thread.cookie}`}
          onClick={() => onBlockCookie(thread.cookie)}
        >
          屏蔽Po饼干
        </button>
      </div>
    </div>
  );
}
