import { useMemo, useState } from 'react';
import type { Tag, TagType } from '../api/types';
import { useTagVocab, type TagCandidate } from '../state/TagVocabContext';
import { TagChip } from './TagChip';
import { TagInput } from './TagInput';

/** 标签编辑：genre / series / status / installment 每串每类最多一个，其余走 CUSTOM_TAG。 */
export function TagEditor({ tags, onChange }: { tags: Tag[]; onChange: (tags: Tag[]) => void }) {
  const [type, setType] = useState<TagType>('CUSTOM_TAG');
  const { candidates: allCandidates, vocab, registerLocal } = useTagVocab();

  // 本串已有的不出现在候选里
  const candidates = useMemo<TagCandidate[]>(
    () => allCandidates.filter((c) => !tags.some((t) => t.tagType === c.type && t.tagName === c.name)),
    [allCandidates, tags],
  );

  const addTag = (tagType: TagType, rawName: string) => {
    const name = rawName.trim();
    if (!name) return;
    let next = tags.slice();
    if (['genre', 'series', 'status', 'installment'].includes(tagType)) {
      next = next.filter((t) => t.tagType !== tagType); // 每串每类只留一个
    }
    if (next.some((t) => t.tagType === tagType && t.tagName === name)) return;
    next.push({ tagId: Math.floor(Math.random() * 100000), tagType, tagName: name });
    onChange(next);
    // 并入全局候选，别处立即可选
    registerLocal({ tagType, tagName: name });
  };

  return (
    <div>
      <div className="row row-wrap" style={{ marginBottom: 10 }}>
        {tags.length === 0 && <span className="hint">暂无标签</span>}
        {tags.map((tag) => (
          <TagChip
            key={`${tag.tagType}-${tag.tagName}`}
            tag={tag}
            onRemove={(t) => onChange(tags.filter((x) => !(x.tagType === t.tagType && x.tagName === t.tagName)))}
          />
        ))}
      </div>

      <TagInput
        type={type}
        onTypeChange={setType}
        candidates={candidates}
        onPick={(candidate) => addTag(candidate.type, candidate.name)}
        onCreate={addTag}
      />

      <p className="hint" style={{ marginBottom: 0 }}>
        类型 / 系列 / 状态 / 卷次每串各最多一个，其余全部按自定义标签存储（对应 tag_registry + thread_tag 结构）。
        输入片段即可模糊匹配已有标签（前缀 &gt; 子串 &gt; 跳字），选中「新建」或直接回车会用当前类型创建；
        新标签保存后写进全局标签库。
        {vocab.tags.length > 0 && ` 当前自定义标签共 ${vocab.tags.length} 个。`}
      </p>
    </div>
  );
}
