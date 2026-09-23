import type { Post } from '../api/types';
import { PostView } from './PostView';

interface Props {
  post: Post;
  highlight?: string;
  /** 点 >>No.xxx（默认弹引用框） */
  onQuote?: (postId: number) => void;
  onBlockCookie?: (cookie: string) => void;
  onBlockThread?: (threadId: number) => void;
  /** 这一楼是否已加入书签 */
  bookmarked?: boolean;
  onToggleBookmark?: (postId: number) => void;
}

/** 阅读页的楼层：PostView + 阅读页自己的操作 */
export function PostCard({
  post,
  highlight,
  onQuote,
  onBlockCookie,
  onBlockThread,
  bookmarked,
  onToggleBookmark,
}: Props) {
  const copyNo = () => {
    void navigator.clipboard?.writeText(String(post.id)).catch(() => undefined);
  };

  return (
    <PostView
      post={post}
      id={`p${post.id}`}
      data-anchor=""
      highlight={highlight}
      onQuote={onQuote}
      actions={
        <>
          <button className="link-btn" onClick={copyNo}>
            复制串号
          </button>
          {onToggleBookmark && (
            <button className="link-btn" onClick={() => onToggleBookmark(post.id)}>
              {bookmarked ? '移除书签' : '添加书签'}
            </button>
          )}
          {onBlockCookie && (
            <button className="link-btn" onClick={() => onBlockCookie(post.cookie)}>
              屏蔽该饼干
            </button>
          )}
          {onBlockThread && (
            <button className="link-btn" onClick={() => onBlockThread(post.threadId)}>
              屏蔽该串
            </button>
          )}
        </>
      }
    />
  );
}
