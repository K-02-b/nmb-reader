import { TASK_STATUS_KIND, TASK_STATUS_TEXT, type DownloadTask } from '../../api/types';
import { fmtRelative } from '../../components/format';

interface Props {
  tasks: DownloadTask[];
  onCancel: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onOpenThread: (threadId: number) => void;
}

/** 已经结束、点了取消也没意义的状态 */
const FINISHED = ['written', 'indexed', 'cancelled', 'images_done'];
/** 这两种状态才有「去阅读」的入口（数据确实已入库） */
const READABLE = ['written', 'indexed', 'images_done'];

/**
 * 按「已用时间 / 已完成页数」粗估剩余时间，只算下载阶段。
 * 与桌面端 TaskTable 同一套算法：手机端要单独维护一份，但估值口径必须一致。
 */
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

/** 宽表格在手机上没法用，这里换成竖向卡片：一屏一条，动作按钮放到底部。 */
export function MobileTaskList({ tasks, onCancel, onRetry, onOpenThread }: Props) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (tasks.length === 0) return <div className="empty">暂无下载任务</div>;

  return (
    <>
      {tasks.map((task) => {
        const kind = TASK_STATUS_KIND[task.status];
        const isError = kind === 'error';
        const done = FINISHED.includes(task.status);
        const estimate = estimateRemaining(task, nowSeconds);
        const percent = task.totalPages > 0 ? Math.min(100, Math.round((task.page / task.totalPages) * 100)) : 0;
        // 标题常常就是「No.串号」，与上面那行重复时不再显示
        const showTitle = task.kind !== 'images' && !!task.title && task.title !== `No.${task.threadId}`;
        return (
          <div className="m-item" key={task.taskId}>
            <div className="m-item-title">
              <span className="mono nowrap">{task.taskId}</span>
              <span className={`badge ${task.kind === 'images' ? '' : 'badge-accent'}`}>
                {task.kind === 'images' ? '图片' : '下载'}
              </span>
              <span className="spacer" />
              <span className={`status status-${kind}`}>{TASK_STATUS_TEXT[task.status]}</span>
            </div>

            <div className="m-item-meta">
              <button className="link-btn mono" onClick={() => onOpenThread(task.threadId)}>
                No.{task.threadId}
              </button>
              <span className="faint">{task.source}</span>
              <span className="faint nowrap">{fmtRelative(task.submittedAt)}</span>
              {task.submittedBy && <span className="faint nowrap">提交者 {task.submittedBy}</span>}
            </div>
            {showTitle && <div className="faint">{task.title}</div>}

            {task.totalPages > 0 ? (
              <div className="row" style={{ gap: 8 }}>
                <div className="progress">
                  <i style={{ width: `${percent}%` }} />
                </div>
                <span className="faint nowrap">
                  {task.page}/{task.totalPages} {task.kind === 'images' ? '张' : '页'}
                </span>
              </div>
            ) : (
              <div className="faint">等待中</div>
            )}
            {!!task.written && <div className="faint">已入库 {task.written} 条</div>}
            {estimate && <div className="faint">剩余 {estimate}（仅下载）</div>}

            {task.status === 'queued' && task.ahead > 0 && <div className="faint">前面还有 {task.ahead} 个任务</div>}
            {task.message && <div className={isError ? 'error-text' : 'hint'}>{task.message}</div>}

            <div className="m-actions">
              {isError ? (
                <button className="btn btn-sm" onClick={() => onRetry(task.taskId)}>
                  重新提交
                </button>
              ) : (
                <button
                  className="btn btn-sm"
                  // 已经结束或正在取消的任务再点取消没有意义
                  disabled={done || task.status === 'cancelling'}
                  onClick={() => onCancel(task.taskId)}
                >
                  取消
                </button>
              )}
              {READABLE.includes(task.status) && (
                <button className="btn btn-sm btn-ghost" onClick={() => onOpenThread(task.threadId)}>
                  去阅读
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
