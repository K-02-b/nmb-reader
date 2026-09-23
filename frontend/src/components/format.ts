/** 时间与文本展示工具。时间戳是 Unix 秒，这里统一换算成毫秒。 */

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 秒 → 毫秒 */
const toMs = (ts: number) => ts * 1000;

export function fmtRelative(ts: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const diff = nowSec - ts;
  if (diff < MIN) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  return fmtDate(ts);
}

export function fmtDate(ts: number): string {
  const d = new Date(toMs(ts));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 岛上风格的时间戳：2026-06-01(一)18:07:05 */
export function fmtIslandTime(ts: number): string {
  const d = new Date(toMs(ts));
  const pad = (n: number) => String(n).padStart(2, '0');
  const week = '日一二三四五六'[d.getDay()];
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}(${week})${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

export function shortCookie(cookie: string): string {
  return cookie.length > 8 ? `${cookie.slice(0, 8)}…` : cookie;
}

export function groupText(group: string): string {
  return { admin: '管理员', editor: '编辑', user: '普通用户' }[group] ?? group;
}

/** 串号输入容错：允许「No.59775198」「59775198 」这类写法，解析不出返回 null */
export function parseThreadId(value: string): number | null {
  const cleaned = value
    .trim()
    .replace(/^no\.?/i, '')
    .trim();
  return /^\d+$/.test(cleaned) ? Number(cleaned) : null;
}
