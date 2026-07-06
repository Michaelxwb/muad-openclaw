import { useEffect, useRef, useState } from "react";
import { Badge, List, Empty } from "@douyinfe/semi-ui";
import { IconBell } from "@douyinfe/semi-icons";
import { api, Alert } from "../api";

const LEVEL_COLORS: Record<string, string> = {
  P1: "var(--semi-color-danger)",
  P2: "var(--semi-color-warning)",
  P3: "var(--semi-color-text-2)",
};

// 通知铃铛 + 自管下拉。
// 不用 Semi Popover：它在内部用 findDOMNode 定位弹层（tooltip/index.js:404），
// 在 React 18 StrictMode 下会持续 deprecation warning。改用自己定位的浮层。
export function NotificationBell() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    let mounted = true;
    const fetchAlerts = () => {
      api
        .alerts()
        .then((r) => {
          if (mounted) setAlerts(r);
        })
        .catch(() => {
          /* silently keep previous data */
        });
    };
    fetchAlerts();
    const t = setInterval(fetchAlerts, 30000);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, []);

  // Open: anchor the panel just under the bell, right-aligned.
  useEffect(() => {
    if (!open || !triggerRef.current) {
      setPos(null);
      return;
    }
    const r = triggerRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
  }, [open, alerts.length]);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const content =
    alerts.length === 0 ? (
      <Empty description="暂无告警" />
    ) : (
      <List
        dataSource={alerts}
        style={{ maxHeight: 280, overflow: "auto" }}
        renderItem={(a) => (
          <List.Item style={{ padding: "6px 12px" }}>
            <span
              style={{ color: LEVEL_COLORS[a.level] || "inherit", fontWeight: 600, marginRight: 6 }}
            >
              [{a.level}]
            </span>
            <span style={{ marginRight: 8 }}>{a.userId}</span>
            <span style={{ color: "var(--semi-color-text-2)" }}>{a.message}</span>
          </List.Item>
        )}
      />
    );

  return (
    <>
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          height: 24,
          padding: "0 8px",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        {alerts.length > 0 ? (
          <Badge
            count={alerts.length}
            overflowCount={99}
            countStyle={{
              fontSize: 10,
              height: 14,
              minWidth: 14,
              lineHeight: "14px",
              padding: "0 4px",
            }}
          >
            <IconBell style={{ color: "var(--semi-color-text-2)" }} />
          </Badge>
        ) : (
          <IconBell style={{ color: "var(--semi-color-text-2)" }} />
        )}
      </span>
      {open && pos && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="告警列表"
          style={{
            position: "fixed",
            top: pos.top,
            right: pos.right,
            width: 400,
            maxHeight: 320,
            overflow: "auto",
            background: "var(--semi-color-bg-1)",
            border: "1px solid var(--semi-color-border)",
            borderRadius: 6,
            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.12)",
            zIndex: 1000,
          }}
        >
          {content}
        </div>
      )}
    </>
  );
}
