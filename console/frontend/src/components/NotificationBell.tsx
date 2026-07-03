import { useEffect, useState } from "react";
import { Badge, Popover, List, Empty } from "@douyinfe/semi-ui";
import { IconBell } from "@douyinfe/semi-icons";
import { api, Alert } from "../api";

const LEVEL_COLORS: Record<string, string> = {
  P1: "var(--semi-color-danger)",
  P2: "var(--semi-color-warning)",
  P3: "var(--semi-color-text-2)",
};

export function NotificationBell() {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    const fetchAlerts = () => {
      api.alerts().then(setAlerts).catch(() => {
        /* silently keep previous data */
      });
    };
    fetchAlerts();
    const t = setInterval(fetchAlerts, 30000);
    return () => clearInterval(t);
  }, []);

  const content = alerts.length === 0 ? (
    <Empty description="暂无告警" />
  ) : (
    <List
      dataSource={alerts}
      style={{ maxHeight: 280, overflow: "auto" }}
      renderItem={(a) => (
        <List.Item style={{ padding: "6px 12px" }}>
          <span style={{ color: LEVEL_COLORS[a.level] || "inherit", fontWeight: 600, marginRight: 6 }}>[{a.level}]</span>
          <span style={{ marginRight: 8 }}>{a.userId}</span>
          <span style={{ color: "var(--semi-color-text-2)" }}>{a.message}</span>
        </List.Item>
      )}
    />
  );

  return (
    <Popover content={content} trigger="click" position="bottomRight" style={{ maxWidth: 400 }}>
      <Badge count={alerts.length} overflowCount={99}>
        <IconBell size="large" style={{ cursor: "pointer", color: "var(--semi-color-text-2)" }} />
      </Badge>
    </Popover>
  );
}
