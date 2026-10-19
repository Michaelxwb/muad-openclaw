import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Banner,
  Button,
  Modal,
  Space,
  Spin,
  Table,
  Tag,
  Toast,
  Tooltip,
  Typography,
} from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api";
import type {
  Identity,
  SessionCancelOutcome,
  SessionCancelPreview,
  SessionCancelProcess,
  SessionCancelProcessResult,
  SessionCancelResultData,
  SessionCancelSkipped,
} from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { errorMessage } from "../../utils/error";
import styles from "./SessionCancelDialog.module.css";

const { Text } = Typography;

export const CMDLINE_LIMIT = 200;

const REASON_KEYS: Record<string, string> = {
  identity_changed: "sessionCancel.reasonIdentityChanged",
  fingerprint_mismatch: "sessionCancel.reasonFingerprintMismatch",
  not_found: "sessionCancel.reasonNotFound",
  protected: "sessionCancel.reasonProtected",
  not_expected: "sessionCancel.reasonNotExpected",
  already_exited: "sessionCancel.reasonAlreadyExited",
  permission_denied: "sessionCancel.reasonPermissionDenied",
  env_mismatch: "sessionCancel.reasonEnvMismatch",
  sigterm: "sessionCancel.reasonSigterm",
  sigkill: "sessionCancel.reasonSigkill",
  still_running: "sessionCancel.reasonStillRunning",
  unreadable: "sessionCancel.reasonUnreadable",
  empty_cmdline: "sessionCancel.reasonEmptyCmdline",
  not_owner: "sessionCancel.reasonNotOwner",
};

const OUTCOME_META: Record<
  SessionCancelOutcome,
  { key: string; color: "green" | "orange" | "grey" }
> = {
  terminated: { key: "sessionCancel.outcomeTerminated", color: "green" },
  killed: { key: "sessionCancel.outcomeKilled", color: "orange" },
  skipped: { key: "sessionCancel.outcomeSkipped", color: "grey" },
};

// Command lines are truncated before rendering; the tooltip repeats the
// truncated value so the original command is never exposed.
export function truncateCmdline(cmdline: string): string {
  return cmdline.length > CMDLINE_LIMIT ? `${cmdline.slice(0, CMDLINE_LIMIT)}…` : cmdline;
}

interface PreviewState {
  loading: boolean;
  error: string;
  data: SessionCancelPreview | null;
}

interface CancelState {
  busy: boolean;
  error: string;
  stale: boolean;
  result: SessionCancelResultData | null;
}

const EMPTY_PREVIEW: PreviewState = { loading: false, error: "", data: null };
const EMPTY_CANCEL: CancelState = { busy: false, error: "", stale: false, result: null };

export interface SessionCancelDialogProps {
  visible: boolean;
  humanUserId: string;
  identity: Identity;
  onClose: () => void;
  onCancelled?: () => void;
}

