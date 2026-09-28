import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 底部固定操作区（例如「保存」） */
  footer?: ReactNode;
  /**
   * 内容自己管滚动：面板型内容（FilterPanel / HitListPanel / BookmarkPanel）要撑满、
   * 由它们内部的 `.tools-body` 滚动，这里就不能再加内边距和 overflow。
   */
  bare?: boolean;
}

/**
 * 底部抽屉：手机端替代桌面右侧工具栏的容器。
 *
 * 必须挂到 body：#root 上的 filter 会给 position:fixed 创建包含块，挂在里面抽屉会跟着长页面跑。
 */
export function MobileSheet({ title, onClose, children, footer, bare }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 抽屉打开时锁住背景滚动，否则在手机上滑抽屉会连带把正文滚走
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return createPortal(
    <div className="m-sheet-backdrop" onClick={onClose} role="presentation">
      <div className="m-sheet" role="dialog" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="m-sheet-head">
          <span className="m-sheet-grip" aria-hidden />
          <h3>{title}</h3>
          <span className="spacer" />
          <button className="btn btn-sm btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className={`m-sheet-body ${bare ? 'm-sheet-body-bare' : ''}`}>{children}</div>
        {footer && <div className="m-sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
