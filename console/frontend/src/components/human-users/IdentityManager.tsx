import { useEffect, useState } from "react";
import { Button, Input, Modal, Select, Space, Table, Toast } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import type { HumanUser, Identity, IdentityInput } from "../../api";
import { channelMeta } from "../../channels";
import { FeedbackBanner, setRepeatableError } from "../ConsolePage";
import { errorMessage } from "../../utils/error";
import i18n from "../../i18n";
import styles from "../HumanUsersPanel.module.css";
import { Field, UserStatusTag } from "./shared";

interface Props {
  user: HumanUser;
  identities: Identity[];
  channels: string[];
  onChanged: () => Promise<void>;
}

export function IdentityManager({ user, identities, channels, onChanged }: Props) {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Identity | null>(null);
  const actions = useIdentityActions(user, pendingDelete, setPendingDelete, onChanged);

  return (
    <div>
      <FeedbackBanner error={actions.error} />
      <div className={styles.toolbar}>
        <span>{t("user.identityScopeHint")}</span>
        <Button theme="solid" onClick={() => setCreateOpen(true)}>
          {t("user.addIdentity")}
        </Button>
      </div>
      <Table
        columns={identityColumns(t, actions.busyId, actions.setStatus, setPendingDelete) as never}
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
      setError(errorMessage(caught, "user.identityOpFailed"));
    } finally {
      setBusyId("");
    }
  };
  const setStatus = async (identity: Identity) => {
    const status = identity.status === "active" ? "disabled" : "active";
    await run(identity.identityId, async () => {
      await api.setIdentityStatus(user.humanUserId, identity.identityId, status);
      Toast.success(
        status === "active" ? i18n.t("user.identityEnabled") : i18n.t("user.identityDisabled"),
      );
    });
  };
  const remove = async () => {
    if (!pendingDelete) return;
    await run(pendingDelete.identityId, async () => {
      await api.deleteIdentity(user.humanUserId, pendingDelete.identityId);
      setPendingDelete(null);
      Toast.success(i18n.t("user.identityDeleted"));
    });
  };
  return { busyId, error, setStatus, remove };
}

function identityColumns(
  t: (key: string) => string,
  busyId: string,
  onStatus: (identity: Identity) => Promise<void>,
  onDelete: (identity: Identity) => void,
) {
  return [
    {
      title: t("user.columnChannelAccount"),
      key: "scope",
      render: (_: unknown, identity: Identity) => (
        <div>
          <div>{channelMeta(identity.channel).label}</div>
          <div className="mono">{identity.accountId}</div>
        </div>
      ),
    },
    {
      title: t("user.externalId"),
      key: "externalId",
      render: (_: unknown, identity: Identity) => (
        <div>
          <div className="mono">{identity.externalId}</div>
          <div>{identity.externalIdType}</div>
        </div>
      ),
    },
    {
      title: t("user.columnOpenclawChannel"),
      dataIndex: "openclawChannel",
      key: "openclawChannel",
    },
    {
      title: t("common.status"),
      key: "status",
      render: (_: unknown, identity: Identity) => <UserStatusTag status={identity.status} />,
    },
    {
      title: t("common.actions"),
      key: "actions",
      render: (_: unknown, identity: Identity) => (
        <Space>
          <Button
            size="small"
            loading={busyId === identity.identityId}
            onClick={() => void onStatus(identity)}
          >
            {identity.status === "active" ? t("status.disable") : t("status.enable")}
          </Button>
          <Button size="small" type="danger" onClick={() => onDelete(identity)}>
            {t("common.delete")}
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
  const { t } = useTranslation();
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
    if (validation) return setRepeatableError(setError, validation);
    setBusy(true);
    setError("");
    try {
      await api.createIdentity(props.user.humanUserId, form);
      Toast.success(t("user.identityAdded"));
      props.onClose();
      await props.onCreated();
    } catch (caught) {
      setError(errorMessage(caught, "user.addIdentityFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      className="standard-modal"
      title={t("user.addIdentityTitle")}
      visible={props.visible}
      onCancel={props.onClose}
      onOk={() => void submit()}
      okText={t("user.add")}
      confirmLoading={busy}
    >
      <FeedbackBanner error={error} />
      <IdentityFields channels={props.channels} form={form} setForm={setForm} />
    </Modal>
  );
}

function validateIdentity(form: IdentityInput): string {
  if (!form.channel) return i18n.t("user.channelRequired");
  if (!form.externalId) return i18n.t("user.externalIdRequired");
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(form.externalIdType))
    return i18n.t("user.externalIdTypeInvalid");
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
  const { t } = useTranslation();
  const set = (key: keyof IdentityInput, value: string) => setForm({ ...form, [key]: value });
  return (
    <div className={styles.formGrid}>
      <Field label={t("user.messageChannel")}>
        <Select
          aria-label={t("user.addIdentityChannel")}
          value={form.channel}
          optionList={channels.map((channel) => ({
            value: channel,
            label: channelMeta(channel).label,
          }))}
          onChange={(value) => set("channel", String(value ?? ""))}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label={t("user.accountId")}>
        <Input
          aria-label={t("user.addIdentityAccountId")}
          value={form.accountId}
          onChange={(value) => set("accountId", value)}
        />
      </Field>
      <Field label={t("user.externalId")}>
        <Input
          aria-label={t("user.addIdentityExternalId")}
          value={form.externalId}
          onChange={(value) => set("externalId", value)}
        />
      </Field>
      <Field label={t("user.externalIdType")}>
        <Input
          aria-label={t("user.addIdentityExternalIdType")}
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
  const { t } = useTranslation();
  return (
    <Modal
      className="standard-modal"
      title={t("user.deleteIdentityTitle")}
      visible={identity !== null}
      onCancel={onClose}
      onOk={onDelete}
      okText={t("common.confirmDelete")}
      confirmLoading={busy}
      okButtonProps={{ type: "danger" as const }}
    >
      {t("user.deleteIdentityConfirm")}
      <span className="mono">{identity?.externalId}</span>
    </Modal>
  );
}
