import { useEffect, useRef, useState } from "react";
import { api, Alert } from "../api";
import styles from "./NotificationBell.module.css";

export function NotificationBell() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchAlerts = () => {
      api
        .alerts()
        .then(setAlerts)
        .catch(() => {
          /* silently keep previous data */
        });
    };
    fetchAlerts();
    const t = setInterval(fetchAlerts, 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const count = alerts.length;

  return (
    <div className={styles.bell} ref={ref}>
      <button className={styles.trigger} onClick={() => setOpen(!open)} title="告警通知">
        🔔
        {count > 0 && <span className={styles.badge}>{count > 99 ? "99+" : count}</span>}
      </button>

      {open && (
        <div className={styles.dropdown}>
          {alerts.length === 0 ? (
            <div className={styles.empty}>暂无告警</div>
          ) : (
            alerts.map((a, i) => (
              <div key={i} className={`${styles.item} ${styles[a.level] || ""}`}>
                <span className={styles.level}>[{a.level}]</span>
                <span className={styles.user}>{a.userId}</span>
                <span className={styles.msg}>{a.message}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
