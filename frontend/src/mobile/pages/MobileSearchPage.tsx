import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import type { Post } from '../../api/types';
import { useApp } from '../../state/AppContext';
import { HitListPanel } from '../../components/HitListPanel';
import { QuotePopup } from '../../components/QuotePopup';
import { loadRecentKeywords, rememberKeyword } from '../../components/recentKeywords';

/** 命中在面板里的每页条数，与桌面全文检索一致 */
const HIT_PAGE_SIZE = 10;

/**
 * 手机端全文检索页：与桌面目录页的「全文检索」用的是同一套接口（api.fullText）与同一个面板组件，
 * 只是整体占满一屏，命中列表在内部滚动而不是塞在侧栏里。
 */
export function MobileSearchPage() {
  const { session, notify } = useApp();
  const navigate = useNavigate();

  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [hits, setHits] = useState<Post[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [limit, setLimit] = useState(200);
  const [recent, setRecent] = useState<string[]>([]);
  const [quote, setQuote] = useState<{ threadId: number | null; postId: number } | null>(null);

  // 最近三次检索词与桌面端共用一份（按用户名存在浏览器本地）
  useEffect(() => {
    setRecent(loadRecentKeywords(session?.username));
  }, [session?.username]);

  const runFulltext = async (raw?: string) => {
    const value = (raw ?? keyword).trim();
    if (!value) return;
    setKeyword(value);
    setRecent(rememberKeyword(session?.username, value));
    setBusy(true);
    try {
      const result = await api.fullText(value);
      setHits(result.hits);
      setTotal(result.hits.length);
      setPage(1);
      setApplied(value);
      setTruncated(result.truncated);
      setLimit(result.limit);
      if (result.hits.length === 0) {
        notify(`没有命中「${value}」的楼层`, 'info');
      } else if (result.truncated) {
        notify(`命中超过 ${result.limit} 条，只显示前 ${result.limit} 条`, 'warn');
      } else {
        notify(`全文检索命中 ${result.hits.length} 条（仅覆盖已下载的串）`, 'ok');
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '检索失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-page">
      <div className="card m-panel" style={{ padding: 0 }}>
        <HitListPanel
          keyword={keyword}
          onKeyword={setKeyword}
          onSearch={(raw) => void runFulltext(raw)}
          highlight={applied}
          recent={recent}
          onPickRecent={(item) => void runFulltext(item)}
          busy={busy}
          hits={hits.slice((page - 1) * HIT_PAGE_SIZE, page * HIT_PAGE_SIZE)}
          total={total}
          page={page}
          pageSize={HIT_PAGE_SIZE}
          onPage={setPage}
          onQuote={(postId) => {
            // 引用的目标不一定在这一页命中里，串号只能当提示；弹框自己按楼号取
            const hit = hits.find((post) => post.id === postId);
            setQuote({ threadId: hit?.threadId ?? null, postId });
          }}
          emptyHint="输入关键词后回车，命中在这里看；空格分词，英文双引号内完全匹配。只覆盖已下载的串。"
          searchHint=""
          truncated={truncated}
          limit={limit}
          hideImage
          collapse
          actions={(post) => (
            <>
              <button className="link-btn" onClick={() => navigate(`/m/home?thread=${post.threadId}`)}>
                在目录显示
              </button>
              <button className="link-btn" onClick={() => navigate(`/m/t/${post.threadId}?post=${post.id}`)}>
                查看该楼
              </button>
            </>
          )}
        />
      </div>

      {quote && (
        <QuotePopup
          key={`${quote.threadId ?? 'thread'}-${quote.postId}`}
          rootPostId={quote.postId}
          threadId={quote.threadId}
          onGoToPost={(postId, targetThread) => navigate(`/m/t/${targetThread}?post=${postId}`)}
          onClose={() => setQuote(null)}
        />
      )}
    </div>
  );
}
