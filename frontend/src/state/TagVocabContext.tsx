import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { Tag, TagType, TagVocabulary } from '../api/types';
import { useApp } from './AppContext';

/** 全局标签词汇表：标签跨串共享，统一放一份，避免各组件各自拉取。 */

const EMPTY: TagVocabulary = { genre: [], series: [], status: [], installment: [], tags: [] };

/** 标签类型 → 词汇表里的字段 */
const TYPE_FIELD: Record<TagType, keyof TagVocabulary> = {
  genre: 'genre',
  series: 'series',
  status: 'status',
  installment: 'installment',
  CUSTOM_TAG: 'tags',
};

/** 候选：带类型，便于显示类型徽章 */
export interface TagCandidate {
  type: TagType;
  name: string;
}

interface TagVocabState {
  vocab: TagVocabulary;
  loading: boolean;
  refresh: () => Promise<void>;
  /** 本地即时并入刚输入的标签 */
  registerLocal: (tag: Pick<Tag, 'tagType' | 'tagName'>) => void;
  /** 全部类型的候选 */
  candidates: TagCandidate[];
}

const TagVocabContext = createContext<TagVocabState | null>(null);

export function TagVocabProvider({ children }: { children: ReactNode }) {
  const { session } = useApp();
  const [vocab, setVocab] = useState<TagVocabulary>(EMPTY);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setVocab(await api.fetchTagVocabulary());
    } catch {
      // 拉不到就保持原样，标签仍可自由输入
    } finally {
      setLoading(false);
    }
  }, []);

  // 登录后拉一次；注销后清空
  useEffect(() => {
    if (session) void refresh();
    else setVocab(EMPTY);
  }, [session, refresh]);

  const registerLocal = useCallback((tag: Pick<Tag, 'tagType' | 'tagName'>) => {
    const field = TYPE_FIELD[tag.tagType];
    const name = tag.tagName.trim();
    if (!field || !name) return;
    setVocab((prev) => (prev[field].includes(name) ? prev : { ...prev, [field]: [...prev[field], name] }));
  }, []);

  const candidates = useMemo<TagCandidate[]>(() => {
    const list: TagCandidate[] = [];
    (Object.keys(TYPE_FIELD) as TagType[]).forEach((type) => {
      vocab[TYPE_FIELD[type]].forEach((name) => list.push({ type, name }));
    });
    return list;
  }, [vocab]);

  const value = useMemo<TagVocabState>(
    () => ({ vocab, loading, refresh, registerLocal, candidates }),
    [vocab, loading, refresh, registerLocal, candidates],
  );

  return <TagVocabContext.Provider value={value}>{children}</TagVocabContext.Provider>;
}

// Provider 与 hook 同文件，关掉 fast-refresh 提示
// eslint-disable-next-line react-refresh/only-export-components
export function useTagVocab(): TagVocabState {
  const ctx = useContext(TagVocabContext);
  if (!ctx) throw new Error('useTagVocab 必须在 TagVocabProvider 内使用');
  return ctx;
}
