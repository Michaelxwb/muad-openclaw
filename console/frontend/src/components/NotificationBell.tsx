import { useCallback, useEffect, useState } from "react";
import { Badge, Banner, Button, Empty, List, Popover } from "@douyinfe/semi-ui";
import { IconBell, IconRefresh } from "@douyinfe/semi-icons";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api";
import type { Alert } from "../api";
import { errorMessage, ErrorDetail } from "../utils/error";
import { useMountedRef } from "../hooks/useMountedRef";
import styles from "./NotificationBell.module.css";

const LEVEL_COLORS: Record<Alert["level"], string> = {
  P1: "var(--semi-color-danger)",
  P2: "var(--semi-color-warning)",
  P3: "var(--semi-color-text-2)",
};
const ALERTS_REFRESH_EVENT = "muad:alerts-refresh";

interface Props {
  loadAlerts?: () => Promise<Alert[]>;
}

export function requestAlertsRefresh() {
  window.dispatchEvent(new Event(ALERTS_REFRESH_EVENT));
}

export function NotificationBell({ loadAlerts = api.alerts }: Props) {
  const { t } = useTranslation();
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
        <div className={styles.panel} role="dialog" aria-label={t("common.alertsListAria")}>
          <div className={styles.panelHeader}>
            <span>{t("common.alerts")}</span>
            <Button
              aria-label={t("common.refreshAlerts")}
              icon={<IconRefresh />}
              theme="borderless"
              size="small"
              onClick={state.refresh}
            />
          </div>
          {state.error && (
            <>
              <Banner type="danger" description={state.error} fullMode={false} bordered />
              <ErrorDetail detail={state.errorDetail} />
            </>
          )}
          <AlertList alerts={state.alerts} />
        </div>
      }
    >
      <Button
        aria-label={t("common.alerts")}
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
  const [errorDetail, setErrorDetail] = useState<string | undefined>();
  const mountedRef = useMountedRef();
  const refresh = useCallback(() => {
    void loadAlerts().then(
      (result) => {
        if (mountedRef.current) {
          setAlerts(result);
          setError("");
          setErrorDetail(undefined);
        }
      },
      (caught: unknown) => {
        if (mountedRef.current) {
          setError(errorMessage(caught, "common.alertsLoadFailed"));
          setErrorDetail(caught instanceof ApiError ? caught.detail : undefined);
        }
      },
    );
  }, [loadAlerts, mountedRef]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30000);
    window.addEventListener(ALERTS_REFRESH_EVENT, refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener(ALERTS_REFRESH_EVENT, refresh);
    };
  }, [refresh]);
  return { alerts, error, errorDetail, refresh };
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
  const { t } = useTranslation();
  if (alerts.length === 0) return <Empty description={t("common.noAlerts")} />;
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
  const { t } = useTranslation();
  if (!alert.details) return null;
  const details = [
    detail(alert, "generation", t("common.alertExpected")),
    detail(alert, "appliedGeneration", t("common.alertApplied")),
    detail(alert, "active", t("status.running")),
    detail(alert, "queued", t("common.alertQueued")),
    detail(alert, "limit", t("common.alertLimit")),
    detail(alert, "count", t("common.alertCount")),
    detail(alert, "error", t("status.error")),
  ].filter((value): value is string => Boolean(value));
  return details.length > 0 ? <span className={styles.details}>{details.join(" · ")}</span> : null;
}

function detail(alert: Alert, key: string, label: string): string | null {
  const value = alert.details?.[key];
  return typeof value === "string" || typeof value === "number" ? `${label} ${value}` : null;
}
