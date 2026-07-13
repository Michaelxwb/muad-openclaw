import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, InputNumber, Modal, Select, Table, Tag, Toast } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type {
  ActivationInput,
  BindingCode,
  BindingCodeStatus,
  HumanUser,
  HumanUserActivation,
} from "../../api";
import { channelMeta } from "../../channels";
import { useMountedRef } from "../../hooks/useMountedRef";
import { FeedbackBanner } from "../ConsolePage";
import styles from "../HumanUsersPanel.module.css";
import { ActivationCodeDialog } from "./ActivationCodeDialog";
import { Field } from "./shared";

interface Props {
  user: HumanUser;
  channels: string[];
}

export function BindingCodeManager({ user, channels }: Props) {
  const state = useBindingCodes(user.humanUserId);
  const [createOpen, setCreateOpen] = useState(false);
  const [activation, setActivation] = useState<HumanUserActivation | null>(null);
  const actions = useBindingCodeActions(user.humanUserId, state);

  return (
    <div>
      <FeedbackBanner error={state.error} />
      <div className={styles.toolbar}>
        <span>绑定码用于为当前用户增加新的 IM Identity。</span>
        <Button theme="solid" onClick={() => setCreateOpen(true)}>
          生成绑定码
        </Button>
      </div>
      <Table
        columns={bindingCodeColumns(actions.revokeId, actions.revoke) as never}
        dataSource={state.items}
        rowKey="bindingCodeId"
        loading={state.loading}
        pagination={false}
        size="small"
      />
      <CreateBindingCodeDialog
        user={user}
        channels={channels}
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
      Toast.success("绑定码已吊销");
      await state.refresh();
    } catch (caught) {
      state.setError(caught instanceof Error ? caught.message : "吊销绑定码失败");
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
      setError(caught instanceof Error ? caught.message : "加载绑定码失败");
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [humanUserId, mountedRef]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { items, loading, error, setError, refresh };
}

function bindingCodeColumns(busyId: string, onRevoke: (id: string) => Promise<void>) {
  return [
    {
      title: "通道 / Account",
      key: "scope",
      render: (_: unknown, code: BindingCode) => (
        <div>
          <div>{channelMeta(code.channel).label}</div>
          <div className="mono">{code.accountId}</div>
        </div>
      ),
    },
    { title: "Hint", dataIndex: "codeHint", key: "codeHint", className: "mono" },
    {
      title: "用途",
      key: "purpose",
      render: (_: unknown, code: BindingCode) =>
        code.purpose === "add_identity_to_existing_user" ? "新增 IM" : "首次激活",
    },
    {
      title: "状态",
      key: "status",
      render: (_: unknown, code: BindingCode) => <BindingStatus status={code.status} />,
    },
    {
      title: "过期时间",
      key: "expiresAt",
      render: (_: unknown, code: BindingCode) => new Date(code.expiresAt).toLocaleString(),
    },
    {
      title: "操作",
      key: "actions",
      render: (_: unknown, code: BindingCode) => (
        <Button
          size="small"
          type="danger"
          disabled={code.status !== "pending"}
          loading={busyId === code.bindingCodeId}
          onClick={() => void onRevoke(code.bindingCodeId)}
        >
          吊销
        </Button>
      ),
    },
  ];
}

function BindingStatus({ status }: { status: BindingCodeStatus }) {
  const values: Record<
    BindingCodeStatus,
    { color: "orange" | "green" | "grey" | "red"; label: string }
  > = {
    pending: { color: "orange", label: "待使用" },
    used: { color: "green", label: "已使用" },
    expired: { color: "grey", label: "已过期" },
    revoked: { color: "red", label: "已吊销" },
  };
  return <Tag color={values[status].color}>{values[status].label}</Tag>;
}

interface CreateDialogProps {
  user: HumanUser;
  channels: string[];
  visible: boolean;
  onClose: () => void;
  onCreated: (activation: HumanUserActivation) => Promise<void>;
}

function CreateBindingCodeDialog(props: CreateDialogProps) {
  const [form, setForm] = useState<Required<ActivationInput>>(() => initialForm(props.channels));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!props.visible) return;
    setForm(initialForm(props.channels));
    setError("");
  }, [props.channels, props.visible]);

  const submit = async () => {
    if (!form.channel) return setError("消息通道必填");
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
      setError(caught instanceof Error ? caught.message : "生成绑定码失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      className="standard-modal"
      title="生成新增 IM 绑定码"
      visible={props.visible}
      onCancel={props.onClose}
      onOk={() => void submit()}
      okText="生成"
      confirmLoading={busy}
    >
      <FeedbackBanner error={error} />
      <BindingCodeFields channels={props.channels} form={form} setForm={setForm} />
    </Modal>
  );
}

function initialForm(channels: string[]): Required<ActivationInput> {
  return { channel: channels[0] ?? "", accountId: "default", expiresInMinutes: 30 };
}

function BindingCodeFields({
  channels,
  form,
  setForm,
}: {
  channels: string[];
  form: Required<ActivationInput>;
  setForm: (form: Required<ActivationInput>) => void;
}) {
  return (
    <div className={styles.formGrid}>
      <Field label="消息通道">
        <Select
          aria-label="绑定码通道"
          value={form.channel}
          optionList={channels.map((channel) => ({
            value: channel,
            label: channelMeta(channel).label,
          }))}
          onChange={(value) => setForm({ ...form, channel: String(value ?? "") })}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="Account ID">
        <Input
          aria-label="绑定码 Account ID"
          value={form.accountId}
          onChange={(accountId) => setForm({ ...form, accountId })}
        />
      </Field>
      <Field label="有效期（分钟）">
        <InputNumber
          aria-label="新增 IM 绑定码有效期"
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
