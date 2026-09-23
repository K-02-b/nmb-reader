/** 与后端 Pydantic 模型一一对应的契约类型。时间字段一律是 Unix 秒。 */

export type TagType = 'genre' | 'series' | 'status' | 'installment' | 'CUSTOM_TAG';

export interface Tag {
  tagId: number;
  tagType: TagType;
  tagName: string;
}

/** post 表：所有帖子，串首是特殊 post（pageNum = 0） */
export interface Post {
  threadId: number;
  id: number;
  cookie: string;
  pageNum: number;
  isPo: boolean;
  isSage: boolean;
  isAdmin: boolean;
  createdAt: number;
  /** post_body 表 */
  content: string;
  /** 本地图片路径 */
  img?: string | null;
  /** 原图床链接，本地图缺失时回源 */
  imgSource?: string | null;
  title?: string | null;
  name?: string | null;
}

/** thread 表：串首数据 + 展示用字段 */
export interface Thread {
  threadId: number;
  /** 所属板块 */
  board?: string | null;
  cookie: string;
  replies: number;
  isSage: boolean;
  isAdmin: boolean;
  installment: number | null;
  createdAt: number;
  updatedAt: number;
  title: string;
  excerpt: string;
  img?: string | null;
  tags: Tag[];
  replyCount: number;
  imageCount: number;
  pageCount: number;
}

export interface ThreadQuery {
  keyword?: string;
  /** 按板块筛选（模糊） */
  board?: string | null;
  threadId?: number | null;
  cookie?: string;
  genre?: string;
  series?: string;
  status?: string;
  tags?: string[];
  bookmarkedOnly?: boolean;
  sort?: 'created_desc' | 'created_asc' | 'replies_desc' | 'updated_desc';
  page?: number;
  pageSize?: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 筛选下拉框的取值：由已入库串的标签汇总而来 */
export interface TagVocabulary {
  genre: string[];
  series: string[];
  status: string[];
  /** 卷次；数字字符串，支持 13.5 这类间章 */
  installment: string[];
  tags: string[];
}

/** download = 抓页入库；images = 图片本地化 */
export type TaskKind = 'download' | 'images';

export type TaskStatus =
  | 'queued'
  | 'downloading'
  | 'downloaded'
  | 'writing'
  | 'written'
  | 'indexing'
  | 'indexed'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'write_failed'
  | 'index_failed'
  | 'images_running'
  | 'images_done'
  | 'images_failed';

export interface DownloadTask {
  taskId: string;
  kind: TaskKind;
  threadId: number;
  /** 提交时填的标题；没填就是 null */
  title?: string | null;
  /** 目前只会是 XD；AWD / BOG 尚未接入，保留在类型里以兼容历史任务 */
  source: 'XD' | 'AWD' | 'BOG';
  status: TaskStatus;
  submittedBy: string;
  submittedAt: number;
  finishedAt?: number | null;
  /** 已下载页 / 总页；图片任务表示已本地化 / 待本地化张数 */
  page: number;
  totalPages: number;
  /** 已入库条数 */
  written?: number;
  message?: string | null;
  /** 队列中排在它前面的任务数 */
  ahead: number;
}

export type UserGroup = 'admin' | 'editor' | 'user';

export interface User {
  username: string;
  group: UserGroup;
  createdAt: number;
  lastLoginAt: number;
  banned: boolean;
}

/** 数据库概况（GET /api/db/stats） */
export interface DbStats {
  threads: number;
  posts: number;
  bodies: number;
  /** 备份文件名，新的在前 */
  backups: string[];
  /** 字节数，仅 SQLite 有意义 */
  dbSize: number;
}

export type Permission = 'thread.download' | 'thread.edit' | 'user.manage' | 'db.manage' | 'log.view';

export interface Session {
  username: string;
  group: UserGroup;
  permissions: Permission[];
}

export interface UserSettings {
  theme: 'dark' | 'light';
  accent: string;
  fontSize: number;
  fontFamily: 'system' | 'serif' | 'mono';
  lineHeight: number;
  brightness: number;
  pageSize: number;
  /** island = 按岛页码；custom = 按 pageSize 切 */
  pagingMode: 'island' | 'custom';
  /** 单串最大下载页数；null = 用服务器默认值 */
  fetchMaxPages?: number | null;
  /** 页请求并发度；null = 用服务器默认值 */
  fetchConcurrency?: number | null;
  /** 导出 docx / pdf 时是否内嵌图片（记住上次的选择） */
  exportImages: boolean;
  /** 内嵌图片的质量档位（记住上次的选择） */
  exportQuality: 'high' | 'medium' | 'low';
  blacklistCookies: string[];
  blacklistThreads: number[];
}

/** Cookie 状态：只有元信息，不含内容 */
export interface CookieStatus {
  configured: boolean;
  /** user=本人导入；server=服务器级兜底；none=未配置 */
  source: 'user' | 'server' | 'none';
  updatedAt: number | null;
  verifiedAt: number | null;
  verifyOk: boolean | null;
  lastError: string | null;
  /** 二维码里标注的饼干 ID，仅扫码导入的响应会带 */
  label?: string | null;
}

export interface Bookmark {
  threadId: number;
  title: string;
  /** 岛页码 */
  page: number;
  createdAt: number;
}

/** 楼层书签（右侧工具栏的「书签」面板），每个用户各自一份，按串归属 */
export interface PostBookmark {
  postId: number;
  threadId: number;
  threadTitle: string;
  /** 用户给书签起的名字，默认空 */
  title: string;
  /** 该楼所在的岛页码 */
  pageNum: number;
  excerpt: string;
  createdAt: number;
  /** 所属串的标签，用来按标签筛选书签 */
  tags: Tag[];
}

export interface Invite {
  code: string;
  enabled: boolean;
  maxUses: number;
  usedCount: number;
  expiresAt: number;
  note: string | null;
}

export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
}

