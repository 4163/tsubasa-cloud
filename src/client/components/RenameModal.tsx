import React, { useState, useEffect, useRef, useId } from 'react';
import * as stylex from '@stylexjs/stylex';
import { IconEdit } from './Icons.js';
import { ModalDialog } from './ModalDialog.js';
import { ModalHeader, modalChromeStyles } from './ModalChrome.js';
import { getItemNameError } from '../utils/virtualPath.js';
import type { RenameTarget } from '../types.js';

interface RenameModalProps {
  isOpen: boolean;
  onClose: () => void;
  item: RenameTarget | null;
  onRename: (kind: 'file' | 'folder' | 'pool', id: string, newName: string) => Promise<void> | void;
}

const styles = stylex.create({
  surface: {
    width: '420px',
  },
});

export function RenameModal({
  isOpen,
  onClose,
  item,
  onRename,
}: RenameModalProps) {
  const [name, setName] = useState(() => item?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const inputId = useId();

  const effectiveOpen = isOpen && Boolean(item);

  useEffect(() => {
    if (!isOpen || !item) return;

    setName(item.name);
    setError(null);
    setIsSubmitting(false);
    submittingRef.current = false;

    // Wait one frame so ModalDialog's showModal() and the updated input value have committed.
    const rafId = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const dotIdx = item.kind === 'file' ? item.name.lastIndexOf('.') : -1;
      if (dotIdx > 0) {
        input.setSelectionRange(0, dotIdx);
      } else {
        input.select();
      }
    });

    return () => cancelAnimationFrame(rafId);
  }, [isOpen, item]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (submittingRef.current || isSubmitting || !item) return;

    const trimmed = name.trim();
    const validationError = getItemNameError(trimmed, 'Name');
    if (validationError) {
      setError(validationError);
      return;
    }
    if (trimmed === item.name) {
      onClose();
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      await onRename(item.kind, item.id, trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <ModalDialog
      isOpen={effectiveOpen}
      onClose={onClose}
      isBusy={isSubmitting}
      ariaLabelledBy={titleId}
      surfaceStyle={styles.surface}
    >
      {item && (
        <>
          <ModalHeader
            titleId={titleId}
            title={`Rename ${item.kind}`}
            icon={<IconEdit size={16} />}
            onClose={onClose}
            isBusy={isSubmitting}
            closeAriaLabel="Close"
          />

          <form onSubmit={handleSubmit}>
            <div {...stylex.props(modalChromeStyles.body)}>
              <div {...stylex.props(modalChromeStyles.fieldGroup)}>
                <label htmlFor={inputId} {...stylex.props(modalChromeStyles.label)}>New name</label>
                <input
                  id={inputId}
                  ref={inputRef}
                  type="text"
                  autoFocus
                  placeholder={item.kind === 'pool' ? 'Pool X' : undefined}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={handleInputKeyDown}
                  {...stylex.props(modalChromeStyles.input)}
                  disabled={isSubmitting}
                />
                <div role="status" aria-live="polite">
                  {error && <span {...stylex.props(modalChromeStyles.errorMessage)}>{error}</span>}
                </div>
              </div>
            </div>

            <div {...stylex.props(modalChromeStyles.footer)}>
              <button
                type="button"
                {...stylex.props(modalChromeStyles.cancelBtn)}
                onClick={onClose}
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                {...stylex.props(modalChromeStyles.primaryBtn)}
                disabled={isSubmitting || !name.trim()}
              >
                {isSubmitting ? 'Saving...' : 'Rename'}
              </button>
            </div>
          </form>
        </>
      )}
    </ModalDialog>
  );
}
