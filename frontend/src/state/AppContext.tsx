import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { DEFAULT_SETTINGS, type Bookmark, type Session, type UserSettings } from '../api/types';

/** 设置本地缓存一份，刷新时先上屏再与后端对齐 */
const SETTINGS_KEY = 'xdnmb.settings';

export interface Notice {
  id: number;
  kind: 'info' | 'ok' | 'warn' | 'error';
  text: string;
}

/** 轮询后台任务的间隔 */
const TASK_POLL_MS = 6000;
/** 这些状态算「任务已结束」，用来决定什么时候弹 toast */
const TASK_DONE = ['indexed', 'written', 'images_done', 'failed', 'write_failed', 'index_failed', 'images_failed'];

interface AppState {
  session: Session | null;
  settings: UserSettings;
  bookmarks: Bookmark[];
  notices: Notice[];
  ready: boolean;
  /** 每有一个后台任务刚结束就 +1，目录页据此刷新并播位移动画 */
  taskPulse: number;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, inviteCode: string) => Promise<void>;
  logout: () => void;
  saveSettings: (patch: Partial<UserSettings>) => void;
  resetSettings: () => void;
  toggleBookmark: (threadId: number) => Promise<void>;
  blockCookie: (cookie: string) => void;
  unblockCookie: (cookie: string) => void;
  blockThread: (threadId: number) => void;
  unblockThread: (threadId: number) => void;
  isCookieBlocked: (cookie: string) => boolean;
  isThreadBlocked: (threadId: number) => boolean;
  notify: (text: string, kind?: Notice['kind']) => void;
  run: <T>(action: () => Promise<T>, successText?: string) => Promise<T | undefined>;
}

