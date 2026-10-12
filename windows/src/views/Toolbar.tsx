// The detail column's unified toolbar: `.navigationTitle` / `.navigationSubtitle`
// on the leading edge and `ToolbarItemGroup` buttons (icon-only, like macOS's
// default toolbar display mode) on the trailing edge.
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./serverInfo";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import "./Toolbar.css";

/**
 * MainView provides the toolbar's place at the top of the detail column, above
 * the `.safeAreaInset(edge: .top)` onboarding card, so each detail view can own
 * its title and items the way SwiftUI's `.toolbar` does.
 */
export const ToolbarSlot = createContext<HTMLElement | null>(null);

export function DetailToolbar({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  const slot = useContext(ToolbarSlot);
  const bar = (
    <div className="detail-toolbar">
      <div className="detail-toolbar-titles">
        <div className="detail-toolbar-title">{title}</div>
        {subtitle && <div className="detail-toolbar-subtitle">{subtitle}</div>}
      </div>
      <div className="detail-toolbar-items">{children}</div>
    </div>
  );
  return slot ? createPortal(bar, slot) : bar;
}

export function ToolbarButton({ symbol, label, help, onClick, disabled }: {
  symbol: string; label: string; help?: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button className="toolbar-button symbol-swap" title={help ?? label} aria-label={label} onClick={onClick} disabled={disabled}>
      <Icon key={symbol} name={symbol} size={14} />
    </button>
  );
}

export function ToolbarMenu({ symbol, label, help, items }: { symbol: string; label: string; help?: string; items: MenuItem[] }) {
  const menu = useContextMenu();
  return (
    <>
      <button
        className={`toolbar-button toolbar-menu${menu.isOpen ? " open" : ""}`}
        title={help ?? label}
        aria-label={label}
        aria-haspopup="menu"
        onMouseDown={(e) => {
          if (menu.isOpen) return;
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          menu.openAt(r.left, r.bottom + 4, items);
        }}
      >
        <Icon name={symbol} size={14} />
        <Icon name="chevron.down" size={8} className="toolbar-menu-chevron" />
      </button>
      {menu.element}
    </>
  );
}
