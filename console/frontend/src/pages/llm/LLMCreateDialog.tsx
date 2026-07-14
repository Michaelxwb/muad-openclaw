import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button, Input, Modal, TextArea } from "@douyinfe/semi-ui";
import type { LLMModelInput } from "../../api";
import styles from "../LLM.module.css";

interface ModelDraft {
  displayName: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKeys: string;
}

interface Props {
  visible: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (models: LLMModelInput[]) => Promise<boolean>;
  onError: (message: string) => void;
}

const initialDraft: ModelDraft = {
  displayName: "",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  apiKeys: "",
};

export function LLMCreateDialog({ visible, busy, onClose, onCreate, onError }: Props) {
  const [draft, setDraft] = useState<ModelDraft>(initialDraft);

  useEffect(() => {
    if (!visible) return;
    setDraft(initialDraft);
    onError("");
  }, [onError, visible]);

  const set = (key: keyof ModelDraft, value: string) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  const submit = async () => {
    const models = modelInputsFromDraft(draft);
    if (typeof models === "string") {
      onError(models);
      return;
    }
    if (await onCreate(models)) onClose();
  };

  return (
    <Modal
      className="standard-modal"
      title="批量创建模型配置"
      visible={visible}
      onCancel={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button theme="solid" loading={busy} onClick={() => void submit()}>
            创建
          </Button>
        </>
      }
      width={720}
    >
      <div className={styles.formGrid}>
        <Field label="显示名称">
          <Input
            aria-label="显示名称"
            value={draft.displayName}
            onChange={(value) => set("displayName", value)}
            placeholder="例如 DeepSeek Key"
          />
        </Field>
        <Field label="Provider">
          <Input
            aria-label="Provider"
            value={draft.provider}
            onChange={(value) => set("provider", value)}
          />
        </Field>
        <Field label="Model">
          <Input aria-label="Model" value={draft.model} onChange={(value) => set("model", value)} />
        </Field>
        <Field label="Base URL">
          <Input
            aria-label="Base URL"
            value={draft.baseUrl}
            onChange={(value) => set("baseUrl", value)}
          />
        </Field>
        <div className={styles.full}>
          <Field label="API Key 列表">
            <TextArea
              aria-label="API Key 列表"
              value={draft.apiKeys}
              onChange={(value) => set("apiKeys", value)}
              rows={6}
              placeholder="每行一个 API key"
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function modelInputsFromDraft(draft: ModelDraft): LLMModelInput[] | string {
  const displayName = draft.displayName.trim();
  const provider = draft.provider.trim();
  const baseUrl = draft.baseUrl.trim();
  const model = draft.model.trim();
  const apiKeys = draft.apiKeys
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (displayName === "") return "显示名称必填";
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(provider)) return "Provider 格式无效";
  if (model === "") return "Model 必填";
  if (baseUrl === "") return "Base URL 必填";
  if (apiKeys.length === 0) return "请至少输入一个 API key";
  if (apiKeys.length > 100) return "单次最多创建 100 个 API key";
  return apiKeys.map((apiKey, index) => ({
    displayName: `${displayName} ${index + 1}`,
    provider,
    baseUrl,
    model,
    apiKey,
  }));
}
