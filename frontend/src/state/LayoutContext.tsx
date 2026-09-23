import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface LayoutState {
  /** 右侧工具栏是否展开：展开时正文要让出宽度，而不是被面板盖住 */
  dockOpen: boolean;
  setDockOpen: (open: boolean) => void;
}

const LayoutContext = createContext<LayoutState | null>(null);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [dockOpen, setDockOpenState] = useState(false);
  const setDockOpen = useCallback((open: boolean) => setDockOpenState(open), []);
  const value = useMemo(() => ({ dockOpen, setDockOpen }), [dockOpen, setDockOpen]);
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

// Provider 与 hook 同文件，关掉 react-refresh 提示
// eslint-disable-next-line react-refresh/only-export-components
export function useLayout(): LayoutState {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout 必须在 LayoutProvider 内使用');
  return ctx;
}
