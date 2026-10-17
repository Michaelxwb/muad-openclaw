import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button, Empty, Tag } from "@douyinfe/semi-ui";
import type { SkillTraceEvent } from "../../api";
import styles from "../Audit.module.css";

const PAGE_SIZE = 200;

interface Props {
  events: SkillTraceEvent[];
}

export function TraceTimeline({ events }: Props) {
  const { t } = useTranslation();
  const ordered = useMemo(() => [...events].sort((left, right) => left.seq - right.seq), [events]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [events]);

  if (ordered.length === 0) {
    return <Empty title={t("audit.trace.empty")} />;
  }

  const visible = ordered.slice(0, visibleCount);
  const remaining = ordered.length - visible.length;
  return (
    <div>
      <ol className={styles.traceTimeline} aria-label={t("audit.trace.timeline")}>
        {visible.map((event) => (
          <TraceEventRow key={event.eventId} event={event} />
        ))}
      </ol>
      {remaining > 0 && (
        <div className={styles.traceMore}>
          <Button size="small" onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}>
            {t("audit.trace.showMore", { count: remaining })}
          </Button>
        </div>
      )}
    </div>
  );
}

function TraceEventRow({ event }: { event: SkillTraceEvent }) {
  const { t } = useTranslation();
  const highlighted = event.kind === "abort";
  const failed = isFailureStatus(event.status) && event.kind !== "abort";
  return (
    <li
      data-testid="trace-event"
      data-event-id={event.eventId}
      data-kind={event.kind}
      data-highlighted={highlighted ? "true" : "false"}
      className={[
        styles.traceEvent,
        highlighted ? styles.traceEventAbort : "",
        failed ? styles.traceEventError : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className={styles.traceTime}>{formatTime(event.occurredAt)}</span>
      <Tag size="small" color={kindColor(event.kind)}>
        {kindLabel(t, event.kind)}
      </Tag>
      <Tag size="small" color={failed ? "red" : "grey"}>
        {event.status || "-"}
      </Tag>
      <div className={styles.traceEventBody}>
        <div className={styles.traceEventSummary}>{event.summary || "-"}</div>
        {event.detail && <pre className={styles.traceEventDetail}>{event.detail}</pre>}
      </div>
      <span className={styles.traceDuration}>{formatDuration(event.durationMs)}</span>
    </li>
  );
}

const KIND_KEYS: Record<string, string> = {
  exec: "audit.trace.kindExec",
  http: "audit.trace.kindHttp",
  output: "audit.trace.kindOutput",
  abort: "audit.trace.kindAbort",
  summary: "audit.trace.kindSummary",
};

function kindLabel(t: TFunction, kind: string): string {
  const key = KIND_KEYS[kind];
  return key ? t(key) : kind;
}

function kindColor(kind: string): "blue" | "green" | "orange" | "red" | "grey" {
  if (kind === "http") return "blue";
  if (kind === "exec") return "green";
  if (kind === "output") return "grey";
  if (kind === "abort") return "red";
  return "orange";
}

export function formatDuration(durationMs?: number): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return "-";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function isFailureStatus(status: string): boolean {
  if (status === "" || status === "ok" || status === "success" || status === "aborted")
    return false;
  const numeric = Number(status);
  if (Number.isFinite(numeric)) return numeric >= 400;
  return true;
}
