import { useCallback, useEffect, useState } from 'react';
import { useLayout } from '../state/LayoutContext';
import { keepViewportAnchor, pinAnchor } from './viewport';

/**
 * 右侧工具栏的开合状态。展开/收起时正文宽度会变，所以顺手把屏幕上的锚点钉回原位。
 *
 * 页面只关心「哪个面板开着」，让位与动画交给 ToolsDock 和 Layout。
 */
export function useDock<T extends string>() {
  const [active, setActive] = useState<T | null>(null);
  const { setDockOpen } = useLayout();

  const toggle = useCallback(
    (key: T) => {
      const next = active === key ? null : key;
      const restore = keepViewportAnchor();
      setActive(next);
      setDockOpen(next !== null);
      pinAnchor(restore);
    },
    [active, setDockOpen],
  );

  const close = useCallback(() => {
    const restore = keepViewportAnchor();
    setActive(null);
    setDockOpen(false);
    pinAnchor(restore);
  }, [setDockOpen]);

  // 离开页面时把让位收回去
  useEffect(() => () => setDockOpen(false), [setDockOpen]);

  return { active, toggle, close };
}
