import { Fragment, type ReactNode } from 'react';
import { queryTerms } from './query';

/**
 * 岛上的引用写法（实测就这几种）：`>>50189071`、`>>No.50189071`，
 * 中间可能夹空格，也可能是全角 `＞＞`；单独的 `No.50189071` 同样是在指某一楼。
 *
 * 裸数字（`60725228`）岛上靠脚本补成链接，这里不猜——正文里数字太常见。
 */
const REFERENCE = /((?:>>|＞＞)\s*(?:No\.\s*)?\d+|No\.\d{5,})/;
const SPLIT = new RegExp(REFERENCE.source, 'g');
const WHOLE = new RegExp(`^${REFERENCE.source}$`);
const TAIL_ID = /(\d+)$/;

/** 把正文里的引用变成可点击的 >>No.123456；可选地把关键字包成 <mark> */
export function renderPostBody(
  content: string,
  options: { highlight?: string; onJump?: (postId: number) => void } = {},
): ReactNode {
  const { highlight, onJump } = options;
  return content.split(SPLIT).map((part, index) => {
    const digits = WHOLE.test(part) ? TAIL_ID.exec(part)?.[1] : undefined;
    if (digits) {
      const postId = Number(digits);
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
  const terms = keyword ? queryTerms(keyword) : [];
  if (terms.length === 0) return text;
  const lower = text.toLowerCase();
  const lowered = terms.map((term) => term.toLowerCase());
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (;;) {
    // 每次挑最靠前的那个词；同位置取更长的，免得短词盖住长词
    let found = -1;
    let length = 0;
    lowered.forEach((term) => {
      const at = lower.indexOf(term, cursor);
      if (at >= 0 && (found < 0 || at < found || (at === found && term.length > length))) {
        found = at;
        length = term.length;
      }
    });
    if (found < 0) break;
    if (found > cursor) nodes.push(text.slice(cursor, found));
    nodes.push(<mark key={`m${key++}`}>{text.slice(found, found + length)}</mark>);
    cursor = found + length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
