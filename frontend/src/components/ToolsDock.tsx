import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from './icons';

/** 面板收起动画时长，和 pages.css 里的 .tools-panel 过渡保持一致 */
const PANEL_MS = 180;

export interface DockItem<T extends string = string> {
  key: T;
  /** 图标按钮的无障碍名称与 tooltip */
  label: string;
  icon: ReactNode;
  /** 竖栏上的小圆点数字，0 / undefined 不显示 */
  badge?: number;
}

/**
 * 阅读页与目录页共用的右侧工具栏：一条只放图标的竖栏 + 一个面板。
 *
 * 面板固定挂在 body 上（#root 有 filter，会变成 fixed 的包含块），宽度固定，
 * 所以「检索」和「书签」切换时不会跳动。收起时先播完动画再卸载。
 */
export function ToolsDock<T extends string>({
  items,
  active,
  onToggle,
  onClose,
  renderPanel,
}: {
  items: Array<DockItem<T>>;
  active: T | null;
  onToggle: (key: T) => void;
  onClose: () => void;
  /** 按当前面板 key 取内容；收起动画期间还会用上一个 key 渲染一次 */
  renderPanel: (key: T) => ReactNode;
}) {
  const [shown, setShown] = useState<T | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (active) {
      setShown(active);
      const frame = window.requestAnimationFrame(() => setOpen(true));
      return () => window.cancelAnimationFrame(frame);
    }
    setOpen(false);
    const timer = window.setTimeout(() => setShown(null), PANEL_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onClose]);

  const current = items.find((item) => item.key === shown);

  return createPortal(
    <div className="tools-dock">
      {shown && (
        <section className="tools-panel" data-open={open} role="dialog" aria-label={current?.label ?? '工具面板'}>
          <header className="tools-head">
            <h3>{current?.label ?? ''}</h3>
            <span className="spacer" />
            <button className="tools-close" onClick={onClose} aria-label="关闭面板">
              <IconClose />
            </button>
          </header>
          {renderPanel(shown)}
        </section>
      )}
      <nav className="tools-rail" aria-label="工具栏">
        {items.map((item) => (
          <button
            key={item.key}
            className={`rail-btn ${active === item.key ? 'active' : ''}`}
            title={item.label}
            aria-label={item.label}
            aria-pressed={active === item.key}
            onClick={() => onToggle(item.key)}
          >
            {item.icon}
            {item.badge ? <span className="rail-badge">{item.badge}</span> : null}
          </button>
        ))}
      </nav>
    </div>,
    document.body,
  );
}
