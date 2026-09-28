import { Navigate } from 'react-router-dom';
import { preferMobile } from './device';

/**
 * 根路径/未知路径的入口分发：手机走 `/m/home`，其余走 `/home`。
 *
 * 只在这一处按设备猜，站内跳转一律用显式路由，免得手机用户点进阅读页又被弹回目录。
 */
export function EntryRedirect() {
  return <Navigate to={preferMobile() ? '/m/home' : '/home'} replace />;
}
