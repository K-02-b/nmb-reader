import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import type { Post } from '../api/types';
import { renderPostBody } from './render';
import { fmtIslandTime } from './format';

interface Props extends HTMLAttributes<HTMLElement> {
  post: Post;
  /** 把命中的关键词包成 <mark> */
  highlight?: string;
  /** 点引用（>>No.xxx / >>xxx）：交给调用方弹引用框 */
  onQuote?: (postId: number) => void;
  /** 楼层下方的操作区，主串、速览、检索结果各传各的 */
  actions?: ReactNode;
  /** 检索结果用：不渲染图片，列表能短一截 */
  hideImage?: boolean;
  /** 检索结果用：正文只占固定高度，超出部分折起来，给一个「展开 / 收起」 */
  collapse?: boolean;
}

/**
 * 一层楼的显示单元：正文换行与引用点击只在这里处理一次。
 *
 * 阅读页、速览面板、全文检索结果都用它，省得几处各写一份、有的能点引用有的不能。
 */
export function PostView({ post, highlight, onQuote, actions, hideImage, collapse, className, ...rest }: Props) {
  const [imgFailed, setImgFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const collapsed = Boolean(collapse) && !expanded;
  const showImage = Boolean(post.img) && !imgFailed;

  // 折叠时才量：展开状态下正文和容器一样高，量出来永远是「没超出」，按钮就没了
  useEffect(() => {
    const body = bodyRef.current;
    if (!collapsed || !body) return;
    setOverflowing(body.scrollHeight > body.clientHeight + 1);
  }, [collapsed, highlight, post.content]);

  return (
    <article className={className ?? 'post'} {...rest}>
      <div className="post-head">
        <span className="post-name">{post.name || '无名氏'}</span>
        <span>{fmtIslandTime(post.createdAt)}</span>
        <span className="post-cookie">ID:{post.cookie}</span>
        {post.isPo && <span className="badge badge-accent">PO</span>}
        {post.isSage && <span className="badge">SAGE</span>}
        {post.isAdmin && <span className="badge">管理</span>}
        <span className="post-no">No.{post.id}</span>
      </div>

      <div ref={bodyRef} className={`post-body${collapsed ? ' is-collapsed' : ''}`}>
        {renderPostBody(post.content, { highlight, onJump: onQuote })}
      </div>

      {collapse && (overflowing || expanded) && (
        <button className="link-btn post-toggle" onClick={() => setExpanded((value) => !value)}>
          {expanded ? '收起' : '展开'}
        </button>
      )}

      {!hideImage && post.img && (
        <figure className="post-image">
          {showImage ? (
            <a href={post.imgSource ?? post.img} target="_blank" rel="noreferrer">
              <img src={post.img} alt={`No.${post.id} 的附图`} loading="lazy" onError={() => setImgFailed(true)} />
            </a>
          ) : (
            <div className="post-image-fallback">
              <span>图片加载失败（{post.img}）</span>
              {post.imgSource && (
                <a href={post.imgSource} target="_blank" rel="noreferrer">
                  回源图床 ↗
                </a>
              )}
            </div>
          )}
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

      {actions && <div className="post-actions">{actions}</div>}
    </article>
  );
}
