import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TagType } from '../api/types';
import type { TagCandidate } from '../state/TagVocabContext';
import { fuzzyRank, splitByType, type MatchRange, type RankedItem } from './fuzzy';

const TYPE_LABEL: Record<TagType, string> = {
  genre: '类型',
  series: '系列',
  status: '状态',
  installment: '卷次',
  CUSTOM_TAG: '标签',
};

interface Props {
  type: TagType;
  onTypeChange: (type: TagType) => void;
  /** 全部候选（调用方已排除本串已有的） */
  candidates: TagCandidate[];
  /** 选中已有候选（会按候选自己的类型归属） */
  onPick: (candidate: TagCandidate) => void;
  /** 用当前类型新建一个标签 */
  onCreate: (type: TagType, name: string) => void;
}

/**
 * 标签输入：可选可输 + 模糊匹配，↑/↓ 选择、Enter 确认、Esc 关闭。
 * 候选内联展开而非浮层——所在容器的 overflow 会把绝对定位裁掉。
 */
export function TagInput({ type, onTypeChange, candidates, onPick, onCreate }: Props) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  // -1 = 无高亮，这样首次按 ↓ 落在第一项
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);

  const trimmed = value.trim();
  const exactExists = candidates.some((c) => c.name === trimmed && c.type === type);
  const showCreate = trimmed !== '' && !exactExists;

  // 分组：本类型在前，其它类型在后（规则见 fuzzy.splitByType）
  const { sameType, otherType } = useMemo(() => {
    const ranked = fuzzyRank(candidates, value, (item) => item.name);
    const { same, other } = splitByType(ranked, (entry) => entry.item.type, type, value);
    return { sameType: same, otherType: other };
  }, [candidates, value, type]);

  const options = useMemo(() => [...sameType, ...otherType], [sameType, otherType]);
  const optionCount = options.length + (showCreate ? 1 : 0);
  const noCandidates = trimmed === '' && sameType.length === 0;

  // 点击外部收起
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => setActive(-1), [value]);

  const commit = () => {
    // 无高亮时 Enter 用当前类型新建
    if (active >= 0 && active < options.length) {
      const picked = options[active].item;
      onPick(picked);
      if (picked.type !== type) onTypeChange(picked.type);
    } else if (showCreate) {
      onCreate(type, trimmed);
    } else {
      return;
    }
    setValue('');
    setOpen(false);
  };

  const pick = (candidate: TagCandidate) => {
    onPick(candidate);
    if (candidate.type !== type) onTypeChange(candidate.type);
    setValue('');
    setOpen(false);
  };

  return (
    <div className="tag-input" ref={boxRef}>
      <div className="row row-wrap">
        <select
          className="select"
          style={{ width: 120 }}
          value={type}
          onChange={(event) => {
            onTypeChange(event.target.value as TagType);
            setOpen(false);
          }}
        >
          {(Object.keys(TYPE_LABEL) as TagType[]).map((item) => (
            <option key={item} value={item}>
              {TYPE_LABEL[item]}
            </option>
          ))}
        </select>

        <input
          className="input"
          style={{ flex: 1, minWidth: 160 }}
          placeholder={
            type === 'CUSTOM_TAG'
              ? '输入新标签，或输入片段模糊匹配已有标签'
              : type === 'installment'
                ? '输入卷次（数字，如 12 或 13.5）'
                : `输入或从候选里挑${TYPE_LABEL[type]}`
          }
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              setActive((prev) => Math.min(prev + 1, optionCount - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((prev) => Math.max(prev - 1, -1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
        />

        <button className="btn" disabled={!trimmed} onClick={() => onCreate(type, trimmed)}>
          添加
        </button>
      </div>

      {open && (options.length > 0 || showCreate) && (
        <ul className="tag-suggest" role="listbox">
          {sameType.map((entry, index) => (
            <SuggestRow
              key={`${entry.item.type}-${entry.item.name}`}
              entry={entry}
              active={index === active}
              onHover={() => setActive(index)}
              onPick={() => pick(entry.item)}
            />
          ))}

          {otherType.length > 0 && <li className="tag-suggest-divider">其它类型（选中会自动切换类型）</li>}

          {otherType.map((entry, offset) => {
            const index = sameType.length + offset;
            return (
              <SuggestRow
                key={`${entry.item.type}-${entry.item.name}`}
                entry={entry}
                active={index === active}
                onHover={() => setActive(index)}
                onPick={() => pick(entry.item)}
              />
            );
          })}

          {showCreate && (
            <li
              role="option"
              aria-selected={active === options.length}
              className={`tag-suggest-item ${active === options.length ? 'active' : ''}`}
              onMouseEnter={() => setActive(options.length)}
              onMouseDown={(event) => {
                event.preventDefault();
                onCreate(type, trimmed);
                setValue('');
                setOpen(false);
              }}
            >
              <span className="badge badge-accent">新建</span>
              <span>
                用「{TYPE_LABEL[type]}」新建 <strong>{trimmed}</strong>
              </span>
            </li>
          )}
        </ul>
      )}

      {open && noCandidates && type === 'installment' && (
        <p className="hint" style={{ marginTop: 6 }}>
          卷次还没有已有值，直接输入数字后回车即可。
        </p>
      )}
    </div>
  );
}

/** 把命中的字符包成 <mark> */
function highlight(text: string, ranges: MatchRange[]): ReactNode {
  if (ranges.length === 0) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(<mark key={index}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

interface SuggestRowProps {
  entry: RankedItem<TagCandidate>;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}

function SuggestRow({ entry, active, onHover, onPick }: SuggestRowProps) {
  return (
    <li
      role="option"
      aria-selected={active}
      className={`tag-suggest-item ${active ? 'active' : ''}`}
      onMouseEnter={onHover}
      onMouseDown={(event) => {
        event.preventDefault(); // 别让输入框先失焦
        onPick();
      }}
    >
      <span className={`badge tag-type-${entry.item.type}`}>{TYPE_LABEL[entry.item.type]}</span>
      <span>{highlight(entry.item.name, entry.ranges)}</span>
    </li>
  );
}
