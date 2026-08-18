import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, Input, Modal, Select } from "@douyinfe/semi-ui";
import type { LLMModelConfig, LLMModelUpdateInput, ThinkingLevel } from "../../api";
import i18n from "../../i18n";
import styles from "../LLM.module.css";

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const THINKING_LABEL_KEYS: Record<ThinkingLevel, string> = {
  off: "model.thinkingOff",
  minimal: "model.thinkingMinimal",
  low: "model.thinkingLow",
  medium: "model.thinkingMedium",
  high: "model.thinkingHigh",
  xhigh: "model.thinkingXHigh",
  max: "model.thinkingMax",
};

interface Props {
  model: LLMModelConfig | null;
  busy: boolean;
  onClose: () => void;
  onSave: (modelConfigId: string, update: LLMModelUpdateInput) => Promise<boolean>;
  onError: (message: string) => void;
}

export function LLMEditDialog({ model, busy, onClose, onSave, onError }: Props) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [supportsTools, setSupportsTools] = useState(true);
  const [thinking, setThinking] = useState<ThinkingLevel>("off");

  useEffect(() => {
    if (!model) return;
    setApiKey(model.apiKey ?? "");
    setSupportsTools(model.supportsTools);
    setThinking((model.thinking as ThinkingLevel) || "off");
    onError("");
  }, [model, onError]);

  const submit = async () => {
    if (!model) return;
    const update: LLMModelUpdateInput = {
      apiKey: apiKey.trim(),
      supportsTools,
      thinking,
    };
    if (update.apiKey === "") return onError(i18n.t("model.validationApiKeyRequired"));
    if (await onSave(model.modelConfigId, update)) onClose();
  };

  return (
    <Modal
      className="standard-modal"
      title={t("model.editDialogTitle", { name: model?.displayName ?? "" })}
      visible={model !== null}
      onCancel={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button theme="solid" loading={busy} onClick={() => void submit()}>
            {t("common.save")}
          </Button>
        </>
      }
      width={560}
    >
      {model && (
        <div className={styles.formGrid}>
          <Field label={t("model.displayName")}>
            <Input aria-label={t("model.displayName")} value={model.displayName} disabled />
          </Field>
          <Field label="Provider / Model">
            <Input
              aria-label="Provider / Model"
              value={`${model.provider} / ${model.model}`}
              disabled
            />
          </Field>
          <div className={styles.full}>
            <Field label={t("model.apiKey")}>
              <Input
                aria-label={t("model.apiKey")}
                value={apiKey}
                onChange={setApiKey}
                placeholder={t("model.apiKey")}
              />
            </Field>
          </div>
          <Field label={t("model.thinkingLabel")}>
            <Select
              aria-label={t("model.thinkingLabel")}
              value={thinking}
              optionList={THINKING_LEVELS.map((level) => ({
                value: level,
                label: t(THINKING_LABEL_KEYS[level]),
              }))}
              onChange={(value) => setThinking((value ?? "off") as ThinkingLevel)}
              style={{ width: "100%" }}
            />
          </Field>
          <Field as="div" label={t("model.functionCalls")}>
            <Checkbox
              aria-label={t("model.supportFunctionCallsAria")}
              checked={supportsTools}
              onChange={(e) => setSupportsTools((e.target as HTMLInputElement).checked)}
            >
              {t("model.supportFunctionCalls")}
            </Checkbox>
          </Field>
        </div>
      )}
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
