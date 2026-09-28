import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// 端口与后端地址都从 .env 读，方便一台机器上跑多套实例：
//   VITE_PORT       前端 dev 端口（默认 5177；本栈用 5277，避开旧栈）
//   VITE_API_TARGET 后端地址（默认 127.0.0.1:8080；本栈后端在 9080）
//   VITE_HOST       监听地址（默认 0.0.0.0；只想本机访问就设 127.0.0.1）
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const port = Number(env.VITE_PORT || 5177);
  const apiTarget = env.VITE_API_TARGET || 'http://127.0.0.1:8080';
  const host = env.VITE_HOST || '0.0.0.0';

  return {
    plugins: [react()],
    server: {
      // 默认绑 0.0.0.0：手机连同一个局域网就能直接开 /m/... 调手机端，不用先构建产物
      host,
      port,
      strictPort: true,
      // 局域网里用主机名（xxx.local 之类）访问时 Vite 默认会拦；这里放开
      allowedHosts: true,
      // 开发时把 /api 反代到后端，前后端同源 → Cookie 不受 SameSite 影响
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: false,
        },
      },
    },
    preview: {
      host,
    },
  };
});