// Container component: owns preview/cancel requests and state. Presentational
// children (summary, process table, result table) never perform network I/O.
export function SessionCancelDialog({
  visible,
  humanUserId,
  identity,
  onClose,
  onCancelled,
}: SessionCancelDialogProps) {
  const { t } = useTranslation();
  const mountedRef = useMountedRef();
  const previewRequestRef = useRef(0);
  const submitLockRef = useRef(false);
  const [previewState, setPreviewState] = useState<PreviewState>(EMPTY_PREVIEW);
  const [cancelState, setCancelState] = useState<CancelState>(EMPTY_CANCEL);

  const errorFor = useCallback(
    (caught: unknown, fallbackKey: string): string => {
      if (caught instanceof ApiError) {
        switch (caught.code) {
          case 41007:
            return t("sessionCancel.unsupported");
          case 41008:
            return t("sessionCancel.notFound");
          case 41009:
            return t("sessionCancel.stale");
          case 41010:
            return t("sessionCancel.failed");
        }
      }
      return errorMessage(caught, fallbackKey);
    },
    [t],
  );

  const loadPreview = useCallback(async () => {
    const requestId = ++previewRequestRef.current;
    if (mountedRef.current) {
      setPreviewState({ loading: true, error: "", data: null });
      setCancelState(EMPTY_CANCEL);
    }
    try {
      const data = await api.previewSessionCancel(humanUserId, identity.identityId);
      if (!mountedRef.current || requestId !== previewRequestRef.current) return;
      setPreviewState({ loading: false, error: "", data });
    } catch (caught) {
      if (!mountedRef.current || requestId !== previewRequestRef.current) return;
      setPreviewState({
        loading: false,
        error: errorFor(caught, "sessionCancel.loadFailed"),
        data: null,
      });
    }
  }, [humanUserId, identity.identityId, mountedRef, errorFor]);

  useEffect(() => {
    if (visible) void loadPreview();
  }, [visible, loadPreview]);

  useEffect(() => {
    if (visible) return;
    previewRequestRef.current += 1;
    setPreviewState(EMPTY_PREVIEW);
    setCancelState(EMPTY_CANCEL);
  }, [visible]);

  const preview = previewState.data;
  const processCount = preview?.processes.length ?? 0;
  const runActive = preview?.activeRun.active ?? false;
  const canConfirm =
    Boolean(preview) &&
    !previewState.loading &&
    !previewState.error &&
    !cancelState.busy &&
    !cancelState.result &&
    !cancelState.stale &&
    (runActive || processCount > 0);

  const confirm = async () => {
    if (!preview || submitLockRef.current || !canConfirm) return;
    submitLockRef.current = true;
    setCancelState({ busy: true, error: "", stale: false, result: null });
    try {
      const expected = preview.processes.map(({ pid, fingerprint }) => ({ pid, fingerprint }));
      const result = await api.cancelSession(humanUserId, identity.identityId, expected);
      if (!mountedRef.current) return;
      setCancelState({ busy: false, error: "", stale: false, result });
      const partial =
        result.remaining.length > 0 ||
        (result.processes.some((item) => item.outcome === "skipped") &&
          !result.aborted &&
          !result.confirmed);
      if (partial) {
        Toast.warning(t("sessionCancel.partial"));
      } else {
        Toast.success(t("sessionCancel.cancelled"));
      }
      if (result.confirmed || result.killed > 0) onCancelled?.();
    } catch (caught) {
      if (!mountedRef.current) return;
      const stale = caught instanceof ApiError && caught.code === 41009;
      setCancelState({
        busy: false,
        error: errorFor(caught, "sessionCancel.failed"),
        stale,
        result: null,
      });
    } finally {
      submitLockRef.current = false;
    }
  };

  const warning =
    runActive && processCount > 0
      ? t("sessionCancel.warningRunProcesses", { count: processCount })
      : processCount > 0
        ? t("sessionCancel.warningProcesses", { count: processCount })
        : t("sessionCancel.warningRun");

  return (
    <Modal
      className={`standard-modal ${styles.dialog}`}
      title={t("sessionCancel.title")}
      width={900}
      visible={visible}
      onCancel={onClose}
      footer={
        <div className={styles.footer}>
          <Button onClick={onClose}>{t("common.close")}</Button>
          <Button
            type="danger"
            loading={cancelState.busy}
            disabled={!canConfirm}
            aria-label={t("sessionCancel.confirmAria", { count: processCount })}
            onClick={() => void confirm()}
          >
            {t("sessionCancel.confirm")}
          </Button>
        </div>
      }
    >
      {previewState.loading ? (
        <div className={styles.centered}>
          <Spin />
          <Text type="tertiary">{t("sessionCancel.loading")}</Text>
        </div>
      ) : previewState.error ? (
        <div className={styles.errorBlock}>
          <Banner type="danger" description={previewState.error} fullMode={false} bordered />
          <Button onClick={() => void loadPreview()}>{t("common.retry")}</Button>
        </div>
      ) : preview ? (
        <>
          <SessionSummary preview={preview} />
          {cancelState.error ? (
            <div className={styles.errorBlock}>
              <Banner type="danger" description={cancelState.error} fullMode={false} bordered />
              {cancelState.stale ? (
                <Button onClick={() => void loadPreview()}>{t("sessionCancel.rePreview")}</Button>
              ) : null}
            </div>
          ) : null}
          <ProcessPreviewTable processes={preview.processes} skipped={preview.skipped} />
          {cancelState.result ? (
            <SessionCancelResult result={cancelState.result} />
          ) : !runActive && processCount === 0 ? (
            <Text type="tertiary" className={styles.empty}>
              {t("sessionCancel.empty")}
            </Text>
          ) : (
            <Banner
              type="warning"
              description={warning}
              fullMode={false}
              bordered
              className={styles.warning}
            />
          )}
        </>
      ) : null}
    </Modal>
  );
}

function SessionSummary({ preview }: { preview: SessionCancelPreview }) {
  const { t } = useTranslation();
  return (
    <div className={styles.summary}>
      <div className={styles.summaryRow}>
        <span className={styles.summaryLabel}>{t("sessionCancel.sessionKey")}</span>
        <span className={`mono ${styles.summaryValue}`}>{preview.sessionKey}</span>
      </div>
      <div className={styles.summaryRow}>
        <span className={styles.summaryLabel}>{t("sessionCancel.agent")}</span>
        <span className={styles.summaryValue}>{preview.agentId}</span>
      </div>
      <div className={styles.summaryRow}>
        <span className={styles.summaryLabel}>{t("sessionCancel.activeRun")}</span>
        <Space>
          <Tag className={styles.runTag} color={preview.activeRun.active ? "green" : "grey"}>
            {preview.activeRun.active ? t("sessionCancel.runActive") : t("sessionCancel.runIdle")}
          </Tag>
          {preview.activeRun.sessionId ? (
            <Text type="tertiary" className={`mono ${styles.summaryValue}`}>
              {t("sessionCancel.runSessionId")}: {preview.activeRun.sessionId}
            </Text>
          ) : null}
        </Space>
      </div>
    </div>
  );
}

export interface ProcessPreviewTableProps {
  processes: SessionCancelProcess[];
  skipped: SessionCancelSkipped;
}

