import { Fragment, type ReactNode } from 'react';

/** 把 >>No.123456 变成可点击的引用；可选地把关键字包成 <mark> */
export function renderPostBody(
  content: string,
  options: { highlight?: string; onJump?: (postId: number) => void } = {},
): ReactNode {
  const { highlight, onJump } = options;
  const parts = content.split(/(>>(?:No\.)?\d+)/g);
  return parts.map((part, index) => {
    const quote = /^>>(?:No\.)?(\d+)$/.exec(part);
    if (quote) {
      const postId = Number(quote[1]);
      return (
        <span
          key={index}
          className="quote"
          role="link"
          tabIndex={0}
          title={`跳转到 No.${postId}`}
          onClick={() => onJump?.(postId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onJump?.(postId);
          }}
        >
          {part}
        </span>
      );
    }
    return <Fragment key={index}>{highlightText(part, highlight)}</Fragment>;
  });
}

export function highlightText(text: string, keyword?: string): ReactNode {
  if (!keyword) return text;
  const kw = keyword.trim();
  if (!kw) return text;
  const lower = text.toLowerCase();
  const target = kw.toLowerCase();
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let found = lower.indexOf(target);
  let key = 0;
  while (found >= 0) {
    if (found > cursor) nodes.push(text.slice(cursor, found));
    nodes.push(<mark key={`m${key++}`}>{text.slice(found, found + kw.length)}</mark>);
    cursor = found + kw.length;
    found = lower.indexOf(target, cursor);
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
