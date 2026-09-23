/** 标签候选的模糊匹配：完全相等 > 前缀 > 子串 > 子序列，命中位置返回给 UI 高亮。 */

export type MatchRange = [start: number, end: number];

export interface FuzzyMatch {
  score: number;
  ranges: MatchRange[];
}

const EXACT = 1000;
const PREFIX = 800;
const SUBSTRING = 600;
const SUBSEQUENCE = 300;

/** 单个词项匹配；不匹配返回 null */
function matchTerm(text: string, term: string): FuzzyMatch | null {
  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  if (!lowerTerm) return { score: 0, ranges: [] };

  if (lowerText === lowerTerm) return { score: EXACT, ranges: [[0, text.length]] };

  const index = lowerText.indexOf(lowerTerm);
  if (index === 0) {
    return { score: PREFIX - (text.length - term.length), ranges: [[0, term.length]] };
  }
  if (index > 0) {
    return { score: SUBSTRING - index * 2, ranges: [[index, index + term.length]] };
  }

  // 子序列：字符按顺序出现即可
  const ranges: MatchRange[] = [];
  let cursor = 0;
  for (const char of lowerTerm) {
    const found = lowerText.indexOf(char, cursor);
    if (found < 0) return null;
    ranges.push([found, found + 1]);
    cursor = found + 1;
  }
  const span = ranges[ranges.length - 1][1] - ranges[0][0];
  return { score: SUBSEQUENCE - span, ranges };
}

/** 空格分隔的每个词项都要命中（顺序无关），分数相加；空查询返回 score 0。 */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { score: 0, ranges: [] };

  let score = 0;
  const ranges: MatchRange[] = [];
  for (const term of terms) {
    const hit = matchTerm(text, term);
    if (!hit) return null;
    score += hit.score;
    ranges.push(...hit.ranges);
  }
  // 短语整体命中额外加分
  if (terms.length === 1) {
    const whole = text.toLowerCase().indexOf(terms[0].toLowerCase());
    if (whole >= 0) score += 50;
  }
  return { score, ranges: mergeRanges(ranges) };
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: MatchRange[] = [sorted[0]];
  for (const [start, end] of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export interface RankedItem<T> {
  item: T;
  ranges: MatchRange[];
  score: number;
}

/** 过滤 + 按匹配质量排序（Array.sort 稳定，同分保持原顺序） */
export function fuzzyRank<T>(items: T[], query: string, key: (item: T) => string): RankedItem<T>[] {
  const ranked: RankedItem<T>[] = [];
  for (const item of items) {
    const hit = fuzzyMatch(key(item), query);
    if (hit) ranked.push({ item, ranges: hit.ranges, score: hit.score });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

/** 按类型分组候选：空查询只看当前类型，有输入则跨类型搜且同类型在前。 */
export function splitByType<T>(
  ranked: T[],
  typeOf: (item: T) => string,
  current: string,
  query: string,
): { same: T[]; other: T[] } {
  const same = ranked.filter((item) => typeOf(item) === current);
  const other = query.trim() === '' ? [] : ranked.filter((item) => typeOf(item) !== current);
  return { same, other };
}
