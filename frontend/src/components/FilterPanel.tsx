import type { TagVocabulary, ThreadQuery } from '../api/types';

/**
 * 目录筛选面板：原来贴在目录页左侧的那套筛选条件，搬进右侧工具栏。
 *
 * 只负责收集条件，发请求、记状态都归目录页。
 */
export function FilterPanel({
  query,
  vocab,
  onChange,
  onReset,
}: {
  query: ThreadQuery;
  vocab: TagVocabulary;
  onChange: (patch: Partial<ThreadQuery>) => void;
  onReset: () => void;
}) {
  return (
    <div className="tools-body tools-form-body">
      <div className="field">
        <label htmlFor="filter-keyword">关键词（标题 / 摘要 / 标签）</label>
        <input
          id="filter-keyword"
          className="input"
          value={query.keyword ?? ''}
          onChange={(e) => onChange({ keyword: e.target.value })}
          placeholder="标题、摘要或标签里的片段"
        />
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="filter-thread">串号</label>
          <input
            id="filter-thread"
            className="input mono"
            value={query.threadId ?? ''}
            onChange={(e) => onChange({ threadId: e.target.value ? Number(e.target.value) : null })}
            placeholder="可只填片段"
          />
        </div>
        <div className="field">
          <label htmlFor="filter-board">板块</label>
          <input
            id="filter-board"
            className="input"
            value={query.board ?? ''}
            onChange={(e) => onChange({ board: e.target.value || null })}
            placeholder="例如 创作茶水间"
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="filter-cookie">Po 饼干</label>
        <input
          id="filter-cookie"
          className="input mono"
          value={query.cookie ?? ''}
          onChange={(e) => onChange({ cookie: e.target.value })}
          placeholder="例如 ypGUmaX"
        />
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="filter-genre">类型</label>
          <select
            id="filter-genre"
            className="select"
            value={query.genre ?? ''}
            onChange={(e) => onChange({ genre: e.target.value })}
          >
            <option value="">全部</option>
            {vocab.genre.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-series">系列</label>
          <select
            id="filter-series"
            className="select"
            value={query.series ?? ''}
            onChange={(e) => onChange({ series: e.target.value })}
          >
            <option value="">全部</option>
            {vocab.series.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="filter-status">状态</label>
          <select
            id="filter-status"
            className="select"
            value={query.status ?? ''}
            onChange={(e) => onChange({ status: e.target.value })}
          >
            <option value="">全部</option>
            {vocab.status.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-sort">排序</label>
          <select
            id="filter-sort"
            className="select"
            value={query.sort ?? 'updated_desc'}
            onChange={(e) => onChange({ sort: e.target.value as ThreadQuery['sort'] })}
          >
            <option value="updated_desc">最近更新</option>
            <option value="created_desc">最新发布</option>
            <option value="created_asc">最早发布</option>
            <option value="replies_desc">回复最多</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="filter-tags">标签（多个用逗号分隔）</label>
        <input
          id="filter-tags"
          className="input"
          value={(query.tags ?? []).join(',')}
          onChange={(e) =>
            onChange({
              tags: e.target.value
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean),
            })
          }
          placeholder="例如 精华,长团"
        />
      </div>

      <label className="switch">
        <input
          type="checkbox"
          checked={Boolean(query.bookmarkedOnly)}
          onChange={(e) => onChange({ bookmarkedOnly: e.target.checked })}
        />
        仅看我的收藏
      </label>

      <div className="row mt-12">
        <button className="btn btn-sm" onClick={onReset}>
          重置条件
        </button>
      </div>
    </div>
  );
}
