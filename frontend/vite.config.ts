import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// 端口与后端地址都从 .env 读，方便一台机器上跑多套实例：
//   VITE_PORT       前端 dev 端口（默认 5177；本栈用 5277，避开旧栈）
//   VITE_API_TARGET 后端地址（默认 127.0.0.1:8080；本栈后端在 9080）
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const port = Number(env.VITE_PORT || 5177);
  const apiTarget = env.VITE_API_TARGET || 'http://127.0.0.1:8080';

  return {
    plugins: [react()],
    server: {
      port,
      strictPort: true,
      // 开发时把 /api 反代到后端，前后端同源 → Cookie 不受 SameSite 影响
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: false,
        },
      },
    },
  };
});
