import type { Tag } from '../api/types';

export function TagChip({
  tag,
  onClick,
  onRemove,
}: {
  tag: Tag;
  onClick?: (tag: Tag) => void;
  onRemove?: (tag: Tag) => void;
}) {
  return (
    <span
      className={`tag tag-${tag.tagType} ${onClick ? 'tag-clickable' : ''}`}
      onClick={onClick ? () => onClick(tag) : undefined}
      title={onClick ? `按 ${tag.tagName} 筛选` : undefined}
    >
      {tag.tagName}
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(tag);
          }}
          aria-label={`移除 ${tag.tagName}`}
        >
          ×
        </button>
      )}
    </span>
  );
}
