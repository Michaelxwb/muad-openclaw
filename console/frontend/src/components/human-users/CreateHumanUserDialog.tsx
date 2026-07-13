import { useEffect, useRef, useState } from "react";
import { Button, Input, InputNumber, Modal, RadioGroup, Select, TextArea } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type {
  CreateHumanUserInput,
  HumanUserBootstrapResult,
  LLMModelConfig,
  Pod,
} from "../../api";
import { channelMeta } from "../../channels";
import { FeedbackBanner } from "../ConsolePage";
import styles from "../HumanUsersPanel.module.css";
import { Field } from "./shared";

type CreateMode = "identity" | "activation";

interface CreateUserForm {
  mode: CreateMode;
  displayName: string;
  modelConfigId: string;
  agentId: string;
  notes: string;
  channel: string;
  accountId: string;
  externalId: string;
  externalIdType: string;
  expiresInMinutes: number;
}

interface Props {
  pod: Pod;
  visible: boolean;
  onClose: () => void;
  onCreated: (result: HumanUserBootstrapResult) => Promise<void>;
}

function initialForm(pod: Pod): CreateUserForm {
  return {
    mode: "identity",
    displayName: "",
    modelConfigId: "",
    agentId: "",
    notes: "",
    channel: pod.channels[0] ?? "",
    accountId: "default",
    externalId: "",
    externalIdType: "user_id",
    expiresInMinutes: 30,
  };
}

function validate(form: CreateUserForm): string {
  if (form.displayName.trim() === "") return "显示名称必填";
  if (form.modelConfigId.trim() === "") return "模型配置必选";
  if (form.channel === "") return "消息通道必填";
  if (form.mode === "identity" && form.externalId === "") return "external ID 必填";
  if (form.mode === "identity" && !/^[a-z][a-z0-9_]{0,63}$/.test(form.externalIdType))
    return "external ID 类型格式无效";
  if (form.expiresInMinutes < 1 || form.expiresInMinutes > 1440)
    return "绑定码有效期必须在 1 到 1440 分钟之间";
  return "";
}

function createInput(form: CreateUserForm): CreateHumanUserInput {
  const common = {
    displayName: form.displayName.trim(),
    modelConfigId: form.modelConfigId.trim(),
    agentId: form.agentId.trim() || undefined,
    notes: form.notes,
  };
  if (form.mode === "identity") {
    return {
      ...common,
      identity: {
        channel: form.channel,
        accountId: form.accountId.trim() || "default",
        externalId: form.externalId,
        externalIdType: form.externalIdType.trim(),
        peerKind: "direct",
      },
    };
  }
  return {
    ...common,
    activation: {
      channel: form.channel,
      accountId: form.accountId.trim() || "default",
      expiresInMinutes: form.expiresInMinutes,
    },
  };
}

