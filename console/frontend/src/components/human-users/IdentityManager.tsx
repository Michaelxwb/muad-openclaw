import { useEffect, useState } from "react";
import { Button, Input, Modal, Select, Space, Table, Toast } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type { HumanUser, Identity, IdentityInput } from "../../api";
import { channelMeta } from "../../channels";
import { FeedbackBanner } from "../ConsolePage";
import styles from "../HumanUsersPanel.module.css";
import { Field, UserStatusTag } from "./shared";

interface Props {
  user: HumanUser;
  identities: Identity[];
  channels: string[];
  onChanged: () => Promise<void>;
}

export function IdentityManager({ user, identities, channels, onChanged }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Identity | null>(null);
  const actions = useIdentityActions(user, pendingDelete, setPendingDelete, onChanged);

  return (
    <div>
      <FeedbackBanner error={actions.error} />
      <div className={styles.toolbar}>
        <span>Identity 按 channel、account 和 external ID 作用域唯一。</span>
        <Button theme="solid" onClick={() => setCreateOpen(true)}>
          新增 Identity
        </Button>
      </div>
      <Table
        columns={identityColumns(actions.busyId, actions.setStatus, setPendingDelete) as never}
        dataSource={identities}
        rowKey="identityId"
        pagination={false}
        size="small"
      />
      <CreateIdentityDialog
        user={user}
        channels={channels}
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={onChanged}
      />
      <DeleteIdentityDialog
        identity={pendingDelete}
        busy={Boolean(pendingDelete && actions.busyId === pendingDelete.identityId)}
        onClose={() => setPendingDelete(null)}
        onDelete={() => void actions.remove()}
      />
    </div>
  );
}

function useIdentityActions(
  user: HumanUser,
  pendingDelete: Identity | null,
  setPendingDelete: (identity: Identity | null) => void,
  onChanged: () => Promise<void>,
) {
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const run = async (identityId: string, action: () => Promise<void>) => {
    setBusyId(identityId);
    setError("");
    try {
      await action();
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Identity 操作失败");
    } finally {
      setBusyId("");
    }
  };
  const setStatus = async (identity: Identity) => {
    const status = identity.status === "active" ? "disabled" : "active";
    await run(identity.identityId, async () => {
      await api.setIdentityStatus(user.humanUserId, identity.identityId, status);
      Toast.success(status === "active" ? "Identity 已启用" : "Identity 已停用");
    });
  };
  const remove = async () => {
    if (!pendingDelete) return;
    await run(pendingDelete.identityId, async () => {
      await api.deleteIdentity(user.humanUserId, pendingDelete.identityId);
      setPendingDelete(null);
      Toast.success("Identity 已删除");
    });
  };
  return { busyId, error, setStatus, remove };
}

function identityColumns(
  busyId: string,
  onStatus: (identity: Identity) => Promise<void>,
  onDelete: (identity: Identity) => void,
) {
  return [
    {
      title: "通道 / Account",
      key: "scope",
      render: (_: unknown, identity: Identity) => (
        <div>
          <div>{channelMeta(identity.channel).label}</div>
          <div className="mono">{identity.accountId}</div>
        </div>
      ),
    },
    {
      title: "External ID",
      key: "externalId",
      render: (_: unknown, identity: Identity) => (
        <div>
          <div className="mono">{identity.externalId}</div>
          <div>{identity.externalIdType}</div>
        </div>
      ),
    },
    { title: "OpenClaw 通道", dataIndex: "openclawChannel", key: "openclawChannel" },
    {
      title: "状态",
      key: "status",
      render: (_: unknown, identity: Identity) => <UserStatusTag status={identity.status} />,
    },
    {
      title: "操作",
      key: "actions",
      render: (_: unknown, identity: Identity) => (
        <Space>
          <Button
            size="small"
            loading={busyId === identity.identityId}
            onClick={() => void onStatus(identity)}
          >
            {identity.status === "active" ? "停用" : "启用"}
          </Button>
          <Button size="small" type="danger" onClick={() => onDelete(identity)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];
}

interface CreateDialogProps {
  user: HumanUser;
  channels: string[];
  visible: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

const emptyIdentity = (channels: string[]): IdentityInput => ({
  channel: channels[0] ?? "",
  accountId: "default",
  externalId: "",
  externalIdType: "user_id",
  peerKind: "direct",
});

function CreateIdentityDialog(props: CreateDialogProps) {
  const [form, setForm] = useState<IdentityInput>(() => emptyIdentity(props.channels));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!props.visible) return;
    setForm(emptyIdentity(props.channels));
    setError("");
  }, [props.channels, props.visible]);

  const submit = async () => {
    const validation = validateIdentity(form);
    if (validation) return setError(validation);
    setBusy(true);
    setError("");
    try {
      await api.createIdentity(props.user.humanUserId, form);
      Toast.success("Identity 已新增");
      props.onClose();
      await props.onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "新增 Identity 失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      className="standard-modal"
      title="新增 IM Identity"
      visible={props.visible}
      onCancel={props.onClose}
      onOk={() => void submit()}
      okText="新增"
      confirmLoading={busy}
    >
      <FeedbackBanner error={error} />
      <IdentityFields channels={props.channels} form={form} setForm={setForm} />
    </Modal>
  );
}

function validateIdentity(form: IdentityInput): string {
  if (!form.channel) return "消息通道必填";
  if (!form.externalId) return "External ID 必填";
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(form.externalIdType)) return "External ID 类型格式无效";
  return "";
}

function IdentityFields({
  channels,
  form,
  setForm,
}: {
  channels: string[];
  form: IdentityInput;
  setForm: (form: IdentityInput) => void;
}) {
  const set = (key: keyof IdentityInput, value: string) => setForm({ ...form, [key]: value });
  return (
    <div className={styles.formGrid}>
      <Field label="消息通道">
        <Select
          aria-label="新增 Identity 通道"
          value={form.channel}
          optionList={channels.map((channel) => ({
            value: channel,
            label: channelMeta(channel).label,
          }))}
          onChange={(value) => set("channel", String(value ?? ""))}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="Account ID">
        <Input
          aria-label="新增 Identity Account ID"
          value={form.accountId}
          onChange={(value) => set("accountId", value)}
        />
      </Field>
      <Field label="External ID">
        <Input
          aria-label="新增 Identity External ID"
          value={form.externalId}
          onChange={(value) => set("externalId", value)}
        />
      </Field>
      <Field label="External ID 类型">
        <Input
          aria-label="新增 Identity External ID 类型"
          value={form.externalIdType}
          onChange={(value) => set("externalIdType", value)}
        />
      </Field>
    </div>
  );
}

function DeleteIdentityDialog({
  identity,
  busy,
  onClose,
  onDelete,
}: {
  identity: Identity | null;
  busy: boolean;
  onClose: () => void;
  onDelete: () => void;
}) {
  return (
    <Modal
      className="standard-modal"
      title="删除 Identity"
      visible={identity !== null}
      onCancel={onClose}
      onOk={onDelete}
      okText="确认删除"
      confirmLoading={busy}
      okButtonProps={{ type: "danger" as const }}
    >
      删除后该 IM 身份将无法路由到当前用户。原始 ID：
      <span className="mono">{identity?.externalId}</span>
    </Modal>
  );
}
