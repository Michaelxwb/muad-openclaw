import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Select.module.css";

interface Option {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  minWidth?: number;
  block?: boolean; // stretch to fill parent (form fields)
}

export function Select({ value, options, onChange, minWidth, block }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The menu is portaled to <body> (position: fixed) so it is never clipped by a
  // scrollable/overflow ancestor such as a modal body.
  function placeAndToggle() {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    }
    setOpen((o) => !o);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) {
        setOpen(false);
      }
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    // Position is computed once on open; close on scroll/resize to avoid drift.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div
      className={`${styles.select} ${block ? styles.block : ""}`}
      style={minWidth ? { minWidth } : undefined}
    >
      <button ref={triggerRef} className={styles.trigger} onClick={placeAndToggle} type="button">
        <span>{current?.label ?? value}</span>
        <span className={styles.arrow}>▼</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className={`${styles.menu} ${styles.menuFixed}`}
            style={{ top: pos.top, left: pos.left, width: pos.width }}
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`${styles.option} ${opt.value === value ? styles.selected : ""}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                {opt.value === value && <span className={styles.check}>✓</span>}
                <span>{opt.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
