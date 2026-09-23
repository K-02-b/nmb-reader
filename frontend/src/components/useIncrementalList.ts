import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

/** 每次加载的条数 */
const PAGE_SIZE = 10;
/** 距底部多少像素算「快到底了」 */
const NEAR_BOTTOM = 120;

export interface IncrementalList<T> {
  items: T[];
  loading: boolean;
  /** 已经到底就没有更多了 */
  hasMore: boolean;
  /** 挂到滚动容器上 */
  boxRef: MutableRefObject<HTMLDivElement | null>;
  onScroll: () => void;
  reload: () => void;
}

/**
 * 「先取一页，滚到底自动再取一页」的列表：下载任务和系统日志共用。
 *
 * 筛选条件变了（resetKey）就回到第一页；pollMs 给了就定时刷新当前窗口。
 */
export function useIncrementalList<T>({
  fetchPage,
  resetKey,
  pollMs = 0,
}: {
  /** 按条数取一页；筛选条件由调用方闭包带上 */
  fetchPage: (limit: number) => Promise<T[]>;
  /** 变化即重置（把筛选条件拼成字符串） */
  resetKey: string;
  pollMs?: number;
}): IncrementalList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // fetchPage 每次渲染都是新函数（闭包里带着筛选条件），用 ref 拿最新的
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const limitRef = useRef(limit);
  limitRef.current = limit;

  const load = useCallback(async (count: number) => {
    setLoading(true);
    try {
      setItems(await fetchRef.current(count));
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = useCallback(() => void load(limitRef.current), [load]);

  // 筛选变化：回到第一页
  useEffect(() => {
    setLimit(PAGE_SIZE);
    void load(PAGE_SIZE);
  }, [load, resetKey]);

  // 滚动加载更多：按新的条数重新取（后端按 limit 截断，简单可靠）
  useEffect(() => {
    if (limit !== PAGE_SIZE) void load(limit);
  }, [limit, load]);

  useEffect(() => {
    if (!pollMs) return;
    const timer = window.setInterval(() => void load(limitRef.current), pollMs);
    return () => window.clearInterval(timer);
  }, [load, pollMs]);

  const onScroll = useCallback(() => {
    const box = boxRef.current;
    if (!box || loading || items.length < limit) return;
    if (box.scrollHeight - box.scrollTop - box.clientHeight > NEAR_BOTTOM) return;
    setLimit((prev) => prev + PAGE_SIZE);
  }, [items.length, limit, loading]);

  return { items, loading, hasMore: items.length >= limit, boxRef, onScroll, reload };
}