export function CreateHumanUserDialog({ pod, visible, onClose, onCreated }: Props) {
  const [form, setForm] = useState<CreateUserForm>(() => initialForm(pod));
  const [models, setModels] = useState<LLMModelConfig[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const previousVisibleRef = useRef(visible);

  useEffect(() => {
    const opened = visible && !previousVisibleRef.current;
    previousVisibleRef.current = visible;
    if (!opened) return;
    setForm(initialForm(pod));
    setError("");
    void loadAvailableModels();
  }, [pod, visible]);

  const loadAvailableModels = async () => {
    try {
      const result = await api.listLLMModels(true);
      setModels(result.items);
      setForm((previous) => ({
        ...previous,
        modelConfigId: previous.modelConfigId || result.items[0]?.modelConfigId || "",
      }));
    } catch (caught) {
      setModels([]);
      setError(caught instanceof Error ? caught.message : "加载可用模型失败");
    }
  };

  const submit = async () => {
    const validation = validate(form);
    if (validation) return setError(validation);
    setBusy(true);
    setError("");
    try {
      await onCreated(await api.createHumanUser(pod.podId, createInput(form)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建 Human User 失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      className="standard-modal"
      title="创建 Human User"
      visible={visible}
      onCancel={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button theme="solid" loading={busy} onClick={() => void submit()}>
            创建
          </Button>
        </>
      }
      width={640}
    >
      <FeedbackBanner error={error} />
      <CreateForm pod={pod} models={models} form={form} setForm={setForm} />
    </Modal>
  );
}

interface FormProps {
  pod: Pod;
  models: LLMModelConfig[];
  form: CreateUserForm;
  setForm: (update: (previous: CreateUserForm) => CreateUserForm) => void;
}

function CreateForm({ pod, models, form, setForm }: FormProps) {
  const set = (key: keyof CreateUserForm, value: string | number) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  return (
    <>
      <RadioGroup
        aria-label="用户激活方式"
        type="button"
        value={form.mode}
        options={[
          { value: "identity", label: "已知 external ID" },
          { value: "activation", label: "绑定码激活" },
        ]}
        onChange={(event) =>
          set("mode", event.target.value === "activation" ? "activation" : "identity")
        }
      />
      <div className={styles.formGrid}>
        <CommonFields pod={pod} models={models} form={form} set={set} />
        {form.mode === "identity" ? (
          <IdentityFields form={form} set={set} />
        ) : (
          <ActivationFields form={form} set={set} />
        )}
        <div className={styles.full}>
          <Field label="备注">
            <TextArea
              aria-label="备注"
              value={form.notes}
              onChange={(value) => set("notes", value)}
              maxCount={4000}
            />
          </Field>
        </div>
      </div>
    </>
  );
}

type SetField = (key: keyof CreateUserForm, value: string | number) => void;

function CommonFields({
  pod,
  models,
  form,
  set,
}: {
  pod: Pod;
  models: LLMModelConfig[];
  form: CreateUserForm;
  set: SetField;
}) {
  return (
    <>
      <Field label="显示名称">
        <Input
          aria-label="显示名称"
          value={form.displayName}
          onChange={(value) => set("displayName", value)}
        />
      </Field>
      <Field label="Agent ID">
        <Input
          aria-label="Agent ID"
          value={form.agentId}
          onChange={(value) => set("agentId", value)}
          placeholder="留空自动生成"
        />
      </Field>
      <Field label="模型配置">
        <Select
          aria-label="模型配置"
          value={form.modelConfigId}
          placeholder={models.length === 0 ? "暂无可用模型" : "选择未绑定模型"}
          optionList={models.map((model) => ({
            value: model.modelConfigId,
            label: `${model.displayName} (${model.provider}/${model.model})`,
          }))}
          onChange={(value) => set("modelConfigId", String(value ?? ""))}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="消息通道">
        <Select
          aria-label="消息通道"
          value={form.channel}
          optionList={pod.channels.map((channel) => ({
            value: channel,
            label: channelMeta(channel).label,
          }))}
          onChange={(value) => set("channel", String(value ?? ""))}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="Account ID">
        <Input
          aria-label="Account ID"
          value={form.accountId}
          onChange={(value) => set("accountId", value)}
        />
      </Field>
    </>
  );
}

function IdentityFields({ form, set }: { form: CreateUserForm; set: SetField }) {
  return (
    <>
      <Field label="External ID">
        <Input
          aria-label="External ID"
          value={form.externalId}
          onChange={(value) => set("externalId", value)}
        />
      </Field>
      <Field label="External ID 类型">
        <Input
          aria-label="External ID 类型"
          value={form.externalIdType}
          onChange={(value) => set("externalIdType", value)}
        />
      </Field>
    </>
  );
}

function ActivationFields({ form, set }: { form: CreateUserForm; set: SetField }) {
  return (
    <Field label="绑定码有效期（分钟）">
      <InputNumber
        aria-label="绑定码有效期"
        min={1}
        max={1440}
        value={form.expiresInMinutes}
        onNumberChange={(value) => set("expiresInMinutes", value)}
        style={{ width: "100%" }}
      />
    </Field>
  );
}
