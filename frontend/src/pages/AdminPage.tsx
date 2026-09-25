import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type {
  CookieStatus,
  DbStats,
  DownloadTask,
  Invite,
  LogEntry,
  Permission,
  Tag,
  Thread,
  User,
} from '../api/types';
import { useApp } from '../state/AppContext';
import { useTagVocab } from '../state/TagVocabContext';
import { TaskTable } from '../components/TaskTable';
import { TagEditor } from '../components/TagEditor';
import { fmtDate, fmtRelative, groupText, parseThreadId } from '../components/format';
import { useIncrementalList } from '../components/useIncrementalList';

type TabKey = 'submit' | 'tasks' | 'threads' | 'users' | 'database' | 'logs';

const TABS: Array<{ key: TabKey; label: string; permission: Permission }> = [
  { key: 'submit', label: '下载申请', permission: 'thread.download' },
  { key: 'tasks', label: '下载状态', permission: 'thread.download' },
  { key: 'threads', label: '串信息与标签', permission: 'thread.edit' },
  { key: 'users', label: '用户与权限', permission: 'user.manage' },
  { key: 'database', label: '数据库管理', permission: 'db.manage' },
  { key: 'logs', label: '日志', permission: 'log.view' },
];

/** 日志模块（scope）与显示名；未列出的模块按原名显示 */
const LOG_SCOPES: Array<[string, string]> = [
  ['', '全部模块'],
  ['auth', '账号'],
  ['download', '下载'],
  ['images', '图片'],
  ['search', '检索'],
  ['thread', '串信息'],
  ['suggest', '建议修正'],
  ['db', '数据库'],
  ['app', '应用'],
];

const SCOPE_TEXT: Record<string, string> = Object.fromEntries(LOG_SCOPES);

