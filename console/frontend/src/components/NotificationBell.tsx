import { useCallback, useEffect, useState } from "react";
import { Badge, Banner, Button, Empty, List, Popover } from "@douyinfe/semi-ui";
import { IconBell, IconRefresh } from "@douyinfe/semi-icons";
import { api } from "../api";
import type { Alert } from "../api";
import { useMountedRef } from "../hooks/useMountedRef";
import styles from "./NotificationBell.module.css";

const LEVEL_COLORS: Record<Alert["level"], string> = {
  P1: "var(--semi-color-danger)",
  P2: "var(--semi-color-warning)",
  P3: "var(--semi-color-text-2)",
};

interface Props {
  loadAlerts?: () => Promise<Alert[]>;
}

export function NotificationBell({ loadAlerts = api.alerts }: Props) {
  const state = useAlerts(loadAlerts);
  const [open, setOpen] = useState(false);
  return (
    <Popover
      trigger="click"
      position="bottomRight"
      visible={open}
      onVisibleChange={setOpen}
      closeOnEsc
      contentClassName={styles.popover}
      content={
        <div className={styles.panel} role="dialog" aria-label="告警列表">
          <div className={styles.panelHeader}>
            <span>告警</span>
            <Button
              aria-label="刷新告警"
              icon={<IconRefresh />}
              theme="borderless"
              size="small"
              onClick={state.refresh}
            />
          </div>
          {state.error && (
            <Banner type="danger" description={state.error} fullMode={false} bordered />
          )}
          <AlertList alerts={state.alerts} />
        </div>
      }
    >
      <Button
        aria-label="告警"
        aria-expanded={open}
        icon={<BellIcon count={state.alerts.length} />}
        theme="borderless"
        size="small"
      />
    </Popover>
  );
}

function useAlerts(loadAlerts: () => Promise<Alert[]>) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState("");
  const mountedRef = useMountedRef();
  const refresh = useCallback(() => {
    void loadAlerts().then(
      (result) => {
        if (mountedRef.current) {
          setAlerts(result);
          setError("");
        }
      },
      (caught: unknown) => {
        if (mountedRef.current) {
          setError(caught instanceof Error ? caught.message : "加载告警失败");
        }
      },
    );
  }, [loadAlerts, mountedRef]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { alerts, error, refresh };
}

function BellIcon({ count }: { count: number }) {
  const icon = <IconBell style={{ color: "var(--semi-color-text-2)" }} />;
  if (count === 0) return icon;
  return (
    <Badge
      count={count}
      overflowCount={99}
      countStyle={{ fontSize: 10, height: 14, lineHeight: "14px" }}
    >
      {icon}
    </Badge>
  );
}

function AlertList({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) return <Empty description="暂无告警" />;
  return (
    <List
      dataSource={alerts}
      renderItem={(alert) => (
        <List.Item className={styles.item}>
          <span style={{ color: LEVEL_COLORS[alert.level] }} className={styles.level}>
            [{alert.level}]
          </span>
          <div className={styles.body}>
            <strong>{alert.podId}</strong>
            <span>{alert.message}</span>
            <AlertDetails alert={alert} />
          </div>
        </List.Item>
      )}
    />
  );
}

function AlertDetails({ alert }: { alert: Alert }) {
  if (!alert.details) return null;
  const details = [
    detail(alert, "generation", "期望"),
    detail(alert, "appliedGeneration", "已应用"),
    detail(alert, "active", "运行中"),
    detail(alert, "queued", "排队"),
    detail(alert, "limit", "上限"),
    detail(alert, "count", "次数"),
  ].filter((value): value is string => Boolean(value));
  return details.length > 0 ? <span className={styles.details}>{details.join(" · ")}</span> : null;
}

function detail(alert: Alert, key: string, label: string): string | null {
  const value = alert.details?.[key];
  return typeof value === "string" || typeof value === "number" ? `${label} ${value}` : null;
}
