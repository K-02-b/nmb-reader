import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useApp } from '../state/AppContext';

/** 路由守卫：未登录回登录页。 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, ready } = useApp();
  const location = useLocation();
  if (!ready) return <div className="loading">正在校验登录状态…</div>;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}
