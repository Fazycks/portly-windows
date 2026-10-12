// A small NSMenu look-alike used for `.contextMenu` and toolbar `Menu`s.
import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import "./ContextMenu.css";

export type MenuItem = { label: string; onClick: () => void; disabled?: boolean } | "divider";

/** Drops leading/trailing/duplicate dividers, the way NSMenu collapses them. */
function tidy(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of items) {
    if (item === "divider" && (out.length === 0 || out[out.length - 1] === "divider")) continue;
    out.push(item);
  }
  while (out[out.length - 1] === "divider") out.pop();
  return out;
}

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const top = y + r.height > window.innerHeight - 4 ? Math.max(4, y - r.height) : y;
    setPos({ left, top });
  }, [x, y]);

  useLayoutEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    const close = () => onClose();
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, true);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close, true);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="mac-menu" role="menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {tidy(items).map((item, i) =>
        item === "divider" ? (
          <div key={`d${i}`} className="mac-menu-divider" />
        ) : (
          <div
            key={`${i}${item.label}`}
            role="menuitem"
            aria-disabled={item.disabled}
            className={`mac-menu-item${item.disabled ? " disabled" : ""}`}
            onMouseUp={() => {
              if (item.disabled) return;
              onClose();
              item.onClick();
            }}
          >
            {item.label}
          </div>
        ),
      )}
    </div>,
    document.body,
  );
}

/** `.contextMenu { … }` — returns an opener for onContextMenu and the element to render. */
export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const close = useCallback(() => setState(null), []);
  const open = useCallback((e: ReactMouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY, items });
  }, []);
  const openAt = useCallback((x: number, y: number, items: MenuItem[]) => setState({ x, y, items }), []);
  const element = state ? <Menu x={state.x} y={state.y} items={state.items} onClose={close} /> : null;
  return { open, openAt, close, element, isOpen: state != null };
}
