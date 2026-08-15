import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, InputNumber, Modal, Select, Table, Tag, Toast } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import type {
  ActivationInput,
  BindingCode,
  BindingCodeStatus,
  HumanUser,
  HumanUserActivation,
  Identity,
} from "../../api";
import { channelMeta } from "../../channels";
import { useMountedRef } from "../../hooks/useMountedRef";
import { FeedbackBanner, setRepeatableError } from "../ConsolePage";
import i18n from "../../i18n";
import { errorMessage } from "../../utils/error";
import styles from "../HumanUsersPanel.module.css";
import { ActivationCodeDialog } from "./ActivationCodeDialog";
import { Field } from "./shared";

interface Props {
  user: HumanUser;
  channels: string[];
  identities: Identity[];
  channelDefaultAccountIds?: Record<string, string>;
}

export function BindingCodeManager({
  user,
  channels,
  identities,
  channelDefaultAccountIds = {},
}: Props) {
  const { t } = useTranslation();
  const state = useBindingCodes(user.humanUserId);
  const [createOpen, setCreateOpen] = useState(false);
  const [activation, setActivation] = useState<HumanUserActivation | null>(null);
  const actions = useBindingCodeActions(user.humanUserId, state);

  return (
    <div>
      <FeedbackBanner error={state.error} />
      <div className={styles.toolbar}>
        <span>{t("user.bindingCodeHint")}</span>
        <Button theme="solid" onClick={() => setCreateOpen(true)}>
          {t("user.generateBindingCode")}
        </Button>
      </div>
      <Table
        columns={bindingCodeColumns(t, actions.revokeId, actions.revoke) as never}
        dataSource={state.items}
        rowKey="bindingCodeId"
        loading={state.loading}
        pagination={false}
        size="small"
      />
      <CreateBindingCodeDialog
        user={user}
        channels={channels}
        identities={identities}
        channelDefaultAccountIds={channelDefaultAccountIds}
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async (created) => {
          setCreateOpen(false);
          setActivation(created);
          await state.refresh();
        }}
      />
      <ActivationCodeDialog activation={activation} onClose={() => setActivation(null)} />
    </div>
  );
}

type BindingCodeState = ReturnType<typeof useBindingCodes>;

function useBindingCodeActions(humanUserId: string, state: BindingCodeState) {
  const [revokeId, setRevokeId] = useState("");
  const revoke = async (bindingCodeId: string) => {
    setRevokeId(bindingCodeId);
    state.setError("");
    try {
      await api.revokeBindingCode(humanUserId, bindingCodeId);
      Toast.success(i18n.t("user.revokeBindingCodeSuccess"));
      await state.refresh();
    } catch (caught) {
      state.setError(errorMessage(caught, "user.revokeBindingCodeFailed"));
    } finally {
      setRevokeId("");
    }
  };
  return { revokeId, revoke };
}

function useBindingCodes(humanUserId: string) {
  const [items, setItems] = useState<BindingCode[]>([]);
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
      const result = await api.listBindingCodes(humanUserId);
      if (mountedRef.current && requestId === requestRef.current) setItems(result.items);
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(errorMessage(caught, "user.loadBindingCodesFailed"));
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [humanUserId, mountedRef]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { items, loading, error, setError, refresh };
}

function bindingCodeColumns(
  t: (key: string) => string,
  busyId: string,
  onRevoke: (id: string) => Promise<void>,
) {
  return [
    {
      title: t("user.columnChannelAccount"),
      key: "scope",
      render: (_: unknown, code: BindingCode) => (
        <div>
          <div>{channelMeta(code.channel).label}</div>
          <div className="mono">{code.accountId}</div>
        </div>
      ),
    },
    { title: t("user.codeHint"), dataIndex: "codeHint", key: "codeHint", className: "mono" },
    {
      title: t("user.columnPurpose"),
      key: "purpose",
      render: (_: unknown, code: BindingCode) =>
        code.purpose === "add_identity_to_existing_user"
          ? t("user.purposeAddIdentity")
          : t("user.purposeFirstActivation"),
    },
    {
      title: t("common.status"),
      key: "status",
      render: (_: unknown, code: BindingCode) => <BindingStatus status={code.status} />,
    },
    {
      title: t("user.columnExpiresAt"),
      key: "expiresAt",
      render: (_: unknown, code: BindingCode) => new Date(code.expiresAt).toLocaleString(),
    },
    {
      title: t("common.actions"),
      key: "actions",
      render: (_: unknown, code: BindingCode) => (
        <Button
          size="small"
          type="danger"
          disabled={code.status !== "pending"}
          loading={busyId === code.bindingCodeId}
          onClick={() => void onRevoke(code.bindingCodeId)}
        >
          {t("user.revoke")}
        </Button>
      ),
    },
  ];
}

