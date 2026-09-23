/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** FastAPI 服务地址，例如 http://127.0.0.1:8080；留空表示同源 */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
