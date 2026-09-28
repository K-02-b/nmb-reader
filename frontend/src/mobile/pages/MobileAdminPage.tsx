import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import {
  TASK_STATUS_GROUP,
  type CookieStatus,
  type DbStats,
  type DownloadTask,
  type Invite,
  type LogEntry,
  type Permission,
  type Tag,
  type Thread,
  type User,
} from '../../api/types';
import { useApp } from '../../state/AppContext';
import { useTagVocab } from '../../state/TagVocabContext';
import { TagEditor } from '../../components/TagEditor';
import { fmtDate, fmtRelative, groupText, parseThreadId } from '../../components/format';
import { useIncrementalList } from '../../components/useIncrementalList';
import { MobileTaskList } from '../components/MobileTaskList';

type TabKey = 'submit' | 'tasks' | 'threads' | 'users' | 'database' | 'logs';

/** 与桌面端 AdminPage 的 TABS 完全一致：怎么过滤、怎么排序都必须对齐 */
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

/** 标签类型 → .tag-* 的类名，和桌面端同一份映射 */
const tagClass = (type: Tag['tagType']) => `tag tag-${type}`;

export function MobileAdminPage() {
  const { session, run, notify, tasks: liveTasks, tasksLive, refreshTasks, mergeTaskList } = useApp();
  const { refresh: refreshVocab } = useTagVocab();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const allowed = useMemo(() => TABS.filter((t) => session?.permissions.includes(t.permission)), [session]);
  const [tab, setTab] = useState<TabKey>(() => {
    // 阅读页/目录页的「管理」按钮带过来的 ?tab=threads&thread=<串号>
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

  // 任务列表来自 AppContext 里那条 SSE（服务端有变化才推），这里只做时间/状态筛选与滚动分页，
  // 不再定时 fetch
  const visibleTasks = useMemo(() => {
    const since = taskDays > 0 ? Math.floor(Date.now() / 1000) - taskDays * 86400 : 0;
    return liveTasks.filter(
      (task) =>
        (taskDays === 0 || task.submittedAt >= since) &&
        (taskStatus === '' || TASK_STATUS_GROUP[task.status] === taskStatus),
    );
  }, [liveTasks, taskDays, taskStatus]);
  const tasks = useIncrementalList<DownloadTask>({
    source: visibleTasks,
    resetKey: `${taskDays}|${taskStatus}`,
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

  // 从阅读页/目录页「管理」跳进来：定位到该串、展开标签编辑框并滚动过去
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

  const closeDraft = (threadIdValue: number) =>
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[threadIdValue];
      return next;
    });

  /** 保存单个串的标签；用草稿更新本地行，避免整表重拉 */
  const saveDraft = async (threadIdValue: number) => {
    const tags = drafts[threadIdValue];
    if (!tags) return;
    setSavingId(threadIdValue);
    const ok = await run(() => api.updateThreadTags(threadIdValue, tags));
    setSavingId(null);
    if (ok === undefined) return;
    setThreads((prev) => prev.map((item) => (item.threadId === threadIdValue ? { ...item, tags } : item)));
    closeDraft(threadIdValue);
    // 刷新词汇表，让别处也能选到新标签
    void refreshVocab();
  };

  /** 逐个保存；单个失败不影响其它 */
  const saveAllDrafts = async () => {
    const ids = Object.keys(drafts).map(Number);
    let failed = 0;
    for (const id of ids) {
      const tags = drafts[id];
      const ok = await run(() => api.updateThreadTags(id, tags));
      if (ok === undefined) {
        failed += 1;
        continue;
      }
      setThreads((prev) => prev.map((item) => (item.threadId === id ? { ...item, tags } : item)));
      closeDraft(id);
    }
    notify(failed === 0 ? `已保存 ${ids.length} 个串的标签` : `保存完成，${failed} 个失败`, failed ? 'error' : 'ok');
    if (failed < ids.length) void refreshVocab();
  };

  const draftCount = Object.keys(drafts).length;

  if (!session) return null;

  if (allowed.length === 0) {
    return (
      <div className="m-page">
        <div className="card">
          <h3>没有可用的管理功能</h3>
          <p className="hint">当前用户组为「{groupText(session.group)}」，未分配任何管理权限。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="m-page">
      <div className="card">
        <div className="card-title">
          <h3>管理页</h3>
          <span className="hint">
            {session.username} · {groupText(session.group)} · 只显示当前账号有权使用的功能
          </span>
        </div>
        {/* 手机上六个标签一行放不下：横向滚动，不换行 */}
        <div className="m-seg">
          {allowed.map((t) => (
            <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
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
          <div className="field">
            <label>串号</label>
            <input
              className="input mono"
              inputMode="numeric"
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
          {cookieStatus && !cookieStatus.configured && (
            <p className="error-text">
              你还没有导入 Cookie，提交的下载任务会失败。
              <button className="link-btn" onClick={() => navigate('/m/settings')}>
                去「设置 → Cookie」导入
              </button>
            </p>
          )}
          {cookieStatus?.configured && (
            <p className="hint">
              Cookie：{cookieStatus.source === 'user' ? '已导入' : '使用服务器级兜底'}
              {cookieStatus.verifyOk === false ? `（上次校验失败：${cookieStatus.lastError ?? ''}）` : ''}
            </p>
          )}
          <div className="m-actions">
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
                  // 立刻上屏，不用等下一次推送
                  mergeTaskList([task]);
                }
              }}
            >
              提交申请
            </button>
            <button className="btn" onClick={() => void refreshTasks()}>
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
            <span className={tasksLive ? 'hint' : 'error-text'}>
              {tasksLive ? '实时推送' : '推送已断开，按 30 秒兜底刷新'}
            </span>
          </div>
          <div className="row row-wrap">
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
            <button className="btn btn-sm" onClick={() => void refreshTasks()}>
              刷新
            </button>
          </div>

          <div className="m-scroll" ref={tasks.boxRef} onScroll={tasks.onScroll}>
            <MobileTaskList
              tasks={tasks.items}
              onCancel={(id) => void run(() => api.cancelTask(id), '已请求取消').then((t) => t && mergeTaskList([t]))}
              onRetry={(id) => void run(() => api.retryTask(id), '已重新提交').then((t) => t && mergeTaskList([t]))}
              onOpenThread={(id) => navigate(`/m/t/${id}`)}
            />
            {tasks.items.length > 0 && (
              <p className="hint list-more">
                {tasks.loading ? '加载中…' : tasks.hasMore ? '滚动到底部自动加载更多' : '没有更多了'}
              </p>
            )}
          </div>
          <p className="hint">按提交时间倒序，每次显示 10 条，滚到框底自动继续；进度由服务端实时推送。</p>
        </div>
      )}

      {tab === 'threads' && (
        <div className="card mt-12">
          <div className="card-title">
            <h3>串信息与标签（{threads.length}）</h3>
            <span className="hint">类型/系列/状态/卷次每串只能有一个</span>
          </div>

          <div className="field">
            <label>串号（可只填片段）</label>
            <input
              className="input mono"
              inputMode="numeric"
              placeholder="例如 5977"
              value={threadFilter.threadId}
              onChange={(event) =>
                setThreadFilter((prev) => ({ ...prev, threadId: event.target.value.replace(/[^0-9]/g, '') }))
              }
              onKeyDown={(event) => event.key === 'Enter' && setAppliedFilter(threadFilter)}
            />
          </div>
          <div className="field">
            <label>关键词</label>
            <input
              className="input"
              placeholder="标题 / 标签关键词"
              value={threadFilter.keyword}
              onChange={(event) => setThreadFilter((prev) => ({ ...prev, keyword: event.target.value }))}
              onKeyDown={(event) => event.key === 'Enter' && setAppliedFilter(threadFilter)}
            />
          </div>
          <div className="m-actions">
            <button className="btn btn-primary" onClick={() => setAppliedFilter(threadFilter)}>
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
          </div>

          {draftCount > 0 && (
            <div className="m-actions">
              <span className="badge badge-accent">正在编辑 {draftCount} 个串</span>
              <button className="btn btn-primary btn-sm" onClick={() => void saveAllDrafts()}>
                全部保存
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => setDrafts({})}>
                全部关闭
              </button>
            </div>
          )}

          <div className="m-scroll">
            {threads.length === 0 && <div className="empty">没有匹配的串</div>}
            {threads.map((thread) => {
              const draft = drafts[thread.threadId];
              const open = draft !== undefined;
              return (
                <div
                  key={thread.threadId}
                  id={`admin-thread-${thread.threadId}`}
                  className={`m-item${focusedId === thread.threadId ? ' row-focus' : ''}`}
                >
                  <div className="m-item-title">
                    <span className="mono">No.{thread.threadId}</span>
                    <span className="spacer" />
                    <span className="faint nowrap">{fmtRelative(thread.updatedAt)}</span>
                  </div>
                  <div className="m-item-meta">
                    <span className="nowrap">{thread.replies} 回复</span>
                    <span className="nowrap">{thread.replyCount} 楼</span>
                    {thread.pageCount > 0 && <span className="nowrap">{thread.pageCount} 页</span>}
                  </div>
                  <div>{thread.title}</div>
                  <div className="row row-wrap">
                    {thread.tags.length === 0 && <span className="hint">无标签</span>}
                    {thread.tags.map((tag) => (
                      <span key={`${tag.tagType}-${tag.tagName}`} className={tagClass(tag.tagType)}>
                        {tag.tagName}
                      </span>
                    ))}
                  </div>

                  <div className="m-actions">
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
                    <button className="btn btn-sm btn-ghost" onClick={() => navigate(`/m/t/${thread.threadId}`)}>
                      阅读
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={async () => {
                        await run(() => api.deleteThread(thread.threadId), `已删除 No.${thread.threadId}`);
                        closeDraft(thread.threadId);
                        void loadThreads();
                      }}
                    >
                      删除
                    </button>
                  </div>

                  {/* 编辑框就地展开在卡片里，别的串不受影响 */}
                  {open && (
                    <div className="mt-12">
                      <div className="row" style={{ marginBottom: 10 }}>
                        <strong>编辑 No.{thread.threadId}</strong>
                        <span className="spacer" />
                        <button className="btn btn-sm btn-ghost" onClick={() => closeDraft(thread.threadId)}>
                          关闭
                        </button>
                      </div>
                      <TagEditor
                        tags={draft}
                        onChange={(tags) => setDrafts((prev) => ({ ...prev, [thread.threadId]: tags }))}
                      />
                      <div className="m-actions">
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
                      </div>
                      <p className="hint">可以同时改多个串，改完一个个保存或点「全部保存」。</p>
                    </div>
                  )}
                </div>
              );
            })}
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
            <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
              <div className="field">
                <label>用户名</label>
                <input
                  className="input"
                  name="new-account-name"
                  autoComplete="off"
                  placeholder="新账号用户名"
                  value={newUser.username}
                  onChange={(e) => setNewUser((prev) => ({ ...prev, username: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>初始口令</label>
                <input
                  className="input"
                  type="password"
                  name="new-account-password"
                  autoComplete="new-password"
                  placeholder="口令强度要求与注册一致"
                  value={newUser.password}
                  onChange={(e) => setNewUser((prev) => ({ ...prev, password: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>用户组</label>
                <select
                  className="select"
                  value={newUser.group}
                  onChange={(e) => setNewUser((prev) => ({ ...prev, group: e.target.value }))}
                >
                  <option value="user">普通用户</option>
                  <option value="editor">编辑</option>
                  <option value="admin">管理员</option>
                </select>
              </div>
              <div className="m-actions">
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
              </div>
            </form>
            <p className="hint">口令强度要求与注册一致；也可以继续用邀请码让用户自己注册。</p>
          </div>

          <div className="card mt-12">
            <div className="card-title">
              <h3>已有用户（{users.length}）</h3>
            </div>
            <div className="list-scroll">
              {users.map((u) => (
                <div className="m-item" key={u.username}>
                  <div className="m-item-title">
                    <span className="mono">{u.username}</span>
                    <span className="spacer" />
                    {u.banned ? <span className="error-text">已停用</span> : <span className="ok-text">正常</span>}
                  </div>
                  <div className="m-item-meta">
                    <span className="nowrap">注册 {fmtDate(u.createdAt)}</span>
                    <span className="nowrap">
                      {u.lastLoginAt ? `最近登录 ${fmtRelative(u.lastLoginAt)}` : '从未登录'}
                    </span>
                  </div>
                  <div className="field">
                    <label>用户组</label>
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
                  </div>
                  <div className="m-actions">
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
                </div>
              ))}
            </div>
            <p className="hint">
              停用后该账号无法登录（已登录的会话会在下次校验时失效）；删除会一并清掉该账号的书签、阅读进度、Cookie
              与黑名单。管理员账号被冻结——既不能停用也不能降级，因此系统里始终至少留有一个管理员。
            </p>
          </div>

          <div className="card mt-12">
            <div className="card-title">
              <h3>邀请码</h3>
              <span className="hint">注册时必填；留空自动生成</span>
            </div>
            <div className="field">
              <label>自定义邀请码（可留空）</label>
              <input
                className="input mono"
                placeholder="留空自动生成"
                value={newInvite.code}
                onChange={(e) => setNewInvite((prev) => ({ ...prev, code: e.target.value }))}
              />
            </div>
            <div className="grid-2">
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
            </div>
            <div className="field">
              <label>备注（可选）</label>
              <input
                className="input"
                placeholder="备注"
                value={newInvite.note}
                onChange={(e) => setNewInvite((prev) => ({ ...prev, note: e.target.value }))}
              />
            </div>
            <div className="m-actions">
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
              {invites.length === 0 && <div className="empty">还没有邀请码</div>}
              {invites.map((invite) => {
                const expired = invite.expiresAt > 0 && invite.expiresAt < Math.floor(Date.now() / 1000);
                const exhausted = invite.maxUses > 0 && invite.usedCount >= invite.maxUses;
                const state = !invite.enabled ? '已停用' : expired ? '已过期' : exhausted ? '已用完' : '可用';
                return (
                  <div className="m-item" key={invite.code}>
                    <div className="m-item-title">
                      <span className="mono">{invite.code}</span>
                      <span className="spacer" />
                      <span className={state === '可用' ? 'ok-text' : 'error-text'}>{state}</span>
                    </div>
                    <div className="m-item-meta">
                      <span className="nowrap">
                        已注册 {invite.usedCount} / {invite.maxUses || '不限'}
                      </span>
                      <span className="nowrap">{invite.expiresAt ? fmtDate(invite.expiresAt) : '不过期'}</span>
                    </div>
                    <div className="faint">{invite.note || '—'}</div>
                    <div className="m-actions">
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
                          const ok = await run(() => api.deleteInvite(invite.code), `已删除邀请码 ${invite.code}`);
                          if (ok === undefined) return;
                          setInvites(await api.fetchInvites());
                        }}
                        onBlur={() => setConfirmDelete((prev) => (prev === invite.code ? '' : prev))}
                      >
                        {confirmDelete === invite.code ? '确认删除' : '删除'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {tab === 'database' && (
        <div className="card mt-12">
          <div className="card-title">
            <h3>数据库管理</h3>
          </div>
          <div className="m-actions">
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
          </div>
          <div className="row row-wrap">
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

          <div className="m-scroll" ref={logs.boxRef} onScroll={logs.onScroll}>
            {logs.items.map((log, i) => (
              <div className="m-item" key={`${log.ts}-${i}`}>
                <div className="m-item-title">
                  <span
                    className={`status status-${log.level === 'error' ? 'error' : log.level === 'warn' ? 'pending' : 'done'}`}
                  >
                    {log.level}
                  </span>
                  <span className="faint" title={log.scope}>
                    {SCOPE_TEXT[log.scope] ?? log.scope}
                  </span>
                  <span className="spacer" />
                  <span className="faint nowrap">{fmtDate(log.ts)}</span>
                </div>
                <div>{log.message}</div>
              </div>
            ))}
            {logs.items.length > 0 && (
              <p className="hint list-more">
                {logs.loading ? '加载中…' : logs.hasMore ? '滚动到底部自动加载更多' : '没有更多了'}
              </p>
            )}
          </div>
          <p className="hint">按时间倒序，每次加载 10 条，滚到框底自动继续。</p>
        </div>
      )}
    </div>
  );
}
