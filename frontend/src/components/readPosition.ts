import { anchorElement, headerBottom } from './viewport';

/**
 * 「读到哪一楼」的记忆：按用户名 + 串号存在浏览器本地。
 *
 * 只记楼号不记滚动像素：楼层高度会随图片加载、屏蔽变化，楼号重新定位更稳。
 */
export interface ReadPosition {
  page: number;
  postId: number;
}

function storageKey(username: string | undefined, threadId: number): string {
  return `xdnmb.readPos.${username ?? 'anonymous'}.${threadId}`;
}

export function loadReadPosition(username: string | undefined, threadId: number): ReadPosition | null {
  try {
    const raw = localStorage.getItem(storageKey(username, threadId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ReadPosition>;
    if (typeof value.page !== 'number' || typeof value.postId !== 'number') return null;
    return { page: value.page, postId: value.postId };
  } catch {
    return null;
  }
}

export function saveReadPosition(username: string | undefined, threadId: number, position: ReadPosition): void {
  try {
    localStorage.setItem(storageKey(username, threadId), JSON.stringify(position));
  } catch {
    /* 存储不可用时忽略 */
  }
}

/** 视口顶部那一楼：底部还在导航栏之下的第一个楼层 */
export function topPostId(): number | null {
  const el = anchorElement('article.post[id^="p"]');
  return el ? Number(el.id.slice(1)) : null;
}

/** 只有最后一次跳转允许做后续校准：连续点书签时，上一次的校准会和新动画打架，看起来就是抖动 */
let activeJump = 0;
/** 当前这次平滑滚动，同一时刻只保留一个 */
let tweenFrame = 0;

/** 等一帧 */
const nextFrame = () => new Promise<number>((resolve) => window.requestAnimationFrame(resolve));

/** 自己补间：新的一次跳转会接管（而不是重启一条新的缓动曲线），连点也不会一顿一顿 */
function tweenScroll(targetY: number): Promise<void> {
  window.cancelAnimationFrame(tweenFrame);
  const startY = window.scrollY;
  const distance = targetY - startY;
  if (Math.abs(distance) < 2) {
    window.scrollTo({ top: targetY });
    return Promise.resolve();
  }
  const duration = Math.min(480, 200 + Math.abs(distance) / 8);
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const step = () => {
      const progress = Math.min(1, (performance.now() - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      window.scrollTo({ top: startY + distance * eased });
      if (progress < 1) tweenFrame = window.requestAnimationFrame(step);
      else resolve();
    };
    tweenFrame = window.requestAnimationFrame(step);
  });
}

/**
 * 滚到某一楼。图片撑开布局后会再校准几次，用户一动就收手，校准结束才 resolve。
 *
 * smooth 用于「跳到该楼 / 返回原处」这类用户主动触发的跳转（自己补间，方便被下一次跳转接管）；
 * 打开串恢复位置用默认的瞬时跳转。
 */
export async function scrollToPost(postId: number, smooth = false): Promise<void> {
  const jump = ++activeJump;
  const el = postId ? document.getElementById(`p${postId}`) : null;
  if (!el) {
    window.scrollTo({ top: 0 });
    return;
  }
  const offset = () => el.getBoundingClientRect().top - headerBottom() - 8;

  let cancelled = false;
  const stop = () => {
    cancelled = true;
    window.cancelAnimationFrame(tweenFrame);
    for (const type of ['wheel', 'touchstart', 'keydown']) window.removeEventListener(type, stop);
  };
  for (const type of ['wheel', 'touchstart', 'keydown'])
    window.addEventListener(type, stop, { once: true, passive: true });

  if (smooth) await tweenScroll(window.scrollY + offset());
  else window.scrollTo({ top: window.scrollY + offset() });

  // 布局稳定前再校准几次；被新的跳转接管、或用户自己滚了，就不再动滚动位置
  for (const delay of [0, 300, 800, 1500]) {
    if (delay) {
      const until = performance.now() + delay;
      while (performance.now() < until) await nextFrame();
    }
    if (cancelled || jump !== activeJump) return;
    const delta = offset();
    // 阈值 4px：动画收尾的亚像素差、布局 1~2px 的抖动不值得再滚一次
    if (Math.abs(delta) >= 4) window.scrollTo({ top: window.scrollY + delta });
  }
}
