import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { CookieStatus } from '../api/types';
import { useApp } from '../state/AppContext';
import { fmtRelative } from './format';

/** Cookie 面板：服务端只回状态不回显内容，要改就整段重新粘贴。 */
export function CookiePanel() {
  const { notify, run } = useApp();
  const [status, setStatus] = useState<CookieStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const next = await api.fetchCookieStatus().catch(() => null);
    setStatus(next);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    const value = draft.trim();
    if (!value) {
      notify('先粘贴 Cookie 再保存', 'error');
      return;
    }
    setBusy(true);
    const next = await run(() => api.saveCookie(value));
    setBusy(false);
    if (next) {
      setStatus(next);
      setDraft('');
      notify(
        next.verifyOk ? '已保存，校验通过' : `已保存，但校验未通过：${next.lastError ?? ''}`,
        next.verifyOk ? 'ok' : 'error',
      );
    }
  };

  const verify = async () => {
    setBusy(true);
    const next = await run(() => api.verifyCookie());
    setBusy(false);
    if (next) setStatus(next);
  };

  /** 二维码导入：服务端解码后加密保存并校验 */
  const importQr = async (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      notify('请上传二维码图片（PNG/JPG）', 'error');
      return;
    }
    setBusy(true);
    const next = await run(() => api.importCookieFromQrcode(file));
    setBusy(false);
    if (next) {
      setStatus(next);
      setDraft('');
      notify(
        next.verifyOk
          ? '二维码解析成功，Cookie 已保存并校验通过'
          : `二维码已解析，但校验未通过：${next.lastError ?? ''}`,
        next.verifyOk ? 'ok' : 'error',
      );
    }
  };

  const clear = async () => {
    setBusy(true);
    const next = await run(() => api.clearCookie(), '已清除');
    setBusy(false);
    if (next) setStatus(next);
  };

  const badge = () => {
    if (!status?.configured) return <span className="badge">未配置</span>;
    if (status.source === 'server') return <span className="badge">服务器级兜底</span>;
    if (status.verifyOk === true) return <span className="badge badge-accent">校验通过</span>;
    if (status.verifyOk === false)
      return (
        <span className="badge" style={{ color: 'var(--danger)' }}>
          校验未通过
        </span>
      );
    return <span className="badge">已保存（未校验）</span>;
  };

  return (
    <div className="card mt-12">
      <div className="card-title">
        <h3>Cookie</h3>
        {badge()}
      </div>

      <p className="hint" style={{ marginTop: 0 }}>
        只保存 <span className="mono">userhash</span> 即可。Cookie 加密存在服务端，只用于该账号提交的下载任务，
        接口不回显内容（要改就重新粘贴一次）。
      </p>

      <div className="table-wrap">
        <table className="table">
          <tbody>
            <tr>
              <th>状态</th>
              <td>
                {status?.configured
                  ? status.source === 'user'
                    ? '已导入你自己的 Cookie'
                    : '未导入，但服务器配置了兜底 Cookie'
                  : '未导入'}
              </td>
            </tr>
            <tr>
              <th>更新时间</th>
              <td>{status?.updatedAt ? fmtRelative(status.updatedAt) : '—'}</td>
            </tr>
            <tr>
              <th>最近校验</th>
              <td>
                {status?.verifiedAt ? fmtRelative(status.verifiedAt) : '—'}
                {status?.lastError ? <span className="error-text">（{status.lastError}）</span> : null}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="field mt-12">
        <label htmlFor="cookie-input">粘贴 Cookie（认 userhash=…，整段粘进来也行）</label>
        <textarea
          id="cookie-input"
          className="textarea mono"
          style={{ minHeight: 96 }}
          placeholder="userhash=..."
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </div>

      {/* 用 label 包住 input：点框里任何地方都能选文件 */}
      <label
        className="dropzone"
        style={{
          borderColor: dragging ? 'var(--accent)' : 'var(--border)',
          background: dragging ? 'var(--surface-2)' : 'transparent',
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void importQr(event.dataTransfer.files?.[0]);
        }}
        onPaste={(event) => {
          const item = [...event.clipboardData.items].find((i) => i.type.startsWith('image/'));
          if (item) void importQr(item.getAsFile());
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click();
        }}
        tabIndex={0}
      >
        <span className="hint">扫码导入：点这里选二维码图片，或把图片拖进来（也可以直接 Ctrl+V 粘贴截图）</span>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => void importQr(event.target.files?.[0])}
        />
      </label>

      <div className="row row-wrap">
        <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
          {busy ? '处理中…' : '保存并校验'}
        </button>
        <button className="btn" disabled={busy || !status?.configured} onClick={() => void verify()}>
          重新校验
        </button>
        <button className="btn btn-danger" disabled={busy || !status?.configured} onClick={() => void clear()}>
          清除
        </button>
      </div>

      <details className="mt-12">
        <summary className="hint" style={{ cursor: 'pointer' }}>
          怎么拿到这段 Cookie？
        </summary>
        <ol className="hint">
          <li>浏览器里登录 X岛，按 F12 打开开发者工具</li>
          <li>切到 Network（网络）面板，刷新页面，随便点一个请求</li>
          <li>
            在 Request Headers 里找到 <span className="mono">Cookie:</span>，把整行值复制过来
          </li>
          <li>建议用专用小号；Cookie 等同于账号登录态，别分享给别人</li>
        </ol>
        <p className="hint">
          如果你是从手机端/工具导出的<strong>二维码</strong>，直接用上面的「扫码导入」更省事： 服务端解码出 Cookie
          后加密保存，同样不回显。兼容两种二维码内容：
          <span className="mono">{'{"cookie": "...", "name": "..."}'}</span> 或裸 Cookie 字符串。
        </p>
        <p className="hint">
          校验方式：服务端拿它访问受限板块（默认「速报2」）。匿名访问只能拿到一个没有串列表的提示页，
          所以能列出串就说明登录态有效。
        </p>
      </details>
    </div>
  );
}