export function ProcessPreviewTable({ processes, skipped }: ProcessPreviewTableProps) {
  const { t } = useTranslation();
  const skippedTotal = skipped.notOwner + skipped.envMismatch + skipped.permissionDenied;
  const columns = useMemo(
    () => [
      {
        title: t("sessionCancel.columnPid"),
        dataIndex: "pid",
        key: "pid",
        width: 80,
      },
      {
        title: t("sessionCancel.columnPgid"),
        dataIndex: "pgid",
        key: "pgid",
        width: 80,
      },
      {
        title: t("sessionCancel.columnLeader"),
        key: "leader",
        width: 96,
        render: (_: unknown, row: SessionCancelProcess) => (
          <Tag color={row.leader ? "green" : "grey"}>
            {row.leader ? t("sessionCancel.leaderYes") : t("sessionCancel.leaderNo")}
          </Tag>
        ),
      },
      {
        title: t("sessionCancel.columnAge"),
        key: "ageSeconds",
        width: 120,
        render: (_: unknown, row: SessionCancelProcess) => (
          <span className={styles.nowrap}>
            {row.ageSeconds < 60
              ? t("sessionCancel.ageSeconds", { count: row.ageSeconds })
              : t("sessionCancel.ageMinutes", {
                  minutes: Math.floor(row.ageSeconds / 60),
                  seconds: row.ageSeconds % 60,
                })}
          </span>
        ),
      },
      {
        title: t("sessionCancel.columnCommand"),
        key: "cmdline",
        width: 420,
        ellipsis: { showTitle: true },
        render: (_: unknown, row: SessionCancelProcess) => {
          const command = truncateCmdline(row.cmdline);
          return (
            <Tooltip content={command}>
              <span className={`mono ${styles.cmdline}`}>{command}</span>
            </Tooltip>
          );
        },
      },
    ],
    [t],
  );

  return (
    <div className={styles.processSection}>
      <div className={styles.sectionTitle}>
        {t("sessionCancel.processSection", { count: processes.length })}
      </div>
      {skippedTotal > 0 ? (
        <div className={styles.skippedNote}>
          <Tag color="grey">{t("sessionCancel.skippedSummary", { count: skippedTotal })}</Tag>
          <Text type="tertiary">{t("sessionCancel.skippedDetail")}</Text>
        </div>
      ) : null}
      <Table
        rowKey="pid"
        columns={columns as never}
        dataSource={processes}
        pagination={false}
        size="small"
        scroll={{ x: 820 }}
        empty={t("sessionCancel.emptyProcesses")}
      />
    </div>
  );
}

export interface SessionCancelResultProps {
  result: SessionCancelResultData;
}

export function SessionCancelResult({ result }: SessionCancelResultProps) {
  const { t } = useTranslation();
  const reasonText = (reason?: string): string => {
    if (!reason) return "";
    const key = REASON_KEYS[reason];
    return key ? t(key) : reason;
  };
  const columns = useMemo(
    () => [
      {
        title: t("sessionCancel.columnPid"),
        dataIndex: "pid",
        key: "pid",
        width: 90,
      },
      {
        title: t("common.status"),
        key: "outcome",
        render: (_: unknown, row: SessionCancelProcessResult) => {
          const meta = OUTCOME_META[row.outcome];
          return <Tag color={meta.color}>{t(meta.key)}</Tag>;
        },
      },
      {
        title: t("sessionCancel.resultReason"),
        key: "reason",
        render: (_: unknown, row: SessionCancelProcessResult) => reasonText(row.reason),
      },
    ],
    [t],
  );

  return (
    <div className={styles.resultSection}>
      <div className={styles.sectionTitle}>{t("sessionCancel.resultTitle")}</div>
      <Space wrap className={styles.resultTags}>
        <Tag color={result.aborted ? "green" : "grey"}>
          {t("sessionCancel.aborted")}:{" "}
          {result.aborted ? t("sessionCancel.yes") : t("sessionCancel.no")}
        </Tag>
        <Tag color={result.drained ? "green" : "orange"}>
          {t("sessionCancel.drained")}:{" "}
          {result.drained ? t("sessionCancel.yes") : t("sessionCancel.no")}
        </Tag>
        <Tag color={result.confirmed ? "green" : "orange"}>
          {t("sessionCancel.confirmed")}:{" "}
          {result.confirmed ? t("sessionCancel.yes") : t("sessionCancel.no")}
        </Tag>
      </Space>
      <div className={styles.resultSummary}>
        <Text strong>{t("sessionCancel.killed", { count: result.killed })}</Text>
        <Text type={result.remaining.length > 0 ? "danger" : "tertiary"}>
          {result.remaining.length > 0
            ? t("sessionCancel.remaining", { pids: result.remaining.join(", ") })
            : t("sessionCancel.noRemaining")}
        </Text>
      </div>
      <Table
        rowKey="pid"
        columns={columns as never}
        dataSource={result.processes}
        pagination={false}
        size="small"
      />
    </div>
  );
}
