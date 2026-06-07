'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCachedRouteActivity } from './RouteCacheContext';

type DialogTone = 'info' | 'success' | 'warning' | 'error';

interface DialogOptions {
  title?: string;
  message: string;
  tone?: DialogTone;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface DialogChoice {
  value: string;
  label: string;
  tone?: DialogTone;
}

interface ChoiceDialogOptions extends DialogOptions {
  choices: DialogChoice[];
}

interface DialogState extends Required<Omit<DialogOptions, 'cancelLabel'>> {
  kind: 'notice' | 'decision' | 'choice';
  cancelLabel?: string;
  choices?: DialogChoice[];
  portalRoot: HTMLElement;
  resolve: (value: boolean | string | null) => void;
}

const APP_DIALOG_ROOT_ID = 'seasonal-app-dialog-root';

const toneStyles: Record<DialogTone, { icon: string; iconClass: string; confirmClass: string }> = {
  info: {
    icon: 'info',
    iconClass: 'bg-primary-container text-primary',
    confirmClass: 'bg-primary text-on-primary hover:bg-primary-container hover:text-on-primary-container',
  },
  success: {
    icon: 'check_circle',
    iconClass: 'bg-emerald-50 text-emerald-700',
    confirmClass: 'bg-emerald-600 text-white hover:bg-emerald-700',
  },
  warning: {
    icon: 'warning',
    iconClass: 'bg-amber-50 text-amber-700',
    confirmClass: 'bg-amber-600 text-white hover:bg-amber-700',
  },
  error: {
    icon: 'error',
    iconClass: 'bg-error-container text-error',
    confirmClass: 'bg-error text-on-error hover:bg-error-container hover:text-on-error-container',
  },
};

function normalizeOptions(messageOrOptions: string | DialogOptions): Required<DialogOptions> {
  const options = typeof messageOrOptions === 'string' ? { message: messageOrOptions } : messageOrOptions;
  return {
    title: options.title ?? 'Notice',
    message: options.message,
    tone: options.tone ?? 'info',
    confirmLabel: options.confirmLabel ?? 'OK',
    cancelLabel: options.cancelLabel ?? 'Cancel',
  };
}

function getDialogRoot(): HTMLElement | null {
  if (typeof document === 'undefined') return null;

  let root = document.getElementById(APP_DIALOG_ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = APP_DIALOG_ROOT_ID;
    document.body.appendChild(root);
  }

  return root;
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  width: '100vw',
  height: '100vh',
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '16px',
  boxSizing: 'border-box',
  overflowY: 'auto',
  background: 'rgba(15, 23, 42, 0.42)',
};

const cardStyle: CSSProperties = {
  width: 'min(480px, calc(100vw - 32px))',
  maxWidth: '480px',
  minWidth: 'min(320px, calc(100vw - 32px))',
  flex: '0 0 min(480px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 32px)',
  overflow: 'hidden',
  boxSizing: 'border-box',
};

export function useAppDialog() {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const isRouteActive = useCachedRouteActivity();

  useEffect(() => {
    if (isRouteActive) return undefined;

    const timeoutId = window.setTimeout(() => setDialog(null), 0);
    return () => window.clearTimeout(timeoutId);
  }, [isRouteActive]);

  const showAlert = useCallback((messageOrOptions: string | DialogOptions): Promise<void> => {
    const options = normalizeOptions(messageOrOptions);
    return new Promise((resolve) => {
      const portalRoot = getDialogRoot();
      if (!portalRoot) {
        resolve();
        return;
      }

      setDialog({
        kind: 'notice',
        title: options.title,
        message: options.message,
        tone: options.tone,
        confirmLabel: options.confirmLabel,
        portalRoot,
        resolve: () => resolve(),
      });
    });
  }, []);

  const showConfirm = useCallback((messageOrOptions: string | DialogOptions): Promise<boolean> => {
    const options = normalizeOptions(messageOrOptions);
    return new Promise((resolve) => {
      const portalRoot = getDialogRoot();
      if (!portalRoot) {
        resolve(false);
        return;
      }

      setDialog({
        kind: 'decision',
        title: options.title,
        message: options.message,
        tone: options.tone,
        confirmLabel: options.confirmLabel,
        cancelLabel: options.cancelLabel,
        portalRoot,
        resolve: (value) => resolve(value === true),
      });
    });
  }, []);

  const showChoice = useCallback((messageOrOptions: ChoiceDialogOptions): Promise<string | null> => {
    const options = normalizeOptions(messageOrOptions);
    return new Promise((resolve) => {
      const portalRoot = getDialogRoot();
      if (!portalRoot) {
        resolve(null);
        return;
      }

      setDialog({
        kind: 'choice',
        title: options.title,
        message: options.message,
        tone: options.tone,
        confirmLabel: options.confirmLabel,
        cancelLabel: options.cancelLabel,
        choices: messageOrOptions.choices,
        portalRoot,
        resolve: (value) => resolve(typeof value === 'string' ? value : null),
      });
    });
  }, []);

  const dialogNode = useMemo(() => {
    if (!dialog || !isRouteActive) return null;
    const style = toneStyles[dialog.tone];
    const close = (value: boolean) => {
      dialog.resolve(value);
      setDialog(null);
    };
    const closeChoice = (value: string | null) => {
      dialog.resolve(value);
      setDialog(null);
    };

    return createPortal(
      <div style={overlayStyle} role="presentation">
        <div
          style={cardStyle}
          className="rounded-xl border border-outline-variant bg-surface shadow-xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="app-dialog-title"
        >
          <div className="flex items-start gap-4 border-b border-surface-variant bg-surface-container-low px-5 py-4">
            <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${style.iconClass}`}>
              <span className="material-symbols-outlined text-[22px]">{style.icon}</span>
            </div>
            <div className="min-w-0">
              <h2 id="app-dialog-title" className="font-h3 text-h3 text-on-surface">{dialog.title}</h2>
              <p className="mt-1 whitespace-pre-wrap break-words font-body-sm text-body-sm text-on-surface-variant">{dialog.message}</p>
            </div>
          </div>
          <div className="flex justify-end gap-2 px-5 py-4">
            {dialog.kind === 'choice' ? (
              dialog.choices?.map((choice) => {
                const choiceStyle = choice.tone ? toneStyles[choice.tone].confirmClass : 'border border-outline-variant text-on-surface hover:bg-surface-container-high';
                return (
                  <button
                    key={choice.value}
                    type="button"
                    className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${choiceStyle}`}
                    onClick={() => closeChoice(choice.value)}
                  >
                    {choice.label}
                  </button>
                );
              })
            ) : (
              <>
            {dialog.kind === 'decision' && (
              <button
                type="button"
                className="rounded-lg border border-outline-variant px-4 py-2 text-sm font-semibold text-on-surface hover:bg-surface-container-high transition-colors"
                onClick={() => close(false)}
              >
                {dialog.cancelLabel}
              </button>
            )}
            <button
              type="button"
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${style.confirmClass}`}
              onClick={() => close(true)}
              autoFocus
            >
              {dialog.confirmLabel}
            </button>
              </>
            )}
          </div>
        </div>
      </div>,
      dialog.portalRoot
    );
  }, [dialog, isRouteActive]);

  return { dialogNode, showAlert, showConfirm, showChoice };
}
