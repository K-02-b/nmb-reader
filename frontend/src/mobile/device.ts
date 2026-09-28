/**
 * 手机端入口判定。
 *
 * 路由（`/m/...`）才是手机端唯一的事实来源——这里只解决「第一次打开站点时往哪边导」，
 * 以及「手动切换后记住选择」。用户手动选过之后就不再按 UA 猜，否则在手机浏览器上
 * 想用电脑版会被反复弹回手机端。
 */

const MODE_KEY = 'xdnmb.uiMode';

export type UiMode = 'mobile' | 'desktop';

export function readUiMode(): UiMode | null {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    return raw === 'mobile' || raw === 'desktop' ? raw : null;
  } catch {
    return null;
  }
}

export function writeUiMode(mode: UiMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* 存储不可用时不影响本次跳转 */
  }
}

/** 手机/平板：UA 命中，或触摸为主且窗口很窄（电脑浏览器拖窄了也算） */
export function isMobileDevice(userAgent: string = navigator.userAgent, width: number = window.innerWidth): boolean {
  if (/Android|iPhone|iPod|Windows Phone|HarmonyOS|Mobile/i.test(userAgent)) return true;
  // iPadOS 13+ 的 Safari 默认伪装成 macOS，只能靠触摸点数区分
  if (/Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1) return true;
  return width <= 820;
}

/** 首次进入时走哪套 UI：手动选择优先，其次按设备猜 */
export function preferMobile(): boolean {
  const mode = readUiMode();
  return mode ? mode === 'mobile' : isMobileDevice();
}

/** 路径拼接：把 query 原样带过去，切换 UI 时筛选条件不丢 */
function join(path: string, search: string): string {
  return search ? `${path}${search.startsWith('?') ? search : `?${search}`}` : path;
}

/** 拆成 pathname 与 search，供两套 UI 互相翻译路径 */
function split(to: string): [string, string] {
  const at = to.indexOf('?');
  return at < 0 ? [to, ''] : [to.slice(0, at), to.slice(at)];
}

const DESKTOP_EQUIVALENT: Record<string, string> = {
  '/m/home': '/home',
  '/m/search': '/home',
  '/m/bookmarks': '/home',
  '/m/settings': '/settings',
  '/m/admin': '/admin',
  '/m/login': '/login',
};

const MOBILE_EQUIVALENT: Record<string, string> = {
  '/home': '/m/home',
  '/settings': '/m/settings',
  '/admin': '/m/admin',
  '/login': '/m/login',
};

/** 手机端路径 → 电脑端路径（找不到对应页就回目录） */
export function toDesktopPath(to: string): string {
  const [path, search] = split(to);
  if (path.startsWith('/m/t/')) return join(path.slice(2), search);
  return join(DESKTOP_EQUIVALENT[path] ?? '/home', search);
}

/** 电脑端路径 → 手机端路径（找不到对应页就回手机端目录） */
export function toMobilePath(to: string): string {
  const [path, search] = split(to);
  if (path.startsWith('/t/')) return join(`/m${path}`, search);
  return join(MOBILE_EQUIVALENT[path] ?? '/m/home', search);
}
