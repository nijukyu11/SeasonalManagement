'use client';

type DeleteIconButtonProps = {
  label: string;
  onClick: () => void;
  className?: string;
};

export function DeleteIconButton({ label, onClick, className = '' }: DeleteIconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-lg border border-outline-variant text-on-surface-variant transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 ${className}`}
    >
      <span className="material-symbols-outlined text-[18px]">delete</span>
    </button>
  );
}

export function TableHeader({ columns }: { columns: string[] }) {
  return (
    <div
      className="hidden gap-3 border-b border-surface-variant bg-surface-container px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant lg:grid"
      style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
    >
      {columns.map((column) => (
        <span key={column}>{column}</span>
      ))}
    </div>
  );
}
