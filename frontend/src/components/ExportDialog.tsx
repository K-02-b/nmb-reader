import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import { useApp } from '../state/AppContext';

const QUALITY_LABEL: Record<'high' | 'medium' | 'low', string> = {
  high: '高（长边 1600px）',
  medium: '中（长边 1000px）',
  low: '低（长边 640px）',
};

/**
 * 导出弹框：选格式、是否带图、图片质量。
 * 「是否带图 / 质量」会写进用户设置，下次打开保持上次的选择。
 */
export function ExportDialog({ threadId, title, onClose }: { threadId: number; title: string; onClose: () => void }) {
  const { settings, saveSettings, notify } = useApp();
  const [format, setFormat] = useState<'docx' | 'pdf'>('docx');
  const [images, setImages] = useState(settings.exportImages);
  const [quality, setQuality] = useState<'high' | 'medium' | 'low'>(settings.exportQuality);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const start = async () => {
    // 记住这次的选择
    saveSettings({ exportImages: images, exportQuality: quality });
    setBusy(true);
    try {
      await api.exportThread(threadId, format, images, quality);
      notify(`已导出 No.${threadId}.${format}`, 'ok');
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : '导出失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onClick={() => !busy && onClose()} role="presentation">
      <div className="modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="导出串">
        <div className="modal-head">
          <span className="badge badge-accent">导出</span>
          <span className="faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </span>
          <span className="spacer" />
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="modal-body">
          <div className="field">
            <label>格式</label>
            <div className="tabs-inline" style={{ margin: 0 }}>
              <button className={format === 'docx' ? 'active' : ''} onClick={() => setFormat('docx')}>
                Word（.docx）
              </button>
              <button className={format === 'pdf' ? 'active' : ''} onClick={() => setFormat('pdf')}>
                PDF
              </button>
            </div>
          </div>

          <label className="switch" style={{ marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={images}
              onChange={(event) => {
                setImages(event.target.checked);
                saveSettings({ exportImages: event.target.checked });
              }}
            />
            内嵌图片（不勾选只导出文字，图片保留图床链接）
          </label>

          <div className="field">
            <label>图片质量</label>
            <select
              className="select"
              value={quality}
              disabled={!images}
              onChange={(event) => {
                const next = event.target.value as 'high' | 'medium' | 'low';
                setQuality(next);
                saveSettings({ exportQuality: next });
              }}
            >
              {(Object.keys(QUALITY_LABEL) as Array<'high' | 'medium' | 'low'>).map((key) => (
                <option key={key} value={key}>
                  {QUALITY_LABEL[key]}
                </option>
              ))}
            </select>
          </div>

          <p className="hint" style={{ marginBottom: 0 }}>
            选择会被记住（存在账号里，换设备也是同一份），下次导出沿用。带图导出会先从本地图片缓存取，
            缺失的才回源图床，长串可能需要等一会。
          </p>
        </div>

        <div className="modal-foot">
          <span className="hint">No.{threadId}</span>
          <span className="spacer" />
          <button className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void start()}>
            {busy ? '导出中…' : '开始导出'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
