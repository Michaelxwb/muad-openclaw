import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal, Space, Table, Tag, TextArea, Toast } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import type { HumanUser, Platform, PlatformCredential } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { FeedbackBanner } from "../ConsolePage";
import { errorMessage } from "../../utils/error";
import i18n from "../../i18n";
import { Field } from "./shared";

interface Props {
  user: HumanUser;
}

interface CredentialRow {
  rowId: string;
  platform: Platform;
  credential?: PlatformCredential;
}

export function PlatformCredentialManager({ user }: Props) {
  const { t } = useTranslation();
  const state = useCredentialRows(user.humanUserId);
  const [editing, setEditing] = useState<CredentialRow | null>(null);
  const [deleting, setDeleting] = useState<CredentialRow | null>(null);
  return (
    <div>
      <FeedbackBanner error={state.error} />
      <Table
        columns={credentialColumns(t, setEditing, setDeleting) as never}
        dataSource={state.rows}
        rowKey="rowId"
        loading={state.loading}
        pagination={false}
        size="small"
      />
      <CredentialEditorDialog
        user={user}
        row={editing}
        onClose={() => setEditing(null)}
        onSaved={state.refresh}
      />
      <DeleteCredentialDialog
        user={user}
        row={deleting}
        onClose={() => setDeleting(null)}
        onSaved={state.refresh}
      />
    </div>
  );
}

function useCredentialRows(humanUserId: string) {
  const [rows, setRows] = useState<CredentialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (mountedRef.current) {
      setLoading(true);
      setError("");
    }
    try {
      const [platforms, credentials] = await Promise.all([
        api.listPlatforms(),
        api.listPlatformCredentials(humanUserId),
      ]);
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setRows(
        platforms.items.map((platform) => ({
          rowId: platform.platform,
          platform,
          credential: credentials.items.find((item) => item.platform === platform.platform),
        })),
      );
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(errorMessage(caught, "user.loadCredentialsFailed"));
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [humanUserId, mountedRef]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { rows, loading, error, refresh };
}

function credentialColumns(
  t: (key: string) => string,
  onEdit: (row: CredentialRow) => void,
  onDelete: (row: CredentialRow) => void,
) {
  return [
    {
      title: t("user.columnPlatform"),
      key: "platform",
      render: (_: unknown, row: CredentialRow) => (
        <div>
          <strong>{row.platform.displayName}</strong>
          <div className="mono">{row.platform.platform}</div>
        </div>
      ),
    },
    {
      title: t("user.columnPlatformStatus"),
      key: "platformStatus",
      render: (_: unknown, row: CredentialRow) => (
        <Tag color={row.platform.enabled ? "green" : "grey"}>
          {row.platform.enabled ? t("status.active") : t("status.disabled")}
        </Tag>
      ),
    },
    {
      title: t("user.columnCredentialFingerprint"),
      key: "credential",
      render: (_: unknown, row: CredentialRow) =>
        row.credential ? (
          <span className="mono">{row.credential.credentialFingerprint}</span>
        ) : (
          t("user.notConfigured")
        ),
    },
    {
      title: t("common.updatedAt"),
      key: "updatedAt",
      render: (_: unknown, row: CredentialRow) =>
        row.credential ? new Date(row.credential.updatedAt).toLocaleString() : "-",
    },
    {
      title: t("common.actions"),
      key: "actions",
      render: (_: unknown, row: CredentialRow) => (
        <Space>
          <Button size="small" onClick={() => onEdit(row)}>
            {row.credential ? t("user.overwrite") : t("user.configure")}
          </Button>
          <Button
            size="small"
            type="danger"
            disabled={!row.credential}
            onClick={() => onDelete(row)}
          >
            {t("common.delete")}
          </Button>
        </Space>
      ),
    },
  ];
}

interface CredentialDialogProps {
  user: HumanUser;
  row: CredentialRow | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

function CredentialEditorDialog(props: CredentialDialogProps) {
  const { t } = useTranslation();
  const [credentialsJSON, setCredentialsJSON] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!props.row) return;
    setCredentialsJSON("{}");
    setError("");
  }, [props.row]);
  const submit = async () => {
    if (!props.row) return;
    const credentials = parseCredentials(credentialsJSON);
    if (typeof credentials === "string") {
      setError(credentials);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.putPlatformCredential(
        props.user.humanUserId,
        props.row.platform.platform,
        credentials,
      );
      props.onClose();
      Toast.success(t("user.credentialSaved"));
      await props.onSaved();
    } catch (caught) {
      setError(errorMessage(caught, "user.saveCredentialFailed"));
    } finally {
      setCredentialsJSON("{}");
      setBusy(false);
    }
  };
  return (
    <Modal
      className="standard-modal"
      title={t("user.credentialEditorTitle", {
        action: props.row?.credential ? t("user.overwrite") : t("user.configure"),
        name: props.row?.platform.displayName ?? "",
      })}
      visible={props.row !== null}
      onCancel={props.onClose}
      onOk={() => void submit()}
      okText={t("common.save")}
      confirmLoading={busy}
    >
      <FeedbackBanner error={error} />
      <Field label={t("user.credentialJson")}>
        <TextArea
          aria-label={t("user.credentialJsonAria")}
          value={credentialsJSON}
          onChange={setCredentialsJSON}
          rows={8}
        />
      </Field>
    </Modal>
  );
}

function parseCredentials(raw: string): Record<string, unknown> | string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return i18n.t("user.credentialMustBeObject");
    }
    return parsed as Record<string, unknown>;
  } catch (caught) {
    return caught instanceof Error
      ? i18n.t("user.credentialJsonInvalidWithDetail", { message: caught.message })
      : i18n.t("user.credentialJsonInvalid");
  }
}

function DeleteCredentialDialog(props: CredentialDialogProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    if (!props.row) return;
    setBusy(true);
    setError("");
    try {
      await api.deletePlatformCredential(props.user.humanUserId, props.row.platform.platform);
      props.onClose();
      Toast.success(t("user.credentialDeleted"));
      await props.onSaved();
    } catch (caught) {
      setError(errorMessage(caught, "user.deleteCredentialFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      className="standard-modal"
      title={t("user.deleteCredentialTitle", { name: props.row?.platform.displayName ?? "" })}
      visible={props.row !== null}
      onCancel={props.onClose}
      onOk={() => void remove()}
      okText={t("common.confirmDelete")}
      confirmLoading={busy}
      okButtonProps={{ type: "danger" as const }}
    >
      <FeedbackBanner error={error} />
      {t("user.deleteCredentialConfirm")}
    </Modal>
  );
}
