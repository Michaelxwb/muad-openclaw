import { useEffect, useRef, useState } from "react";
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div
      className={`${styles.select} ${block ? styles.block : ""}`}
      ref={ref}
      style={minWidth ? { minWidth } : undefined}
    >
      <button className={styles.trigger} onClick={() => setOpen(!open)} type="button">
        <span>{current?.label ?? value}</span>
        <span className={styles.arrow}>▼</span>
      </button>
      {open && (
        <div className={styles.menu}>
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
        </div>
      )}
    </div>
  );
}
