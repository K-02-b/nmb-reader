/**
 * 视口锚点：布局变化（例如右侧工具栏展开让正文变窄）时，把屏幕上正在看的那一条按在原来的位置，
 * 免得内容随着重排上下乱窜。
 */

/** 吸顶导航底边：锚点取它下面第一条可见内容 */
export function headerBottom(): number {
  return document.querySelector('.app-header')?.getBoundingClientRect().bottom ?? 0;
}

/** 视口顶部附近的第一条内容；[data-anchor] 由楼层、目录行这类「一条」自己打 */
export function anchorElement(selector = '[data-anchor]'): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    if (el.getBoundingClientRect().bottom > headerBottom() + 4) return el;
  }
  return null;
}

/** 记下当前锚点的屏幕位置，返回一个可反复调用的「钉回原位」函数 */
export function keepViewportAnchor(): () => void {
  const el = anchorElement();
  if (!el) return () => undefined;
  const top = el.getBoundingClientRect().top;
  return () => {
    const delta = el.getBoundingClientRect().top - top;
    if (Math.abs(delta) > 1) window.scrollBy({ top: delta });
  };
}

/**
 * 布局还在过渡时连着校准几次（CSS 过渡里的重排不是一次到位）。
 * 用户自己滚动就停手。
 */
export function pinAnchor(restore: () => void): void {
  let cancelled = false;
  const stop = () => {
    cancelled = true;
    for (const type of ['wheel', 'touchstart', 'keydown']) window.removeEventListener(type, stop);
  };
  for (const type of ['wheel', 'touchstart', 'keydown'])
    window.addEventListener(type, stop, { once: true, passive: true });
  for (const delay of [0, 60, 160, 280]) {
    window.setTimeout(() => {
      if (!cancelled) restore();
    }, delay);
  }
}
