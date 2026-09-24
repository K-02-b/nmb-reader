/**
 * 楼层链接：阅读页认 `?post=<楼号>`，页码由阅读页自己补。
 *
 * 用真正的 `<a href>` 而不是 `window.open`：新标签页、中键、右键「复制链接地址」
 * 都是浏览器原生行为。
 */
function postHref(threadId: number, postId: number): string {
  return `/t/${threadId}?post=${postId}`;
}

/** 书签、检索结果共用的「在新标签页打开」 */
export function NewTabLink({ threadId, postId }: { threadId: number; postId: number }) {
  return (
    <a
      className="link-btn"
      href={postHref(threadId, postId)}
      target="_blank"
      rel="noreferrer"
      title={`在新标签页打开 No.${postId}`}
    >
      新标签页
    </a>
  );
}