/** 服务器侧的限制与开关（GET /api/meta） */
export interface ServerMeta {
  fetchMaxPagesDefault: number;
  fetchMaxPagesCeiling: number;
  fetchConcurrencyDefault: number;
  fetchConcurrencyCeiling: number;
  imagesEnabled: boolean;
  searchBackend: string;
}

export const DEFAULT_SETTINGS: UserSettings = {
  theme: 'dark',
  accent: '#6ea8fe',
  fontSize: 15,
  fontFamily: 'system',
  lineHeight: 1.75,
  brightness: 100,
  pageSize: 20,
  pagingMode: 'island',
  fetchMaxPages: null,
  fetchConcurrency: null,
  exportImages: false,
  exportQuality: 'medium',
  blacklistCookies: [],
  blacklistThreads: [],
};

/** 状态机展示用文案 */
export const TASK_STATUS_TEXT: Record<TaskStatus, string> = {
  queued: '已提交',
  downloading: '下载中',
  downloaded: '下载完成',
  writing: '写入中',
  written: '写入完成',
  indexing: '目录处理中',
  indexed: '目录处理完成',
  cancelling: '取消中',
  cancelled: '取消完成',
  failed: '下载失败',
  write_failed: '写入失败',
  index_failed: '目录处理失败',
  images_running: '图片本地化中',
  images_done: '图片完成',
  images_failed: '图片失败',
};

export const TASK_STATUS_KIND: Record<TaskStatus, 'pending' | 'running' | 'done' | 'error'> = {
  queued: 'pending',
  downloading: 'running',
  downloaded: 'pending',
  writing: 'running',
  written: 'done',
  indexing: 'running',
  indexed: 'done',
  cancelling: 'pending',
  cancelled: 'pending',
  failed: 'error',
  write_failed: 'error',
  index_failed: 'error',
  images_running: 'running',
  images_done: 'done',
  images_failed: 'error',
};
