export function Pagination({
  page,
  totalPages,
  onChange,
  totalLabel,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  totalLabel?: string;
}) {
  if (totalPages <= 1) {
    return totalLabel ? <div className="pagination faint">{totalLabel}</div> : null;
  }
  const windowSize = 5;
  let start = Math.max(1, page - Math.floor(windowSize / 2));
  const end = Math.min(totalPages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);
  const pages: number[] = [];
  for (let p = start; p <= end; p++) pages.push(p);

  return (
    <div className="pagination">
      <button className="btn btn-sm page-btn" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        上一页
      </button>
      {start > 1 && (
        <>
          <button className="btn btn-sm page-btn" onClick={() => onChange(1)}>
            1
          </button>
          {start > 2 && <span className="faint">…</span>}
        </>
      )}
      {pages.map((p) => (
        <button key={p} className={`btn btn-sm page-btn ${p === page ? 'active' : ''}`} onClick={() => onChange(p)}>
          {p}
        </button>
      ))}
      {end < totalPages && (
        <>
          {end < totalPages - 1 && <span className="faint">…</span>}
          <button className="btn btn-sm page-btn" onClick={() => onChange(totalPages)}>
            {totalPages}
          </button>
        </>
      )}
      <button className="btn btn-sm page-btn" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        下一页
      </button>
      {totalLabel && (
        <span className="faint" style={{ marginLeft: 8 }}>
          {totalLabel}
        </span>
      )}
    </div>
  );
}
