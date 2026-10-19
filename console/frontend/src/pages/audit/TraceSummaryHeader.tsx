import { useMemo } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Tag, Typography } from "@douyinfe/semi-ui";
import type { SkillExecutionMetrics, SkillTraceEvent } from "../../api";
import { formatDuration } from "./TraceTimeline";
import styles from "../Audit.module.css";

interface Props {
  metrics?: SkillExecutionMetrics | null;
  events: SkillTraceEvent[];
}

export function TraceSummaryHeader({ metrics, events }: Props) {
  const { t } = useTranslation();
  const duration = useMemo(() => traceDuration(events), [events]);
  return (
    <section className={styles.traceSummary}>
      {(metrics?.aborted || metrics?.detailTruncated) && (
        <div className={styles.traceBadges}>
          {metrics?.aborted && (
            <Tag color="red" size="large">
              {t("audit.trace.aborted")}
            </Tag>
          )}
          {metrics?.detailTruncated && (
            <Tag color="orange" size="large">
              {t("audit.trace.truncated", { count: metrics.requestCount })}
            </Tag>
          )}
        </div>
      )}
      {metrics?.aborted && metrics.abortInterface && (
        <Typography.Text type="danger" className={styles.traceAbortDetail}>
          {t("audit.trace.abortedWith", {
            iface: metrics.abortInterface,
            count: metrics.abortCount ?? metrics.requestCount,
          })}
        </Typography.Text>
      )}
      <div className={styles.traceMetrics}>
        <Metric label={t("audit.trace.requestCount")}>
          <span data-testid="trace-request-count">{metrics ? metrics.requestCount : "-"}</span>
        </Metric>
        <Metric label={t("audit.trace.errorCount")}>
          <span data-testid="trace-error-count">{metrics ? metrics.errorCount : "-"}</span>
        </Metric>
        <Metric label={t("audit.trace.duration")}>
          <span data-testid="trace-duration">{formatDuration(duration)}</span>
        </Metric>
      </div>
      <div className={styles.traceInterfaces}>
        <Typography.Text strong>{t("audit.trace.topInterfaces")}</Typography.Text>
        {metrics && metrics.topInterfaces.length > 0 ? (
          <ul className={styles.traceInterfaceList}>
            {metrics.topInterfaces.map((item) => (
              <li key={`${item.method} ${item.host} ${item.path}`}>
                <span className="mono">
                  {item.method} {item.host} {item.path}
                </span>
                <span className={styles.traceInterfaceCount}>× {item.count}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Typography.Text type="tertiary">-</Typography.Text>
        )}
      </div>
    </section>
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.traceMetric}>
      <span className={styles.traceMetricLabel}>{label}</span>
      <span className={styles.traceMetricValue}>{children}</span>
    </div>
  );
}

function traceDuration(events: SkillTraceEvent[]): number | undefined {
  const timestamps = events
    .map((event) => new Date(event.occurredAt).getTime())
    .filter((value) => Number.isFinite(value));
  if (timestamps.length >= 2) return Math.max(...timestamps) - Math.min(...timestamps);
  return events[0]?.durationMs;
}
