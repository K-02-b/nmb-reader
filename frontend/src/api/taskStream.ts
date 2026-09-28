import { API_BASE, taskStreamUrl, type TaskQuery } from './client';
import type { DownloadTask } from './types';

/** connecting = 正在连（含自动重连）；live = 已经连上并收到过推送；offline = 判定连接已死 */
export type TaskStreamState = 'connecting' | 'live' | 'offline';

/**
 * 多久没收到任何数据就认为连接死了。服务端空闲时最多 KEEPALIVE_TICKS × TICK_IDLE = 45 秒
 * 会来一个 ping，所以 2 分钟没动静一定是出问题了。
 */
const STALL_MS = 120_000;
/** 看门狗检查间隔 */
const WATCHDOG_MS = 15_000;

export interface TaskStreamHandlers {
  /** 连上或重连后的全量快照：直接替换本地列表 */
  onSnapshot: (tasks: DownloadTask[]) => void;
  /** 新增或字段有变化的任务（进度、状态、排队位置都算）：按 taskId 合并 */
  onPatch: (tasks: DownloadTask[]) => void;
  /** 已经离开推送窗口的任务 id */
  onRemove: (taskIds: string[]) => void;
  onState?: (state: TaskStreamState) => void;
}

/**
 * 订阅 `/api/downloads/stream`，替代「定时 fetch 任务列表」。
 *
 * 服务端只在任务真有变化时推数据（空闲时每 45 秒一个 `ping`），断线由浏览器按服务端给的
 * `retry` 自动重连，重连后第一条又是全量快照，所以本地状态不会错位。
 *
 * 另外挂了看门狗：半开的连接（反代吊着不放、NAT 超时把包丢了）既不会触发 error、也永远
 * 不会有数据，光靠 error 事件会一直显示「实时」却不再更新 —— 超过 STALL_MS 没收到任何
 * 东西就主动断开重连，期间让上层走兜底刷新。
 *
 * 返回一个取消订阅的函数。
 */
export function openTaskStream(params: TaskQuery, handlers: TaskStreamHandlers): () => void {
  const url = taskStreamUrl(params);
  // 跨域部署（VITE_API_BASE 指向别的源）时 Cookie 要显式带上
  const withCredentials = Boolean(API_BASE);
  let source: EventSource | null = null;
  let disposed = false;
  let lastSeen = Date.now();

  const parse = (raw: string): unknown => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  };

  const start = () => {
    const current = new EventSource(url, { withCredentials });
    source = current;
    const seen = () => {
      lastSeen = Date.now();
    };
    current.addEventListener('tasks', (event) => {
      seen();
      const data = parse((event as MessageEvent<string>).data);
      if (Array.isArray(data)) handlers.onSnapshot(data as DownloadTask[]);
    });
    current.addEventListener('patch', (event) => {
      seen();
      const data = parse((event as MessageEvent<string>).data);
      if (Array.isArray(data)) handlers.onPatch(data as DownloadTask[]);
    });
    current.addEventListener('remove', (event) => {
      seen();
      const data = parse((event as MessageEvent<string>).data);
      if (Array.isArray(data)) handlers.onRemove(data as string[]);
    });
    current.addEventListener('ping', seen);
    current.addEventListener('open', () => {
      seen();
      handlers.onState?.('live');
    });
    current.addEventListener('error', () => {
      seen();
      // CONNECTING 说明浏览器还会自己重连，CLOSED 就是彻底连不上了
      handlers.onState?.(current.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
    });
  };

  start();

  const watchdog = window.setInterval(() => {
    if (disposed || Date.now() - lastSeen <= STALL_MS) return;
    handlers.onState?.('offline');
    source?.close();
    lastSeen = Date.now(); // 给新连接一个宽限期，别再立刻判死
    start();
  }, WATCHDOG_MS);

  return () => {
    disposed = true;
    window.clearInterval(watchdog);
    source?.close();
  };
}

/** 把增量结果并进本地列表：改的替换，新任务插到最前，整体仍按提交时间倒序 */
export function mergeTasks(current: DownloadTask[], changed: DownloadTask[]): DownloadTask[] {
  if (changed.length === 0) return current;
  const byId = new Map(current.map((task) => [task.taskId, task]));
  const fresh: DownloadTask[] = [];
  for (const task of changed) {
    if (!byId.has(task.taskId)) fresh.push(task);
    byId.set(task.taskId, task);
  }
  return [...fresh, ...current.map((task) => byId.get(task.taskId) as DownloadTask)].sort(
    (a, b) => b.submittedAt - a.submittedAt,
  );
}
