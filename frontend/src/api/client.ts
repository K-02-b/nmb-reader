import type {
  Bookmark,
  CookieStatus,
  DownloadTask,
  Invite,
  LogEntry,
  Paged,
  Post,
  PostBookmark,
  ServerMeta,
  Session,
  Tag,
  TagVocabulary,
  Thread,
  ThreadQuery,
  User,
  UserSettings,
} from './types';

/** 唯一的数据入口；默认同源相对路径，跨域部署时用 VITE_API_BASE 指向后端。 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '') as string;

/** 后端返回 `{code, detail}`；页面展示 detail，需要分支时用 `.code`。 */
export class ApiError extends Error {
  readonly code: string;

  constructor(message: string, code = 'UNKNOWN') {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string; code?: string };
    throw new ApiError(body.detail ?? `请求失败（${res.status}）`, body.code ?? 'UNKNOWN');
  }
  // 204 与空响应体不能当 JSON 解析
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function queryString(query: ThreadQuery): string {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
    else params.set(key, String(value));
  });
  return params.toString();
}

export const api = {
  // 认证
  login: (username: string, password: string) =>
    request<Session>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  register: (username: string, password: string, inviteCode: string) =>
    request<void>('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password, inviteCode }) }),
  /** 未登录时后端返回 200 + null（不刷 401） */
  me: () => request<Session | null>('/api/auth/me'),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<Session>('/api/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // 串与楼层
  fetchThreads: (query: ThreadQuery) => request<Paged<Thread>>(`/api/threads?${queryString(query)}`),
  /** 这个串在当前筛选与排序下排第几条（「在目录显示」用） */
  threadPosition: (threadId: number, query: ThreadQuery) =>
    request<{ index: number; page: number }>(`/api/threads/${threadId}/position?${queryString(query)}`),
  fetchThread: (threadId: number) => request<Thread>(`/api/threads/${threadId}`),
  fetchTagVocabulary: () => request<TagVocabulary>('/api/tags'),
  fetchPosts: (threadId: number, page: number, pageSize: number, pagingMode: string, keyword: string, poOnly = false) =>
    request<Paged<Post>>(
      `/api/threads/${threadId}/posts?page=${page}&pageSize=${pageSize}&pagingMode=${pagingMode}` +
        (keyword ? `&keyword=${encodeURIComponent(keyword)}` : '') +
        (poOnly ? '&poOnly=true' : ''),
    ),
  quotePost: (postId: number) => request<Post>(`/api/posts/${postId}`),
  fullText: (keyword: string, limit = 200) =>
    request<Array<{ thread: Thread; post: Post }>>(
      `/api/search/fulltext?keyword=${encodeURIComponent(keyword)}&limit=${limit}`,
    ),
  updateThreadTags: (threadId: number, tags: Tag[]) =>
    request<Tag[]>(`/api/threads/${threadId}/tags`, { method: 'PUT', body: JSON.stringify({ tags }) }),
  deleteThread: (threadId: number) => request<void>(`/api/threads/${threadId}`, { method: 'DELETE' }),
  suggestFix: (threadId: number, kind: string, detail: string) =>
    request<void>(`/api/threads/${threadId}/suggest`, { method: 'POST', body: JSON.stringify({ kind, detail }) }),

  /** 导出并直接落盘；用 fetch 是为了拿到失败原因（比如串不存在） */
  exportThread: async (threadId: number, format: 'docx' | 'pdf' | 'md' | 'json', images: boolean, quality: string) => {
    const params = new URLSearchParams({ format, images: String(images), quality });
    const res = await fetch(`${API_BASE}/api/threads/${threadId}/export?${params}`, { credentials: 'include' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string; code?: string };
      throw new ApiError(body.detail ?? `导出失败（${res.status}）`, body.code ?? 'UNKNOWN');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `No.${threadId}.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },

  // 下载队列
  fetchTasks: (params: { limit?: number; since?: number; status?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.since) query.set('since', String(params.since));
    if (params.status) query.set('status', params.status);
    const suffix = query.toString();
    return request<DownloadTask[]>(`/api/downloads${suffix ? `?${suffix}` : ''}`);
  },
  submitTask: (threadId: number, source: string, title: string) =>
    request<DownloadTask>('/api/downloads', { method: 'POST', body: JSON.stringify({ threadId, source, title }) }),
  cancelTask: (taskId: string) => request<DownloadTask>(`/api/downloads/${taskId}/cancel`, { method: 'POST' }),
  retryTask: (taskId: string) => request<DownloadTask>(`/api/downloads/${taskId}/retry`, { method: 'POST' }),

  // 个人数据
  toggleBookmark: (threadId: number) => request<boolean>(`/api/bookmarks/${threadId}/toggle`, { method: 'POST' }),

  // 楼层书签（右侧工具栏的「书签」面板）；不带 threadId 就是全部
  fetchPostBookmarks: (threadId?: number) =>
    request<PostBookmark[]>(`/api/post-bookmarks${threadId ? `?threadId=${threadId}` : ''}`),
  addPostBookmark: (threadId: number, postId: number) =>
    request<void>(`/api/threads/${threadId}/post-bookmarks/${postId}`, { method: 'POST' }),
  removePostBookmark: (threadId: number, postId: number) =>
    request<void>(`/api/threads/${threadId}/post-bookmarks/${postId}`, { method: 'DELETE' }),
  renamePostBookmark: (threadId: number, postId: number, title: string) =>
    request<void>(`/api/threads/${threadId}/post-bookmarks/${postId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  fetchBookmarks: () => request<Bookmark[]>('/api/bookmarks'),
  saveProgress: (threadId: number, page: number) =>
    request<void>(`/api/progress/${threadId}`, { method: 'PUT', body: JSON.stringify({ page }) }),
  fetchProgress: () =>
    request<{ items: Array<{ threadId: number; page: number }> }>('/api/progress').then((r) => r.items),
  fetchSettings: () => request<UserSettings>('/api/settings'),
  saveSettings: (settings: UserSettings) =>
    request<UserSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  fetchMeta: () => request<ServerMeta>('/api/meta'),

  // Cookie
  fetchCookieStatus: () => request<CookieStatus>('/api/me/nmb-cookie'),
  saveCookie: (cookie: string) =>
    request<CookieStatus>('/api/me/nmb-cookie', { method: 'PUT', body: JSON.stringify({ cookie, verify: true }) }),
  verifyCookie: () => request<CookieStatus>('/api/me/nmb-cookie/verify', { method: 'POST' }),
  // 上传用 FormData：必须清掉默认 Content-Type，否则浏览器不会补 multipart boundary
  importCookieFromQrcode: (file: File) => {
    const form = new FormData();
    form.append('image', file);
    return request<CookieStatus>('/api/me/nmb-cookie/qrcode', { method: 'POST', body: form, headers: {} });
  },
  clearCookie: () => request<CookieStatus>('/api/me/nmb-cookie', { method: 'DELETE' }),

  // 管理
  fetchUsers: () => request<User[]>('/api/users'),
  createUser: (payload: { username: string; password: string; group: string }) =>
    request<User>('/api/users', { method: 'POST', body: JSON.stringify(payload) }),
  updateUser: (username: string, patch: { group?: string; banned?: boolean }) =>
    request<User>(`/api/users/${username}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteUser: (username: string) => request<void>(`/api/users/${username}`, { method: 'DELETE' }),
  fetchInvites: () => request<Invite[]>('/api/invites'),
  createInvite: (payload: { code?: string; maxUses: number; days: number; note?: string }) =>
    request<Invite>('/api/invites', { method: 'POST', body: JSON.stringify(payload) }),
  updateInvite: (code: string, patch: { enabled?: boolean; maxUses?: number; days?: number; note?: string }) =>
    request<Invite>(`/api/invites/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteInvite: (code: string) => request<void>(`/api/invites/${encodeURIComponent(code)}`, { method: 'DELETE' }),
  fetchLogs: (params: { scope?: string; level?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.scope) query.set('scope', params.scope);
    if (params.level) query.set('level', params.level);
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.toString();
    return request<LogEntry[]>(`/api/logs${suffix ? `?${suffix}` : ''}`);
  },
  dbStats: () =>
    request<{ threads: number; posts: number; bodies: number; backups: string[]; dbSize: number }>('/api/db/stats'),
  dbOperation: (op: string) => request<{ message: string }>(`/api/db/${op}`, { method: 'POST' }).then((r) => r.message),
};
