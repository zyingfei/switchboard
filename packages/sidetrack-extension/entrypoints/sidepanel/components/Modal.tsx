import type { ReactNode } from 'react';
import { Icons } from './icons';

interface ModalProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly width?: number;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly variant?: 'default' | 'ink';
}

export function Modal({
  title,
  subtitle,
  width = 520,
  onClose,
  children,
  footer,
  variant = 'default',
}: ModalProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={'modal' + (variant === 'ink' ? ' modal-ink' : '')}
        style={{ width }}
        onClick={(e) => { e.stopPropagation(); }}
      >
        <div className="modal-head">
          <div className="modal-head-text">
            <h3>{title}</h3>
            {subtitle ? <div className="modal-sub">{subtitle}</div> : null}
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">
            <span className="icon-12">{Icons.close}</span>
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
