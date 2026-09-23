import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ServerMeta } from '../api/types';
import { useApp } from '../state/AppContext';

/** 下载页数上限与并发度：用户级设置，只影响自己提交的任务；服务器侧有硬上限。 */
export function DownloadLimits() {
  const { settings, saveSettings, notify } = useApp();
  const [meta, setMeta] = useState<ServerMeta | null>(null);
  const [pagesDraft, setPagesDraft] = useState('');
  const [workersDraft, setWorkersDraft] = useState('');

  useEffect(() => {
    void api
      .fetchMeta()
      .then(setMeta)
      .catch(() => setMeta(null));
  }, []);

  useEffect(() => {
    setPagesDraft(settings.fetchMaxPages == null ? '' : String(settings.fetchMaxPages));
    setWorkersDraft(settings.fetchConcurrency == null ? '' : String(settings.fetchConcurrency));
  }, [settings.fetchMaxPages, settings.fetchConcurrency]);

  const pagesDefault = meta?.fetchMaxPagesDefault ?? 2000;
  const pagesCeiling = meta?.fetchMaxPagesCeiling ?? 20000;
  const workersDefault = meta?.fetchConcurrencyDefault ?? 4;
  const workersCeiling = meta?.fetchConcurrencyCeiling ?? 8;

  const effectivePages = settings.fetchMaxPages ?? pagesDefault;
  const effectiveWorkers = settings.fetchConcurrency ?? workersDefault;

  const saveNumbers = () => {
    const patch: { fetchMaxPages?: number | null; fetchConcurrency?: number | null } = {};

    const pages = pagesDraft.trim();
    if (!pages) patch.fetchMaxPages = null;
    else if (!Number.isFinite(Number(pages)) || Number(pages) < 1) {
      notify('页数上限要填大于 0 的整数', 'error');
      return;
    } else patch.fetchMaxPages = Math.min(Math.floor(Number(pages)), pagesCeiling);

    const workers = workersDraft.trim();
    if (!workers) patch.fetchConcurrency = null;
    else if (!Number.isFinite(Number(workers)) || Number(workers) < 1) {
      notify('并发度要填大于 0 的整数', 'error');
      return;
    } else patch.fetchConcurrency = Math.min(Math.floor(Number(workers)), workersCeiling);

    saveSettings(patch);
    notify(
      `已保存：上限 ${patch.fetchMaxPages ?? pagesDefault} 页、并发 ${patch.fetchConcurrency ?? workersDefault}`,
      'ok',
    );
  };

  return (
    <div className="card mt-12">
      <div className="card-title">
        <h3>下载设置</h3>
        <span className="badge">
          上限 {effectivePages} 页 · 并发 {effectiveWorkers}
        </span>
      </div>

      <div className="row row-wrap form-uniform">
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="fetch-max-pages">页数上限</label>
          <input
            id="fetch-max-pages"
            className="input mono"
            style={{ maxWidth: 240 }}
            inputMode="numeric"
            placeholder={`留空 = 默认 ${pagesDefault} 页`}
            value={pagesDraft}
            onChange={(event) => setPagesDraft(event.target.value.replace(/[^0-9]/g, ''))}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="fetch-concurrency">并发度</label>
          <input
            id="fetch-concurrency"
            className="input mono"
            style={{ maxWidth: 200 }}
            inputMode="numeric"
            placeholder={`留空 = 默认 ${workersDefault}`}
            value={workersDraft}
            onChange={(event) => setWorkersDraft(event.target.value.replace(/[^0-9]/g, ''))}
          />
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={saveNumbers}>
            保存
          </button>
          <button
            className="btn"
            disabled={settings.fetchMaxPages == null && settings.fetchConcurrency == null}
            onClick={() => {
              setPagesDraft('');
              setWorkersDraft('');
              saveSettings({ fetchMaxPages: null, fetchConcurrency: null });
              notify(`已恢复服务器默认（${pagesDefault} 页 / 并发 ${workersDefault}）`, 'ok');
            }}
          >
            恢复默认
          </button>
        </div>
      </div>

      <p className="hint" style={{ marginBottom: 0 }}>
        服务器默认 {pagesDefault} 页 / 并发 {workersDefault}；上限 {pagesCeiling} 页 / 并发 {workersCeiling}。 由于
        X岛存在 429 速率限制，高并发无法带来太多提升。
        {meta && !meta.imagesEnabled && ' 当前服务器关闭了图片本地化，下载会更快、更省空间。'}
      </p>
    </div>
  );
}