/** 日志级别筛选 */
const LOG_LEVELS: Array<[string, string]> = [
  ['', '全部级别'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error'],
];

/** 下载任务的时间段按天给 */
const TASK_WINDOWS: Array<[number, string]> = [
  [1, '最近 1 天'],
  [3, '最近 3 天'],
  [7, '最近 7 天'],
  [30, '最近 30 天'],
  [0, '全部时间'],
];
const TASK_STATUS_FILTERS: Array<[string, string]> = [
  ['', '全部状态'],
  ['active', '进行中'],
  ['done', '已完成'],
  ['failed', '失败'],
];

export function AdminPage() {
  const { session, run, notify } = useApp();
  const { refresh: refreshVocab } = useTagVocab();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const allowed = useMemo(() => TABS.filter((t) => session?.permissions.includes(t.permission)), [session]);
  const [tab, setTab] = useState<TabKey>(() => {
    // 首页「管理」按钮带过来的 ?tab=threads&thread=<串号>
    const wanted = searchParams.get('tab');
    return allowed.some((t) => t.key === wanted) ? (wanted as TabKey) : (allowed[0]?.key ?? 'submit');
  });
  /** 需要定位并展开编辑框的串（来自 URL） */
  const focusThreadId = Number(searchParams.get('thread')) || null;
  const [focusedId, setFocusedId] = useState<number | null>(null);

  // 时间段与状态筛选；列表本身由 useIncrementalList 负责翻页与滚动加载
  const [taskDays, setTaskDays] = useState(3);
  const [taskStatus, setTaskStatus] = useState('');
  const [threadId, setThreadId] = useState('');
  const [title, setTitle] = useState('');
  const [submitHint, setSubmitHint] = useState('');

  const [threads, setThreads] = useState<Thread[]>([]);
  /** 筛选条件：draft 是输入框里的，applied 是点了「检索」后生效的 */
  const [threadFilter, setThreadFilter] = useState<{ threadId: string; keyword: string }>({
    threadId: '',
    keyword: '',
  });
  const [appliedFilter, setAppliedFilter] = useState({ threadId: '', keyword: '' });
  /** 正在编辑的串 → 草稿标签；用 map 以便同时编辑多个 */
  const [drafts, setDrafts] = useState<Record<number, Tag[]>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [threadsLoaded, setThreadsLoaded] = useState(false);

  const [users, setUsers] = useState<User[]>([]);
  const [newUser, setNewUser] = useState({ username: '', password: '', group: 'user' });
  /** 删除要二次确认：先点一次变成「确认删除」 */
  const [confirmDelete, setConfirmDelete] = useState('');
  const [invites, setInvites] = useState<Invite[]>([]);
  const [newInvite, setNewInvite] = useState({ code: '', maxUses: 0, days: 0, note: '' });

  const [logScope, setLogScope] = useState('');
  const [logLevel, setLogLevel] = useState('');
  const [dbResult, setDbResult] = useState('');
  const [dbStats, setDbStats] = useState<DbStats | null>(null);
  const [cookieStatus, setCookieStatus] = useState<CookieStatus | null>(null);

  const taskSince = taskDays > 0 ? Math.floor(Date.now() / 1000) - taskDays * 86400 : undefined;
  const tasks = useIncrementalList<DownloadTask>({
    fetchPage: (limit) =>
      api.fetchTasks({ limit, since: taskSince, status: taskStatus || undefined, withAhead: true }).catch(() => []),
    resetKey: `${taskDays}|${taskStatus}`,
    pollMs: tab === 'tasks' ? 2000 : 0,
  });
  const logs = useIncrementalList<LogEntry>({
    fetchPage: (limit) => api.fetchLogs({ scope: logScope, level: logLevel, limit }).catch(() => []),
    resetKey: `${logScope}|${logLevel}`,
  });

  useEffect(() => {
    if (allowed.length > 0 && !allowed.some((t) => t.key === tab)) setTab(allowed[0].key);
  }, [allowed, tab]);

  // 提交前先确认有没有可用的 Cookie
  useEffect(() => {
    void api
      .fetchCookieStatus()
      .then(setCookieStatus)
      .catch(() => setCookieStatus(null));
  }, []);

  /** 串列表（带筛选） */
  const loadThreads = useCallback(async () => {
    try {
      const result = await api.fetchThreads({
        threadId: appliedFilter.threadId ? parseThreadId(appliedFilter.threadId) : null,
        keyword: appliedFilter.keyword || undefined,
        // pageSize 上限是 100，超了会被 422 拒掉
        pageSize: 100,
        sort: 'created_desc',
      });
      setThreads(result.items);
    } catch (error) {
      notify(error instanceof Error ? error.message : '串列表加载失败', 'error');
    } finally {
      setThreadsLoaded(true);
    }
  }, [appliedFilter, notify]);

  // 从首页「管理」跳进来：定位到该串、展开标签编辑框并滚动过去
  const focusHandled = useRef<number | null>(null);
  useEffect(() => {
    if (tab !== 'threads' || !focusThreadId || !threadsLoaded) return;
    if (focusHandled.current === focusThreadId) return;
    let alive = true;
    (async () => {
      let target = threads.find((t) => t.threadId === focusThreadId);
      if (!target) {
        // 不在当前筛选/分页里：单独取一次并插到最前，保证能定位到
        const one = await api.fetchThread(focusThreadId).catch(() => null);
        if (!one || !alive) return;
        target = one;
        setThreads((prev) => [one, ...prev.filter((t) => t.threadId !== focusThreadId)]);
      }
      focusHandled.current = focusThreadId;
      setDrafts((prev) => ({ ...prev, [focusThreadId]: target.tags }));
      setFocusedId(focusThreadId);
      window.setTimeout(() => {
        document
          .getElementById(`admin-thread-${focusThreadId}`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 120);
      window.setTimeout(() => setFocusedId((cur) => (cur === focusThreadId ? null : cur)), 2400);
    })();
    return () => {
      alive = false;
    };
  }, [focusThreadId, tab, threads, threadsLoaded]);

  useEffect(() => {
    if (tab === 'threads') void loadThreads();
    if (tab === 'users') {
      void api.fetchUsers().then(setUsers);
      void api.fetchInvites().then(setInvites);
    }
    if (tab === 'database')
      void api
        .dbStats()
        .then(setDbStats)
        .catch(() => setDbStats(null));
  }, [logLevel, logScope, tab, loadThreads]);

  const closeDraft = (threadId: number) =>
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[threadId];
      return next;
    });

  /** 保存单个串的标签；用草稿更新本地行，避免整表重拉 */
  const saveDraft = async (threadId: number) => {
    const tags = drafts[threadId];
    if (!tags) return;
    setSavingId(threadId);
    const ok = await run(() => api.updateThreadTags(threadId, tags));
    setSavingId(null);
    if (ok === undefined) return;
    setThreads((prev) => prev.map((item) => (item.threadId === threadId ? { ...item, tags } : item)));
    closeDraft(threadId);
    // 刷新词汇表，让别处也能选到新标签
    void refreshVocab();
  };

  /** 逐个保存；单个失败不影响其它 */
  const saveAllDrafts = async () => {
    const ids = Object.keys(drafts).map(Number);
    let failed = 0;
    for (const threadId of ids) {
      const tags = drafts[threadId];
      const ok = await run(() => api.updateThreadTags(threadId, tags));
      if (ok === undefined) {
        failed += 1;
        continue;
      }
      setThreads((prev) => prev.map((item) => (item.threadId === threadId ? { ...item, tags } : item)));
      closeDraft(threadId);
    }
    notify(failed === 0 ? `已保存 ${ids.length} 个串的标签` : `保存完成，${failed} 个失败`, failed ? 'error' : 'ok');
    if (failed < ids.length) void refreshVocab();
  };

  if (!session) return null;

  if (allowed.length === 0) {
    return (
      <div className="card">
        <h3>没有可用的管理功能</h3>
        <p className="hint">当前用户组为「{groupText(session.group)}」，未分配任何管理权限。</p>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <div className="card-title">
          <h3>管理页</h3>
          <span className="hint">
            各标签页按权限矩阵过滤，只显示当前账号有权使用的功能 · {session.username} · {groupText(session.group)}
          </span>
        </div>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {allowed.map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'submit' && (
        <div className="card mt-12">
          <div className="card-title">
            <h3>提交下载申请</h3>
            <span className="hint">串已存在时采用增量更新</span>
          </div>
          <div className="grid-3">
            <div className="field">
              <label>串号</label>
              <input
                className="input"
                value={threadId}
                onChange={(e) => setThreadId(e.target.value)}
                placeholder="59775198 或 No.59775198"
              />
            </div>
            <div className="field">
              <label>来源</label>
              <select className="select" value="XD" disabled>
                <option value="XD">XD（X岛）</option>
              </select>
              <span className="hint">AWD / BOG 的抓取链路尚未接入，暂时只能从 X岛 下载</span>
            </div>
            <div className="field">
              <label>标题（可选）</label>
              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="留空自动从串首取"
              />
            </div>
          </div>
          {cookieStatus && !cookieStatus.configured && (
            <p className="error-text">
              你还没有导入 Cookie，提交的下载任务会失败。
              <button className="link-btn" style={{ marginLeft: 6 }} onClick={() => navigate('/settings')}>
                去「设置 → Cookie」导入
              </button>
            </p>
          )}
          {cookieStatus?.configured && (
            <p className="hint" style={{ marginTop: 0 }}>
              Cookie：{cookieStatus.source === 'user' ? '已导入' : '使用服务器级兜底'}
              {cookieStatus.verifyOk === false ? `（上次校验失败：${cookieStatus.lastError ?? ''}）` : ''}
            </p>
          )}
          <div className="row">
            <button
              className="btn btn-primary"
              onClick={async () => {
                const parsed = parseThreadId(threadId);
                if (parsed === null) {
                  setSubmitHint('串号要填数字，例如 59775198 或 No.59775198');
                  return;
                }
                const task = await run(
                  () => api.submitTask(parsed, 'XD', title),
                  '下载申请已提交，可在「下载状态」查看进度',
                );
                if (task) {
                  setSubmitHint(`任务 ${task.taskId}：${task.message ?? '已进入队列'}`);
                  setThreadId('');
                  setTitle('');
                  tasks.reload();
                }
              }}
            >
              提交申请
            </button>
            <button className="btn" onClick={tasks.reload}>
              刷新队列
            </button>
          </div>
          {submitHint && <p className="ok-text">{submitHint}</p>}
        </div>
      )}

      {tab === 'tasks' && (
        <div className="card mt-12">
          <div className="card-title">
            <h3>下载任务（{tasks.items.length}）</h3>
            <div className="row">
              <select className="select" value={taskDays} onChange={(e) => setTaskDays(Number(e.target.value))}>
                {TASK_WINDOWS.map(([days, label]) => (
                  <option key={days} value={days}>
                    {label}
                  </option>
                ))}
              </select>
              <select className="select" value={taskStatus} onChange={(e) => setTaskStatus(e.target.value)}>
                {TASK_STATUS_FILTERS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button className="btn btn-sm" onClick={tasks.reload}>
                刷新
              </button>
            </div>
          </div>

          <div className="list-scroll" ref={tasks.boxRef} onScroll={tasks.onScroll}>
            <TaskTable
              tasks={tasks.items}
              onCancel={(id) => void run(() => api.cancelTask(id), '已请求取消').then(tasks.reload)}
              onRetry={(id) => void run(() => api.retryTask(id), '已重新提交').then(tasks.reload)}
              onOpenThread={(id) => navigate(`/t/${id}`)}
            />
            {tasks.items.length > 0 && (
              <p className="hint list-more">
                {tasks.loading ? '加载中…' : tasks.hasMore ? '滚动到底部自动加载更多' : '没有更多了'}
              </p>
            )}
          </div>
          <p className="hint">按提交时间倒序，每次加载 10 条，滚到框底自动继续；任务进行中时每 2 秒自动刷新。</p>
        </div>
      )}

      {tab === 'threads' && (
        <div className="card mt-12">
          <div className="card-title">
            <h3>串信息与标签（{threads.length}）</h3>
            <span className="hint">类型/系列/状态/卷次每串只能有一个</span>
          </div>

          <div className="row row-wrap" style={{ marginBottom: 12 }}>
            <input
              className="input mono"
              style={{ maxWidth: 180 }}
              inputMode="numeric"
              placeholder="串号（可只填片段）"
              value={threadFilter.threadId}
              onChange={(event) =>
                setThreadFilter((prev) => ({ ...prev, threadId: event.target.value.replace(/[^0-9]/g, '') }))
              }
              onKeyDown={(event) => event.key === 'Enter' && setAppliedFilter(threadFilter)}
            />
            <input
              className="input"
              style={{ maxWidth: 240 }}
              placeholder="标题 / 标签关键词"
              value={threadFilter.keyword}
              onChange={(event) => setThreadFilter((prev) => ({ ...prev, keyword: event.target.value }))}
              onKeyDown={(event) => event.key === 'Enter' && setAppliedFilter(threadFilter)}
            />
            <button className="btn" onClick={() => setAppliedFilter(threadFilter)}>
              检索
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                const empty = { threadId: '', keyword: '' };
                setThreadFilter(empty);
                setAppliedFilter(empty);
              }}
            >
              清空
            </button>

            <span className="spacer" />

            {Object.keys(drafts).length > 0 && (
              <>
                <span className="badge badge-accent">正在编辑 {Object.keys(drafts).length} 个串</span>
                <button className="btn btn-primary btn-sm" onClick={() => void saveAllDrafts()}>
                  全部保存
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setDrafts({})}>
                  全部关闭
                </button>
              </>
            )}
          </div>

          <div className="list-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>串号</th>
                  <th>标题</th>
                  <th>标签</th>
                  <th>回复</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {threads.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">
                      没有匹配的串
                    </td>
                  </tr>
                )}
                {threads.map((thread) => {
                  const draft = drafts[thread.threadId];
                  const open = draft !== undefined;
                  return (
                    <Fragment key={thread.threadId}>
                      <tr
                        id={`admin-thread-${thread.threadId}`}
                        className={focusedId === thread.threadId ? 'row-focus' : undefined}
                      >
                        <td className="mono">{thread.threadId}</td>
                        <td>{thread.title}</td>
                        <td>
                          <div className="row row-wrap">
                            {thread.tags.length === 0 && <span className="hint">无标签</span>}
                            {thread.tags.map((tag) => (
                              <span key={`${tag.tagType}-${tag.tagName}`} className={`tag tag-${tag.tagType}`}>
                                {tag.tagName}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td>{thread.replies}</td>
                        <td className="nowrap">{fmtRelative(thread.updatedAt)}</td>
                        <td>
                          <div className="row" style={{ gap: 6 }}>
                            <button
                              className={`btn btn-sm ${open ? '' : 'btn-primary'}`}
                              onClick={() =>
                                setDrafts((prev) => {
                                  if (prev[thread.threadId]) {
                                    const next = { ...prev };
                                    delete next[thread.threadId];
                                    return next;
                                  }
                                  return { ...prev, [thread.threadId]: thread.tags };
                                })
                              }
                            >
                              {open ? '收起' : '编辑'}
                            </button>
                            <button className="btn btn-sm btn-ghost" onClick={() => navigate(`/t/${thread.threadId}`)}>
                              阅读
                            </button>
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={async () => {
                                await run(() => api.deleteThread(thread.threadId), `已删除 No.${thread.threadId}`);
                                setDrafts((prev) => {
                                  const next = { ...prev };
                                  delete next[thread.threadId];
                                  return next;
                                });
                                void loadThreads();
                              }}
                            >
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* 编辑框插在这一行下面 */}
                      {open && (
                        <tr className="editor-row">
                          <td colSpan={6}>
                            <div className="inline-editor">
                              <div className="row" style={{ marginBottom: 10 }}>
                                <strong>编辑 No.{thread.threadId}</strong>
                                <span className="hint">{thread.title}</span>
                                <span className="spacer" />
                                <button className="btn btn-sm btn-ghost" onClick={() => closeDraft(thread.threadId)}>
                                  关闭
                                </button>
                              </div>
                              <TagEditor
                                tags={draft}
                                onChange={(tags) => setDrafts((prev) => ({ ...prev, [thread.threadId]: tags }))}
                              />
                              <div className="row mt-12">
                                <button
                                  className="btn btn-primary btn-sm"
                                  disabled={savingId === thread.threadId}
                                  onClick={() => void saveDraft(thread.threadId)}
                                >
                                  {savingId === thread.threadId ? '保存中…' : '保存'}
                                </button>
                                <button
                                  className="btn btn-sm"
                                  disabled={savingId === thread.threadId}
                                  onClick={() => setDrafts((prev) => ({ ...prev, [thread.threadId]: thread.tags }))}
                                >
                                  还原
                                </button>
                                <span className="hint">
                                  其它串的编辑框不受影响，可以同时改多个；改完一个个保存或点「全部保存」。
                                </span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'users' && (
        <>
          <div className="card mt-12">
            <div className="card-title">
              <h3>用户与权限</h3>
              <span className="hint">用户组决定管理页标签页可见性</span>
            </div>
            {/* 用 form + autoComplete=off，免得浏览器把当前登录的管理员账号填进来 */}
            <form className="row row-wrap form-uniform" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
              <input
                className="input"
                style={{ width: 200 }}
                name="new-account-name"
                autoComplete="off"
                placeholder="用户名"
                value={newUser.username}
                onChange={(e) => setNewUser((prev) => ({ ...prev, username: e.target.value }))}
              />
              <input
                className="input"
                style={{ width: 200 }}
                type="password"
                name="new-account-password"
                autoComplete="new-password"
                placeholder="初始口令"
                value={newUser.password}
                onChange={(e) => setNewUser((prev) => ({ ...prev, password: e.target.value }))}
              />
              <select
                className="select"
                style={{ width: 200 }}
                value={newUser.group}
                onChange={(e) => setNewUser((prev) => ({ ...prev, group: e.target.value }))}
              >
                <option value="user">普通用户</option>
                <option value="editor">编辑</option>
                <option value="admin">管理员</option>
              </select>
              <button
                className="btn btn-primary"
                disabled={!newUser.username || !newUser.password}
                onClick={async () => {
                  const created = await run(() => api.createUser(newUser), `已创建用户 ${newUser.username}`);
                  if (created === undefined) return;
                  setNewUser({ username: '', password: '', group: 'user' });
                  setUsers(await api.fetchUsers());
                }}
              >
                添加用户
              </button>
            </form>
            <p className="hint" style={{ marginBottom: 0 }}>
              口令强度要求与注册一致；也可以继续用邀请码让用户自己注册。
            </p>
          </div>

          <div className="card mt-12">
            <div className="list-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>用户名</th>
                    <th>用户组</th>
                    <th>注册时间</th>
                    <th>最近登录</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.username}>
                      <td className="mono">{u.username}</td>
                      <td>
                        <select
                          className="select"
                          value={u.group}
                          disabled={u.group === 'admin'}
                          title={u.group === 'admin' ? '管理员账号不能被降级' : undefined}
                          onChange={async (e) => {
                            await run(
                              () => api.updateUser(u.username, { group: e.target.value as User['group'] }),
                              `${u.username} 的用户组已更新`,
                            );
                            setUsers(await api.fetchUsers());
                          }}
                        >
                          <option value="admin">管理员</option>
                          <option value="editor">编辑</option>
                          <option value="user">普通用户</option>
                        </select>
                      </td>
                      <td className="nowrap">{fmtDate(u.createdAt)}</td>
                      <td className="nowrap">{u.lastLoginAt ? fmtRelative(u.lastLoginAt) : '从未登录'}</td>
                      <td>
                        {u.banned ? <span className="error-text">已停用</span> : <span className="ok-text">正常</span>}
                      </td>
                      <td>
                        <div className="row">
                          <button
                            className="btn btn-sm"
                            // 管理员账号不能被停用（后端也会拒），已停用的仍可启用
                            disabled={u.group === 'admin' && !u.banned}
                            title={u.group === 'admin' && !u.banned ? '管理员账号不能被停用' : undefined}
                            onClick={async () => {
                              await run(
                                () => api.updateUser(u.username, { banned: !u.banned }),
                                u.banned ? `${u.username} 已启用` : `${u.username} 已停用`,
                              );
                              setUsers(await api.fetchUsers());
                            }}
                          >
                            {u.banned ? '启用用户' : '停用用户'}
                          </button>
                          <button
                            className={`btn btn-sm ${confirmDelete === u.username ? 'btn-danger' : 'btn-ghost'}`}
                            disabled={u.username === session.username}
                            title={u.username === session.username ? '不能删除当前登录的账号' : undefined}
                            onClick={async () => {
                              if (confirmDelete !== u.username) {
                                setConfirmDelete(u.username);
                                return;
                              }
                              setConfirmDelete('');
                              const ok = await run(() => api.deleteUser(u.username), `已删除用户 ${u.username}`);
                              if (ok === undefined) return;
                              setUsers(await api.fetchUsers());
                            }}
                            onBlur={() => setConfirmDelete((prev) => (prev === u.username ? '' : prev))}
                          >
                            {confirmDelete === u.username ? '确认删除' : '删除用户'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">
              停用后该账号无法登录（已登录的会话会在下次校验时失效）；删除会一并清掉该账号的书签、阅读进度、Cookie
              与黑名单。 管理员账号被冻结——既不能停用也不能降级，因此系统里始终至少留有一个管理员。
            </p>
          </div>

          <div className="card mt-12">
            <div className="card-title">
              <h3>邀请码</h3>
              <span className="hint">注册时必填；留空自动生成</span>
            </div>
            <div className="row row-wrap form-uniform">
              <input
                className="input mono"
                style={{ width: 200 }}
                placeholder="自定义邀请码（可留空）"
                value={newInvite.code}
                onChange={(e) => setNewInvite((prev) => ({ ...prev, code: e.target.value }))}
              />
              <label className="switch">
                可注册
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={newInvite.maxUses}
                  onChange={(e) => setNewInvite((prev) => ({ ...prev, maxUses: Number(e.target.value) }))}
                />
                人（0 = 不限）
              </label>
              <label className="switch">
                有效期
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={newInvite.days}
                  onChange={(e) => setNewInvite((prev) => ({ ...prev, days: Number(e.target.value) }))}
                />
                天（0 = 不过期）
              </label>
              <input
                className="input"
                style={{ width: 200 }}
                placeholder="备注（可选）"
                value={newInvite.note}
                onChange={(e) => setNewInvite((prev) => ({ ...prev, note: e.target.value }))}
              />
              <button
                className="btn btn-primary"
                onClick={async () => {
                  const created = await run(() => api.createInvite(newInvite));
                  if (created === undefined) return;
                  notify(`已创建邀请码 ${created.code}`, 'ok');
                  setNewInvite({ code: '', maxUses: 0, days: 0, note: '' });
                  setInvites(await api.fetchInvites());
                }}
              >
                生成邀请码
              </button>
            </div>

            <div className="list-scroll mt-12">
              <table className="table">
                <thead>
                  <tr>
                    <th>邀请码</th>
                    <th>已注册 / 可注册</th>
                    <th>有效期</th>
                    <th>状态</th>
                    <th>备注</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {invites.length === 0 && (
                    <tr>
                      <td colSpan={6} className="empty">
                        还没有邀请码
                      </td>
                    </tr>
                  )}
                  {invites.map((invite) => {
                    const expired = invite.expiresAt > 0 && invite.expiresAt < Math.floor(Date.now() / 1000);
                    const exhausted = invite.maxUses > 0 && invite.usedCount >= invite.maxUses;
                    const state = !invite.enabled ? '已停用' : expired ? '已过期' : exhausted ? '已用完' : '可用';
                    return (
                      <tr key={invite.code}>
                        <td className="mono">{invite.code}</td>
                        <td>
                          {invite.usedCount} / {invite.maxUses || '不限'}
                        </td>
                        <td className="nowrap">{invite.expiresAt ? fmtDate(invite.expiresAt) : '不过期'}</td>
                        <td>
                          <span className={state === '可用' ? 'ok-text' : 'error-text'}>{state}</span>
                        </td>
                        <td>{invite.note || '—'}</td>
                        <td>
                          <div className="row">
                            <button
                              className="btn btn-sm"
                              onClick={async () => {
                                await run(
                                  () => api.updateInvite(invite.code, { enabled: !invite.enabled }),
                                  invite.enabled ? `已停用 ${invite.code}` : `已启用 ${invite.code}`,
                                );
                                setInvites(await api.fetchInvites());
                              }}
                            >
                              {invite.enabled ? '停用' : '启用'}
                            </button>
                            <button
                              className={`btn btn-sm ${confirmDelete === invite.code ? 'btn-danger' : 'btn-ghost'}`}
                              onClick={async () => {
                                if (confirmDelete !== invite.code) {
                                  setConfirmDelete(invite.code);
                                  return;
                                }
                                setConfirmDelete('');
                                const ok = await run(
                                  () => api.deleteInvite(invite.code),
                                  `已删除邀请码 ${invite.code}`,
                                );
                                if (ok === undefined) return;
                                setInvites(await api.fetchInvites());
                              }}
                              onBlur={() => setConfirmDelete((prev) => (prev === invite.code ? '' : prev))}
                            >
                              {confirmDelete === invite.code ? '确认删除' : '删除'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'database' && (
        <div className="card mt-12">
          <div className="card-title">
            <h3>数据库管理</h3>
          </div>
          <div className="row row-wrap">
            {(
              [
                ['backup', '备份数据库'],
                ['restore', '从备份恢复'],
                ['clean', '清理孤立数据'],
              ] as const
            ).map(([op, label]) => (
              <button
                key={op}
                className={`btn ${op === 'restore' ? 'btn-danger' : ''}`}
                onClick={async () => {
                  const text = await run(() => api.dbOperation(op));
                  if (text) setDbResult(text);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {dbResult && <p className="ok-text mt-12">{dbResult}</p>}
          {dbStats && (
            <p className="hint mt-12">
              当前库内：{dbStats.threads} 个串 / {dbStats.posts} 楼 / {dbStats.bodies} 条正文
              {dbStats.backups.length > 0 ? ` · 最近备份 ${dbStats.backups[0]}` : ' · 暂无备份'}
            </p>
          )}
          <p className="hint">恢复与清理会写入系统日志；恢复后需要重启服务才能加载新数据。</p>
        </div>
      )}

      {tab === 'logs' && (
        <div className="card mt-12">
          <div className="card-title">
            <h3>系统日志（{logs.items.length}）</h3>
            <div className="row">
              <select className="select" value={logScope} onChange={(event) => setLogScope(event.target.value)}>
                {LOG_SCOPES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <select className="select" value={logLevel} onChange={(event) => setLogLevel(event.target.value)}>
                {LOG_LEVELS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button className="btn btn-sm" onClick={logs.reload}>
                刷新
              </button>
            </div>
          </div>

          <div className="list-scroll" ref={logs.boxRef} onScroll={logs.onScroll}>
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>级别</th>
                  <th>模块</th>
                  <th>内容</th>
                </tr>
              </thead>
              <tbody>
                {logs.items.map((log, i) => (
                  <tr key={`${log.ts}-${i}`}>
                    <td className="nowrap">{fmtDate(log.ts)}</td>
                    <td>
                      <span
                        className={`status status-${log.level === 'error' ? 'error' : log.level === 'warn' ? 'pending' : 'done'}`}
                      >
                        {log.level}
                      </span>
                    </td>
                    <td title={log.scope}>{SCOPE_TEXT[log.scope] ?? log.scope}</td>
                    <td>{log.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {logs.items.length > 0 && (
              <p className="hint list-more">
                {logs.loading ? '加载中…' : logs.hasMore ? '滚动到底部自动加载更多' : '没有更多了'}
              </p>
            )}
          </div>
          <p className="hint">按时间倒序，每次加载 10 条，滚到框底自动继续。</p>
        </div>
      )}
    </>
  );
}
