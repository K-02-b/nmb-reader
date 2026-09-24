import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import type { Post } from '../api/types';
import { renderPostBody } from './render';
import { fmtIslandTime } from './format';

interface Props {
  /** 点开的第一个引用楼层 */
  rootPostId: number;
  /** 当前正在看的串；全文检索里点引用时目标可能在任何串，传 null 表示未知 */
  threadId: number | null;
  /** 点「跳到该楼」时调用，带上这一楼真正所属的串 */
  onGoToPost: (postId: number, threadId: number) => void;
  onClose: () => void;
}

/**
 * 引用预览弹框：点 `>>No.xxx` 时在当前页面弹出，不跳转。
 * stack 记录引用链可逐级返回；只在点击时展开下一层，循环引用不会死循环。
 */
export function QuotePopup({ rootPostId, threadId, onGoToPost, onClose }: Props) {
  const [stack, setStack] = useState<number[]>([rootPostId]);
  const [cache, setCache] = useState<Record<number, Post | null>>({});
  const [loading, setLoading] = useState(false);

  const currentId = stack[stack.length - 1];

  const load = useCallback(
    async (postId: number) => {
      if (cache[postId] !== undefined) return;
      setLoading(true);
      try {
        const post = await api.quotePost(postId);
        setCache((prev) => ({ ...prev, [postId]: post }));
      } catch {
        // 404 视为这一楼不在库里
        setCache((prev) => ({ ...prev, [postId]: null }));
      } finally {
        setLoading(false);
      }
    },
    [cache],
  );

  useEffect(() => {
    void load(currentId);
  }, [currentId, load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const post = cache[currentId];
  const missing = post === null;
  const referencedElsewhere = stack.slice(0, -1).includes(currentId);
  const otherThread = post && post.threadId !== threadId;

  const push = (postId: number) => {
    setStack((prev) => [...prev, postId]);
    void load(postId);
  };

  // 必须挂到 body：#root 的 filter 会给 position:fixed 创建包含块，否则弹框会跑到屏幕外
  return createPortal(
    <div className="quote-popup-backdrop" onClick={onClose} role="presentation">
      <div className="quote-popup" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="引用预览">
        <div className="quote-popup-head">
          <span className="badge badge-accent">引用预览</span>
          <span className="mono">No.{currentId}</span>
          <span className="spacer" />
          {stack.length > 1 && (
            <button className="btn btn-sm" onClick={() => setStack((prev) => prev.slice(0, -1))}>
              返回上一级
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="quote-popup-body">
          {loading && !post && <div className="loading">加载中…</div>}

          {missing && (
            <div className="empty">
              <p className="error-text">找不到 No.{currentId} 这一楼</p>
              <p className="hint">可能原因：该串尚未下载 / 该楼已被删除 / 串号抄错。可以到管理页提交下载申请。</p>
            </div>
          )}

          {post && (
            <>
              <div className="post-head">
                <span className="post-name">{post.name || '无名氏'}</span>
                <span>{fmtIslandTime(post.createdAt)}</span>
                <span className="post-cookie">ID:{post.cookie}</span>
                {post.isPo && <span className="badge badge-accent">PO</span>}
                {post.isSage && <span className="badge">SAGE</span>}
                <span className="post-no">No.{post.id}</span>
                {otherThread && <span className="badge">来自 No.{post.threadId}</span>}
                {referencedElsewhere && <span className="badge">链路中已出现（循环引用）</span>}
              </div>
              <div className="post-body">{renderPostBody(post.content, { onJump: push })}</div>
              {post.img && (
                <figure className="post-image">
                  <a href={post.imgSource ?? post.img} target="_blank" rel="noreferrer">
                    <img src={post.img} alt={`No.${post.id} 的附图`} loading="lazy" />
                  </a>
                  <figcaption>
                    {post.imgSource ? (
                      <a href={post.imgSource} target="_blank" rel="noreferrer">
                        查看原图 ↗
                      </a>
                    ) : (
                      <span className="faint">本地图片</span>
                    )}
                  </figcaption>
                </figure>
              )}
            </>
          )}
        </div>

        <div className="quote-popup-foot">
          <span className="spacer" />
          <button
            className="btn btn-sm"
            disabled={!post}
            onClick={() => {
              if (post) onGoToPost(currentId, post.threadId);
            }}
          >
            跳到该楼
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
