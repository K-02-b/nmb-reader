import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useApp } from '../state/AppContext';

/** 手机端路由守卫：未登录回手机端登录页，登录后回到原来要去的手机端页面 */
export function MobileRequireAuth({ children }: { children: ReactNode }) {
  const { session, ready } = useApp();
  const location = useLocation();
  if (!ready) return <div className="loading">正在校验登录状态…</div>;
  if (!session) return <Navigate to="/m/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}
