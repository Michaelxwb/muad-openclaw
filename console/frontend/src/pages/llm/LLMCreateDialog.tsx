import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, Input, Modal, TextArea } from "@douyinfe/semi-ui";
import type { LLMModelInput } from "../../api";
import i18n from "../../i18n";
import styles from "../LLM.module.css";

interface ModelDraft {
  displayName: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKeys: string;
  supportsTools: boolean;
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
};

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
        <Field label={t("model.functionCalls")}>
          <Checkbox
            aria-label={t("model.supportFunctionCallsAria")}
            checked={draft.supportsTools}
            onChange={(checked) =>
              setDraft((previous) => ({ ...previous, supportsTools: Boolean(checked) }))
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
  if (displayName === "") return i18n.t("model.validationDisplayNameRequired");
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(provider)) return i18n.t("model.validationProviderInvalid");
  if (model === "") return i18n.t("model.validationModelRequired");
  if (baseUrl === "") return i18n.t("model.validationBaseUrlRequired");
  if (apiKeys.length === 0) return i18n.t("model.validationApiKeyRequired");
  if (apiKeys.length > 100) return i18n.t("model.validationApiKeyLimit");
  return apiKeys.map((apiKey, index) => ({
    displayName: `${displayName} ${index + 1}`,
    provider,
    baseUrl,
    model,
    apiKey,
    supportsTools: draft.supportsTools,
  }));
}
