import { TASK_STATUS_KIND, TASK_STATUS_TEXT, type DownloadTask } from '../api/types';
import { fmtRelative } from './format';

interface Props {
  tasks: DownloadTask[];
  onCancel: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onOpenThread: (threadId: number) => void;
}

const FINISHED = ['written', 'indexed', 'cancelled', 'images_done'];

/** 按「已用时间 / 已完成页数」粗估剩余时间，只算下载阶段。 */
function estimateRemaining(task: DownloadTask, nowSeconds: number): string | null {
  const running = task.status === 'downloading' || task.status === 'images_running';
  if (!running || task.page <= 0 || task.totalPages <= task.page) return null;
  const elapsed = nowSeconds - task.submittedAt;
  if (elapsed <= 5) return null;
  const secondsPerPage = elapsed / task.page;
  const remaining = Math.round((secondsPerPage * (task.totalPages - task.page)) / 60);
  if (remaining < 1) return '不到 1 分钟';
  if (remaining > 180) return `${Math.round(remaining / 60)} 小时以上`;
  return `约 ${remaining} 分钟`;
}

export function TaskTable({ tasks, onCancel, onRetry, onOpenThread }: Props) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (tasks.length === 0) return <div className="empty">暂无下载任务</div>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>任务</th>
            <th>串号</th>
            <th>来源</th>
            <th>状态</th>
            <th>进度</th>
            <th>提交者</th>
            <th>提交时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const kind = TASK_STATUS_KIND[task.status];
            const isError = kind === 'error';
            return (
              <tr key={task.taskId}>
                <td className="mono">
                  {task.taskId}
                  <div style={{ marginTop: 2 }}>
                    <span className={`badge ${task.kind === 'images' ? '' : 'badge-accent'}`}>
                      {task.kind === 'images' ? '图片' : '下载'}
                    </span>
                  </div>
                </td>
                <td>
                  <button className="link-btn mono" onClick={() => onOpenThread(task.threadId)}>
                    No.{task.threadId}
                  </button>
                  {/* 只在标题确实提供了额外信息时才显示第二行，避免和上面的串号重复 */}
                  {task.kind !== 'images' && task.title && task.title !== `No.${task.threadId}` && (
                    <div className="faint" style={{ fontSize: '0.9em' }}>
                      {task.title}
                    </div>
                  )}
                </td>
                <td>{task.source}</td>
                <td>
                  <span className={`status status-${kind}`}>{TASK_STATUS_TEXT[task.status]}</span>
                  {task.status === 'queued' && task.ahead > 0 && (
                    <div className="faint" style={{ fontSize: '0.85em' }}>
                      前面还有 {task.ahead} 个任务
                    </div>
                  )}
                  {task.message && (
                    <div className={isError ? 'error-text' : 'hint'} style={{ maxWidth: 240 }}>
                      {task.message}
                    </div>
                  )}
                </td>
                <td>
                  {task.totalPages > 0 ? (
                    <>
                      <div className="row" style={{ gap: 6 }}>
                        <div className="progress">
                          <i
                            style={{
                              width: `${Math.min(100, Math.round((task.page / task.totalPages) * 100))}%`,
                            }}
                          />
                        </div>
                        <span className="faint nowrap">
                          {task.page}/{task.totalPages} {task.kind === 'images' ? '张' : '页'}
                        </span>
                      </div>
                      {task.written ? <div className="faint">已入库 {task.written} 条</div> : null}
                      {estimateRemaining(task, nowSeconds) && (
                        <div className="faint">剩余 {estimateRemaining(task, nowSeconds)}（仅下载）</div>
                      )}
                    </>
                  ) : (
                    <span className="faint">等待中</span>
                  )}
                </td>
                <td>{task.submittedBy}</td>
                <td className="nowrap">{fmtRelative(task.submittedAt)}</td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    {isError ? (
                      <button className="btn btn-sm" onClick={() => onRetry(task.taskId)}>
                        重新提交
                      </button>
                    ) : (
                      <button
                        className="btn btn-sm"
                        disabled={FINISHED.includes(task.status) || task.status === 'cancelling'}
                        onClick={() => onCancel(task.taskId)}
                      >
                        取消
                      </button>
                    )}
                    {['written', 'indexed', 'images_done'].includes(task.status) && (
                      <button className="btn btn-sm btn-ghost" onClick={() => onOpenThread(task.threadId)}>
                        去阅读
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
