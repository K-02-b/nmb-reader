/**
 * 检索词切分：与后端 `services/search.py` 的 `query_terms` 保持一致——
 * 空白分词（词与词之间是 AND），英文双引号内的整段算一个词（完全匹配）。
 */
const TERM_PATTERN = /"([^"]*)"|(\S+)/g;

export function queryTerms(keyword: string): string[] {
  const terms: string[] = [];
  for (const match of keyword.matchAll(TERM_PATTERN)) {
    const term = (match[1] ?? match[2] ?? '').replace(/^"|"$/g, '').trim();
    if (term && !terms.includes(term)) terms.push(term);
  }
  return terms;
}
