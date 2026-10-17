import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Banner, Button, Empty, SideSheet, Spin } from "@douyinfe/semi-ui";
import { api, ApiError } from "../../api";
import type { SkillExecutionTrace } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { ErrorDetail, errorMessage } from "../../utils/error";
import { TraceSummaryHeader } from "./TraceSummaryHeader";
import { TraceTimeline } from "./TraceTimeline";
import styles from "../Audit.module.css";

const TRACE_DRAWER_WIDTH = 720;

interface Props {
  executionId: string;
  visible: boolean;
  onClose: () => void;
}

export function ExecutionTraceDrawer({ executionId, visible, onClose }: Props) {
  const { t } = useTranslation();
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const [trace, setTrace] = useState<SkillExecutionTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError("");
    setErrorDetail(undefined);
    try {
      const result = await api.getSkillExecutionTrace(executionId);
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setTrace(result);
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setTrace(null);
      setError(
        caught instanceof ApiError && caught.status === 404
          ? t("audit.trace.notFound")
          : errorMessage(caught, "audit.trace.loadFailed"),
      );
      setErrorDetail(caught instanceof ApiError ? caught.detail : undefined);
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [executionId, mountedRef, t]);

  useEffect(() => {
    if (!visible || !executionId) {
      requestRef.current += 1;
      return;
    }
    void load();
  }, [executionId, load, visible]);

  const showContent = !loading && error === "" && trace !== null;
  return (
    <SideSheet
      title={
        executionId
          ? `${t("audit.trace.drawerTitle")} · ${executionId}`
          : t("audit.trace.drawerTitle")
      }
      visible={visible}
      onCancel={onClose}
      width={TRACE_DRAWER_WIDTH}
    >
      <div className={styles.traceDrawer}>
        {loading && (
          <div className={styles.detailLoading}>
            <Spin size="large" />
          </div>
        )}
        {!loading && error !== "" && (
          <div className={styles.error}>
            <Banner type="danger" description={error} fullMode={false} bordered closeIcon={null} />
            <ErrorDetail detail={errorDetail} />
            <Button onClick={() => void load()}>{t("audit.trace.retry")}</Button>
          </div>
        )}
        {showContent && trace && <TraceContent trace={trace} />}
      </div>
    </SideSheet>
  );
}

function TraceContent({ trace }: { trace: SkillExecutionTrace }) {
  const { t } = useTranslation();
  const legacy = isLegacyExecOnly(trace);
  return (
    <>
      {legacy && (
        <Banner
          className={styles.traceLegacyHint}
          type="info"
          description={t("audit.trace.legacyHint")}
          fullMode={false}
          bordered
          closeIcon={null}
        />
      )}
      <TraceSummaryHeader metrics={trace.metrics} events={trace.events} />
      {trace.events.length > 0 ? (
        <TraceTimeline events={trace.events} />
      ) : (
        <Empty title={t("audit.trace.empty")} />
      )}
    </>
  );
}

function isLegacyExecOnly(trace: SkillExecutionTrace): boolean {
  if (trace.metrics || trace.events.length === 0) return false;
  return trace.events.every((event) => event.kind === "exec");
}
