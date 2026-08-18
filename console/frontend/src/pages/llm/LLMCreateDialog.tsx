import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, Input, Modal, Select, TextArea } from "@douyinfe/semi-ui";
import type { LLMModelInput, ThinkingLevel } from "../../api";
import i18n from "../../i18n";
import styles from "../LLM.module.css";

interface ModelDraft {
  displayName: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKeys: string;
  supportsTools: boolean;
  thinking: ThinkingLevel;
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
  supportsTools: true,
  thinking: "off",
};

const PROVIDER_OPTIONS = [
  { label: "deepseek", value: "deepseek" },
  { label: "openai", value: "openai" },
];

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function LLMCreateDialog({ visible, busy, onClose, onCreate, onError }: Props) {
  const { t } = useTranslation();
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
      title={t("model.createDialogTitle")}
      visible={visible}
      onCancel={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button theme="solid" loading={busy} onClick={() => void submit()}>
            {t("common.create")}
          </Button>
        </>
      }
      width={720}
    >
      <div className={styles.formGrid}>
        <Field label={t("model.displayNameLabel")}>
          <Input
            aria-label={t("model.displayNameLabel")}
            value={draft.displayName}
            onChange={(value) => set("displayName", value)}
            placeholder={t("model.createDialogDisplayNamePlaceholder")}
          />
        </Field>
        <Field label="Provider">
          <Select
            aria-label="Provider"
            value={draft.provider}
            optionList={PROVIDER_OPTIONS}
            onChange={(value) => set("provider", String(value ?? "deepseek"))}
            style={{ width: "100%" }}
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
        <Field label={t("model.thinkingLabel")}>
          <Select
            aria-label={t("model.thinkingLabel")}
            value={draft.thinking}
            optionList={thinkingOptions(t)}
            onChange={(value) => set("thinking", String(value ?? "off") as ThinkingLevel)}
            style={{ width: "100%" }}
          />
        </Field>
        <Field as="div" label={t("model.functionCalls")}>
          <Checkbox
            aria-label={t("model.supportFunctionCallsAria")}
            checked={draft.supportsTools}
            onChange={(e) =>
              setDraft((previous) => ({
                ...previous,
                supportsTools: (e.target as HTMLInputElement).checked,
              }))
            }
          >
            {t("model.supportFunctionCalls")}
          </Checkbox>
        </Field>
        <div className={styles.full}>
          <Field label={t("model.apiKeyList")}>
            <TextArea
              aria-label={t("model.apiKeyList")}
              value={draft.apiKeys}
              onChange={(value) => set("apiKeys", value)}
              rows={6}
              placeholder={t("model.apiKeyPlaceholder")}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function Field({
  label,
  children,
  as = "label",
}: {
  label: string;
  children: ReactNode;
  // 不能用 <label> 包裹 Semi Checkbox：label 激活会对控制元素再派发一次合成 click，
  // 导致 onChange 触发两次、勾选被立刻抵消（Chrome 实测）。checkbox 字段用 "div"。
  as?: "label" | "div";
}) {
  const Wrapper = as;
  return (
    <Wrapper className={styles.field}>
      <span>{label}</span>
      {children}
    </Wrapper>
  );
}

const THINKING_LABEL_KEYS: Record<ThinkingLevel, string> = {
  off: "model.thinkingOff",
  minimal: "model.thinkingMinimal",
  low: "model.thinkingLow",
  medium: "model.thinkingMedium",
  high: "model.thinkingHigh",
  xhigh: "model.thinkingXHigh",
  max: "model.thinkingMax",
};

function thinkingOptions(t: (key: string) => string) {
  return THINKING_LEVELS.map((level) => ({
    value: level,
    label: t(THINKING_LABEL_KEYS[level]),
  }));
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
  if (displayName === "") return i18n.t("model.validationDisplayNameRequired");
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(provider)) return i18n.t("model.validationProviderInvalid");
  if (model === "") return i18n.t("model.validationModelRequired");
  if (baseUrl === "") return i18n.t("model.validationBaseUrlRequired");
  if (apiKeys.length === 0) return i18n.t("model.validationApiKeyRequired");
  if (apiKeys.length > 100) return i18n.t("model.validationApiKeyLimit");
  const thinking = THINKING_LEVELS.includes(draft.thinking) ? draft.thinking : "off";
  return apiKeys.map((apiKey, index) => ({
    displayName: `${displayName} ${index + 1}`,
    provider,
    baseUrl,
    model,
    apiKey,
    supportsTools: draft.supportsTools,
    thinking,
  }));
}