function BindingStatus({ status }: { status: BindingCodeStatus }) {
  const { t } = useTranslation();
  const values: Record<
    BindingCodeStatus,
    { color: "orange" | "green" | "grey" | "red"; label: string }
  > = {
    pending: { color: "orange", label: t("user.bindingPending") },
    used: { color: "green", label: t("status.used") },
    expired: { color: "grey", label: t("status.expired") },
    revoked: { color: "red", label: t("status.revoked") },
  };
  return <Tag color={values[status].color}>{values[status].label}</Tag>;
}

interface CreateDialogProps {
  user: HumanUser;
  channels: string[];
  identities: Identity[];
  channelDefaultAccountIds: Record<string, string>;
  visible: boolean;
  onClose: () => void;
  onCreated: (activation: HumanUserActivation) => Promise<void>;
}

function CreateBindingCodeDialog(props: CreateDialogProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<Required<ActivationInput>>(() =>
    initialForm(props.channels, props.identities, props.channelDefaultAccountIds),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!props.visible) return;
    setForm(initialForm(props.channels, props.identities, props.channelDefaultAccountIds));
    setError("");
  }, [props.channelDefaultAccountIds, props.channels, props.identities, props.visible]);

  const submit = async () => {
    if (!form.channel) return setRepeatableError(setError, t("user.channelRequired"));
    setBusy(true);
    setError("");
    try {
      const result = await api.createBindingCode(props.user.humanUserId, form);
      await props.onCreated({
        bindingCodeId: result.bindingCode.bindingCodeId,
        code: result.code,
        expiresAt: result.bindingCode.expiresAt,
      });
    } catch (caught) {
      setError(errorMessage(caught, "user.generateBindingCodeFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      className="standard-modal"
      title={t("user.generateBindingCodeTitle")}
      visible={props.visible}
      onCancel={props.onClose}
      onOk={() => void submit()}
      okText={t("user.generate")}
      confirmLoading={busy}
    >
      <FeedbackBanner error={error} />
      <BindingCodeFields
        channels={props.channels}
        channelDefaultAccountIds={props.channelDefaultAccountIds}
        form={form}
        setForm={setForm}
      />
    </Modal>
  );
}

export function defaultBindingChannel(
  channels: string[],
  identities: Pick<Identity, "channel" | "status">[],
) {
  const activeChannels = new Set(
    identities
      .filter((identity) => identity.status === "active")
      .map((identity) => identity.channel),
  );
  return channels.find((channel) => !activeChannels.has(channel)) ?? channels[0] ?? "";
}

function initialForm(
  channels: string[],
  identities: Pick<Identity, "channel" | "status">[],
  channelDefaultAccountIds: Record<string, string>,
): Required<ActivationInput> {
  const channel = defaultBindingChannel(channels, identities);
  return {
    channel,
    accountId: defaultBindingAccountId(channel, channelDefaultAccountIds),
    expiresInMinutes: 30,
  };
}

function defaultBindingAccountId(
  channel: string,
  channelDefaultAccountIds: Record<string, string>,
) {
  return channelDefaultAccountIds[channel] || "default";
}

function BindingCodeFields({
  channels,
  channelDefaultAccountIds,
  form,
  setForm,
}: {
  channels: string[];
  channelDefaultAccountIds: Record<string, string>;
  form: Required<ActivationInput>;
  setForm: (form: Required<ActivationInput>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.formGrid}>
      <Field label={t("user.messageChannel")}>
        <Select
          aria-label={t("user.bindingCodeChannel")}
          value={form.channel}
          optionList={channels.map((channel) => ({
            value: channel,
            label: channelMeta(channel).label,
          }))}
          onChange={(value) => {
            const channel = String(value ?? "");
            setForm({
              ...form,
              channel,
              accountId: defaultBindingAccountId(channel, channelDefaultAccountIds),
            });
          }}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label={t("user.accountId")}>
        <Input
          aria-label={t("user.bindingCodeAccountId")}
          value={form.accountId}
          onChange={(accountId) => setForm({ ...form, accountId })}
        />
      </Field>
      <Field label={t("user.validityMinutes")}>
        <InputNumber
          aria-label={t("user.bindingCodeValidity")}
          min={1}
          max={1440}
          value={form.expiresInMinutes}
          onNumberChange={(expiresInMinutes) => setForm({ ...form, expiresInMinutes })}
          style={{ width: "100%" }}
        />
      </Field>
    </div>
  );
}
