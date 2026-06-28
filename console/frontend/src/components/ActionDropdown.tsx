import { useRef, useState } from "react";
import styles from "./ActionDropdown.module.css";

interface Props {
  items: { key: string; label: string }[];
  onSelect: (key: string) => void;
}

export function ActionDropdown({ items, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  function enter() {
    clearTimeout(timer.current);
    setOpen(true);
  }

  function leave() {
    timer.current = setTimeout(() => setOpen(false), 150);
  }

  return (
    <div className={styles.dropdown} onMouseEnter={enter} onMouseLeave={leave}>
      <button className={styles.trigger}>更多操作 ▼</button>
      {open && (
        <div className={styles.menu}>
          {items.map((item) => (
            <button
              key={item.key}
              className={styles.menuItem}
              onClick={() => {
                onSelect(item.key);
                setOpen(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
