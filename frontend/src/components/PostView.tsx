import { useState, type HTMLAttributes, type ReactNode } from 'react';
import type { Post } from '../api/types';
import { renderPostBody } from './render';
import { fmtIslandTime } from './format';

interface Props extends HTMLAttributes<HTMLElement> {
  post: Post;
  /** 把命中的关键词包成 <mark> */
  highlight?: string;
  /** 点 >>No.xxx：交给调用方弹引用框 */
  onQuote?: (postId: number) => void;
  /** 楼层下方的操作区，主串、速览、检索结果各传各的 */
  actions?: ReactNode;
  /** 检索结果用：正文只显示开头一段，不显示图片 */
  compact?: boolean;
}

/**
 * 一层楼的显示单元：正文换行与引用点击只在这里处理一次。
 *
 * 阅读页、速览面板、全文检索结果都用它，省得几处各写一份、有的能点引用有的不能。
 */
export function PostView({ post, highlight, onQuote, actions, compact, className, ...rest }: Props) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = Boolean(post.img) && !imgFailed;

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

      <div className="post-body">
        {renderPostBody(compact ? post.content.slice(0, 200) : post.content, { highlight, onJump: onQuote })}
      </div>

      {!compact && post.img && (
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
