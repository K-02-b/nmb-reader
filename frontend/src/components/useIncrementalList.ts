import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';

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

type Options<T> =
  /** 自己按条数取（日志：一次拉一页） */
  | { fetchPage: (limit: number) => Promise<T[]>; source?: undefined; resetKey: string }
  /** 外部已经拿到的完整数组，这里只负责按滚动分页切片（下载任务：由 SSE 推送维护） */
  | { source: T[]; fetchPage?: undefined; resetKey: string };

/**
 * 「先取一页，滚到底自动再取一页」的列表：下载任务和系统日志共用。
 *
 * 数据来源二选一：`fetchPage` 自己取，或 `source` 直接切外部数组。
 * 筛选条件变了（resetKey）就回到第一页。
 */
export function useIncrementalList<T>({ fetchPage, source, resetKey }: Options<T>): IncrementalList<T> {
  const [fetched, setFetched] = useState<T[]>([]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // fetchPage 每次渲染都是新函数（闭包里带着筛选条件），用 ref 拿最新的
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const limitRef = useRef(limit);
  limitRef.current = limit;

  const load = useCallback(async (count: number) => {
    if (!fetchRef.current) return;
    setLoading(true);
    try {
      setFetched(await fetchRef.current(count));
    } finally {
      setLoading(false);
    }
  }, []);

  const items = useMemo(() => (source ? source.slice(0, limit) : fetched), [fetched, limit, source]);
  const hasMore = source ? source.length > limit : items.length >= limit;

  const reload = useCallback(() => {
    // 外部数组是实时的，没什么可重取，回到第一页就够
    if (fetchRef.current) void load(limitRef.current);
    else setLimit(PAGE_SIZE);
  }, [load]);

  // 筛选变化：回到第一页
  useEffect(() => {
    setLimit(PAGE_SIZE);
    void load(PAGE_SIZE);
  }, [load, resetKey]);

  // 滚动加载更多：按新的条数重新取（后端按 limit 截断，简单可靠）；切片的模式由 items 自己算
  useEffect(() => {
    if (!fetchRef.current) return;
    if (limit !== PAGE_SIZE) void load(limit);
  }, [limit, load]);

  const onScroll = useCallback(() => {
    const box = boxRef.current;
    if (!box || loading || !hasMore) return;
    if (box.scrollHeight - box.scrollTop - box.clientHeight > NEAR_BOTTOM) return;
    setLimit((prev) => prev + PAGE_SIZE);
  }, [hasMore, loading]);

  return { items, loading, hasMore, boxRef, onScroll, reload };
}
