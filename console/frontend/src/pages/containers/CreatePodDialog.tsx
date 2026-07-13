import { useEffect, useState } from "react";
import { Input, InputNumber, Modal, Select } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type { ChannelCredential, Pod } from "../../api";
import { ChannelForm } from "../../components/ChannelForm";
import { FeedbackBanner } from "../../components/ConsolePage";
import styles from "../Containers.module.css";
import {
  createPodInput,
  EMPTY_CREATE_FORM,
  type CreateFormState,
  validateCreateForm,
} from "./createPodModel";

interface Props {
  visible: boolean;
  onClose: () => void;
  onCreated: (pod: Pod) => Promise<void>;
}

export function CreatePodDialog(props: Props) {
  const [form, setForm] = useState<CreateFormState>(EMPTY_CREATE_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!props.visible) return;
    setForm(EMPTY_CREATE_FORM);
    setError("");
  }, [props.visible]);
  const submit = async (channels: string[], channelConfigs: Record<string, ChannelCredential>) => {
    const validation = validateCreateForm(form);
    if (validation) return setError(validation);
    setBusy(true);
    setError("");
    try {
      await props.onCreated(await api.createPod(createPodInput(form, channels, channelConfigs)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建 Pod 失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      className="standard-modal"
      title="创建 Pod"
      visible={props.visible}
      onCancel={props.onClose}
      footer={null}
      width={640}
    >
      <FeedbackBanner error={error} />
      <CreatePodFields form={form} setForm={setForm} />
      <ChannelForm
        mode="create"
        busy={busy}
        error=""
        onSubmit={(channelForm) => submit(channelForm.channels, channelForm.channelConfigs)}
        onCancel={props.onClose}
      />
    </Modal>
  );
}

function CreatePodFields({
  form,
  setForm,
}: {
  form: CreateFormState;
  setForm: (form: CreateFormState) => void;
}) {
  const set = (key: keyof CreateFormState, value: string | number) =>
    setForm({ ...form, [key]: value });
  return (
    <div className={styles.createGrid}>
      <TextField
        label="Pod ID"
        value={form.podId}
        onChange={(value) => set("podId", value)}
        placeholder="muad-pod-01"
      />
      <TextField
        label="显示名称"
        value={form.displayName}
        onChange={(value) => set("displayName", value)}
      />
      <div className={styles.full}>
        <TextField
          label="镜像"
          value={form.imageTag}
          onChange={(value) => set("imageTag", value)}
          placeholder="留空使用系统默认镜像"
        />
      </div>
      <NumberField
        label="用户上限"
        value={form.maxUsers}
        min={1}
        max={10}
        onChange={(value) => set("maxUsers", value)}
      />
      <RestartField value={form.restartPolicy} onChange={(value) => set("restartPolicy", value)} />
      <TextField
        label="内存上限"
        value={form.memLimit}
        onChange={(value) => set("memLimit", value)}
        placeholder="留空继承，如 2g"
      />
      <TextField
        label="CPU 上限"
        value={form.cpuLimit}
        onChange={(value) => set("cpuLimit", value)}
        placeholder="留空继承，如 2"
      />
      <NumberField
        label="Skill 并发"
        value={form.maxSkillConcurrency}
        min={0}
        max={1000}
        onChange={(value) => set("maxSkillConcurrency", value)}
      />
      <NumberField
        label="Browser 并发"
        value={form.maxBrowserConcurrency}
        min={0}
        max={1000}
        onChange={(value) => set("maxBrowserConcurrency", value)}
      />
    </div>
  );
}

function TextField(props: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.field}>
      <span>{props.label}</span>
      <Input
        aria-label={props.label}
        value={props.value}
        onChange={props.onChange}
        placeholder={props.placeholder}
      />
    </label>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className={styles.field}>
      <span>{props.label}</span>
      <InputNumber
        aria-label={props.label}
        min={props.min}
        max={props.max}
        value={props.value}
        onNumberChange={props.onChange}
        style={{ width: "100%" }}
      />
    </label>
  );
}

function RestartField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className={styles.field}>
      <span>重启策略</span>
      <Select
        aria-label="重启策略"
        value={value}
        optionList={[
          { value: "", label: "继承系统默认" },
          { value: "unless-stopped", label: "unless-stopped" },
          { value: "always", label: "always" },
          { value: "on-failure", label: "on-failure" },
          { value: "no", label: "no" },
        ]}
        onChange={(next) => onChange(String(next ?? ""))}
        style={{ width: "100%" }}
      />
    </label>
  );
}
