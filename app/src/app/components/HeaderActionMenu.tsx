'use client';

import { useState } from 'react';

export interface HeaderActionMenuItem {
  label: string;
  icon: string;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
}

interface HeaderActionMenuProps {
  items: HeaderActionMenuItem[];
  label?: string;
  className?: string;
}

export default function HeaderActionMenu({ items, label = 'More actions', className = '' }: HeaderActionMenuProps) {
  const [open, setOpen] = useState(false);

  if (items.length === 0) return null;

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low px-3 text-sm font-semibold text-on-surface transition-colors hover:bg-surface-container-high"
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
      >
        <span className="material-symbols-outlined text-[20px]">more_vert</span>
        <span className="hidden sm:inline">{label}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-2 w-56 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest shadow-lg" role="menu">
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  if (item.disabled) return;
                  setOpen(false);
                  item.onSelect();
                }}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm font-medium text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="material-symbols-outlined text-[18px]">{item.icon}</span>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
