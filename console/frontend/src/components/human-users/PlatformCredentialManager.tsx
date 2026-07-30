import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal, Space, Table, Tag, TextArea, Toast } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type { HumanUser, Platform, PlatformCredential } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { FeedbackBanner } from "../ConsolePage";
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
  const state = useCredentialRows(user.humanUserId);
  const [editing, setEditing] = useState<CredentialRow | null>(null);
  const [deleting, setDeleting] = useState<CredentialRow | null>(null);
  return (
    <div>
      <FeedbackBanner error={state.error} />
      <Table
        columns={credentialColumns(setEditing, setDeleting) as never}
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
      setError(caught instanceof Error ? caught.message : "加载平台凭证失败");
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
  onEdit: (row: CredentialRow) => void,
  onDelete: (row: CredentialRow) => void,
) {
  return [
    {
      title: "平台",
      key: "platform",
      render: (_: unknown, row: CredentialRow) => (
        <div>
          <strong>{row.platform.displayName}</strong>
          <div className="mono">{row.platform.platform}</div>
        </div>
      ),
    },
    {
      title: "平台状态",
      key: "platformStatus",
      render: (_: unknown, row: CredentialRow) => (
        <Tag color={row.platform.enabled ? "green" : "grey"}>
          {row.platform.enabled ? "已启用" : "已停用"}
        </Tag>
      ),
    },
    {
      title: "认证指纹",
      key: "credential",
      render: (_: unknown, row: CredentialRow) =>
        row.credential ? (
          <span className="mono">{row.credential.credentialFingerprint}</span>
        ) : (
          "未配置"
        ),
    },
    {
      title: "更新时间",
      key: "updatedAt",
      render: (_: unknown, row: CredentialRow) =>
        row.credential ? new Date(row.credential.updatedAt).toLocaleString() : "-",
    },
    {
      title: "操作",
      key: "actions",
      render: (_: unknown, row: CredentialRow) => (
        <Space>
          <Button size="small" onClick={() => onEdit(row)}>
            {row.credential ? "覆盖" : "配置"}
          </Button>
          <Button
            size="small"
            type="danger"
            disabled={!row.credential}
            onClick={() => onDelete(row)}
          >
            删除
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
      Toast.success("平台凭证已保存");
      await props.onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存平台凭证失败");
    } finally {
      setCredentialsJSON("{}");
      setBusy(false);
    }
  };
  return (
    <Modal
      className="standard-modal"
      title={`${props.row?.credential ? "覆盖" : "配置"} ${props.row?.platform.displayName ?? ""} 认证信息`}
      visible={props.row !== null}
      onCancel={props.onClose}
      onOk={() => void submit()}
      okText="保存"
      confirmLoading={busy}
    >
      <FeedbackBanner error={error} />
      <Field label="认证 JSON">
        <TextArea
          aria-label="业务平台认证 JSON"
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
      return "认证信息必须是 JSON 对象";
    }
    return parsed as Record<string, unknown>;
  } catch (caught) {
    return caught instanceof Error ? `认证 JSON 无效：${caught.message}` : "认证 JSON 无效";
  }
}

function DeleteCredentialDialog(props: CredentialDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    if (!props.row) return;
    setBusy(true);
    setError("");
    try {
      await api.deletePlatformCredential(props.user.humanUserId, props.row.platform.platform);
      props.onClose();
      Toast.success("平台凭证已删除");
      await props.onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除平台凭证失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      className="standard-modal"
      title={`删除 ${props.row?.platform.displayName ?? ""} API Key`}
      visible={props.row !== null}
      onCancel={props.onClose}
      onOk={() => void remove()}
      okText="确认删除"
      confirmLoading={busy}
      okButtonProps={{ type: "danger" as const }}
    >
      <FeedbackBanner error={error} />
      删除后，该用户调用对应平台 Skill 时将无法解析认证信息。
    </Modal>
  );
}