const AppContext = createContext<AppState | null>(null);

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...(JSON.parse(raw) as object) } as T) : fallback;
  } catch {
    return fallback;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [settings, setSettings] = useState<UserSettings>(() => loadJson(SETTINGS_KEY, DEFAULT_SETTINGS));
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [ready, setReady] = useState(false);

  const notify = useCallback((text: string, kind: Notice['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setNotices((prev) => [...prev, { id, kind, text }]);
    window.setTimeout(() => setNotices((prev) => prev.filter((n) => n.id !== id)), 3600);
  }, []);

  /** 统一的「调用接口 + 提示」包装，避免每个页面重复 try/catch */
  const run = useCallback(
    async <T,>(action: () => Promise<T>, successText?: string): Promise<T | undefined> => {
      try {
        const result = await action();
        if (successText) notify(successText, 'ok');
        return result;
      } catch (error) {
        notify(error instanceof Error ? error.message : '操作失败', 'error');
        return undefined;
      }
    },
    [notify],
  );

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.dataset.font = settings.fontFamily;
    root.style.setProperty('--accent', settings.accent);
    root.style.setProperty('--font-size-base', `${settings.fontSize}px`);
    root.style.setProperty('--line-height-base', String(settings.lineHeight));
    root.style.setProperty('--brightness', `${settings.brightness}%`);
  }, [settings]);

  /** 启动时向后端确认登录态，并拉取服务端设置 */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const current = await api.me();
        if (!alive) return;
        setSession(current);
        if (current) {
          const remote = await api.fetchSettings().catch(() => null);
          if (alive && remote) setSettings((prev) => ({ ...prev, ...remote }));
        }
      } catch {
        if (alive) setSession(null);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!session) {
      setBookmarks([]);
      setReady(true);
      return;
    }
    let alive = true;
    api
      .fetchBookmarks()
      .then((list) => alive && setBookmarks(list))
      .catch(() => undefined)
      .finally(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [session]);

  // 后台任务结束就弹 toast（在任何页面都能看到），并给目录页一个刷新信号
  const [taskPulse, setTaskPulse] = useState(0);
  useEffect(() => {
    if (!session) return;
    let seen: Set<string> | null = null;
    const timer = window.setInterval(async () => {
      const tasks = await api.fetchTasks({ limit: 20 }).catch(() => []);
      const done = tasks.filter((t) => TASK_DONE.includes(t.status));
      const ids = new Set(done.map((t) => t.taskId));
      // 首次只登记，避免把登录前就结束的任务全弹一遍
      if (seen === null) {
        seen = ids;
        return;
      }
      const fresh = done.filter((t) => !seen?.has(t.taskId));
      seen = ids;
      if (fresh.length === 0) return;
      for (const task of fresh) {
        const bad = task.status.endsWith('failed');
        const what = task.kind === 'images' ? '图片本地化' : '下载';
        const reason = bad && task.message ? `：${task.message.slice(0, 60)}` : '';
        notify(`No.${task.threadId} ${what}${bad ? '失败' : '完成'}${reason}`, bad ? 'error' : 'ok');
      }
      setTaskPulse((prev) => prev + 1);
    }, TASK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [notify, session]);

  const login = useCallback(
    async (username: string, password: string) => {
      const next = await api.login(username, password);
      setSession(next);
      notify(`欢迎回来，${next.username}`, 'ok');
    },
    [notify],
  );

  const register = useCallback(
    async (username: string, password: string, inviteCode: string) => {
      await api.register(username, password, inviteCode);
      notify('注册成功，请登录', 'ok');
    },
    [notify],
  );

  const logout = useCallback(() => {
    void api.logout().catch(() => undefined);
    setSession(null);
    notify('已注销');
  }, [notify]);

  const settingsTimer = useRef<number | null>(null);
  const pushSettings = useCallback(
    (next: UserSettings) => {
      if (settingsTimer.current) window.clearTimeout(settingsTimer.current);
      settingsTimer.current = window.setTimeout(() => {
        void api.saveSettings(next).catch(() => notify('设置同步失败（已保存在本地）', 'error'));
      }, 500);
    },
    [notify],
  );

  const saveSettings = useCallback(
    (patch: Partial<UserSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        if (session) pushSettings(next);
        return next;
      });
    },
    [pushSettings, session],
  );

  const resetSettings = useCallback(
    () =>
      setSettings((prev) => ({
        ...DEFAULT_SETTINGS,
        blacklistCookies: prev.blacklistCookies,
        blacklistThreads: prev.blacklistThreads,
      })),
    [],
  );

  const toggleBookmark = useCallback(
    async (threadId: number) => {
      const added = await run(() => api.toggleBookmark(threadId));
      if (added === undefined) return;
      notify(added ? '已加入书签' : '已移出书签', 'ok');
      const list = await api.fetchBookmarks().catch(() => []);
      setBookmarks(list);
    },
    [notify, run],
  );

  const blockCookie = useCallback(
    (cookie: string) => {
      const value = cookie.trim().toUpperCase();
      if (!value) return;
      saveSettings({ blacklistCookies: [...new Set([...settings.blacklistCookies, value])] });
      notify(`已屏蔽饼干 ${value}`, 'ok');
    },
    [notify, saveSettings, settings.blacklistCookies],
  );

  const unblockCookie = useCallback(
    (cookie: string) => saveSettings({ blacklistCookies: settings.blacklistCookies.filter((c) => c !== cookie) }),
    [saveSettings, settings.blacklistCookies],
  );

  const blockThread = useCallback(
    (threadId: number) => {
      saveSettings({ blacklistThreads: [...new Set([...settings.blacklistThreads, threadId])] });
      notify(`已屏蔽串 No.${threadId}`, 'ok');
    },
    [notify, saveSettings, settings.blacklistThreads],
  );

  const unblockThread = useCallback(
    (threadId: number) => saveSettings({ blacklistThreads: settings.blacklistThreads.filter((t) => t !== threadId) }),
    [saveSettings, settings.blacklistThreads],
  );

  const isCookieBlocked = useCallback(
    (cookie: string) => settings.blacklistCookies.some((item) => item.toUpperCase() === cookie.toUpperCase()),
    [settings.blacklistCookies],
  );
  const isThreadBlocked = useCallback(
    (threadId: number) => settings.blacklistThreads.includes(threadId),
    [settings.blacklistThreads],
  );

  const value = useMemo<AppState>(
    () => ({
      session,
      settings,
      bookmarks,
      notices,
      ready,
      taskPulse,
      login,
      register,
      logout,
      saveSettings,
      resetSettings,
      toggleBookmark,
      blockCookie,
      unblockCookie,
      blockThread,
      unblockThread,
      isCookieBlocked,
      isThreadBlocked,
      notify,
      run,
    }),
    [
      session,
      settings,
      bookmarks,
      notices,
      ready,
      taskPulse,
      login,
      register,
      logout,
      saveSettings,
      resetSettings,
      toggleBookmark,
      blockCookie,
      unblockCookie,
      blockThread,
      unblockThread,
      isCookieBlocked,
      isThreadBlocked,
      notify,
      run,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// Provider 与 hook 同文件，关掉 react-refresh 提示
// eslint-disable-next-line react-refresh/only-export-components
export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}
