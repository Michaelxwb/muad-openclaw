import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Input, Select, TextArea, Toast } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api";
import type { HumanUser, HumanUserStatus, LLMModelConfig, LLMModelView } from "../../api";
import { FeedbackBanner } from "../ConsolePage";
import i18n from "../../i18n";
import { errorMessage, ErrorDetail } from "../../utils/error";
import styles from "../HumanUsersPanel.module.css";
import { Field, normalizeStatus, userStatusOptions } from "./shared";

interface Props {
  user: HumanUser;
  onSaved: () => Promise<void>;
  formId?: string;
  onBusyChange?: (busy: boolean) => void;
}

export function BasicUserForm({ user, onSaved, formId, onBusyChange }: Props) {
  const form = useBasicUserForm(user, onSaved);
  useEffect(() => {
    onBusyChange?.(form.busy);
    return () => onBusyChange?.(false);
  }, [form.busy, onBusyChange]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void form.save();
  };
  return (
    <form id={formId} onSubmit={submit}>
      <FeedbackBanner error={form.error} />
      <ErrorDetail detail={form.errorDetail} />
      <BasicUserFields
        displayName={form.displayName}
        prompt={form.prompt}
        status={form.status}
        modelConfigId={form.modelConfigId}
        currentBoundId={user.modelConfigId}
        models={form.models}
        modelLoading={form.modelLoading}
        currentModel={user.modelConfig}
        onDisplayName={form.setDisplayName}
        onPrompt={form.setPrompt}
        onStatus={form.setStatus}
        onModelConfigId={form.setModelConfigId}
      />
    </form>
  );
}

function useBasicUserForm(user: HumanUser, onSaved: () => Promise<void>) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [prompt, setPrompt] = useState(user.prompt);
  const [status, setStatus] = useState<Exclude<HumanUserStatus, "deleting">>(
    user.status === "deleting" ? "disabled" : user.status,
  );
  const [modelConfigId, setModelConfigId] = useState(user.modelConfigId);
  const [models, setModels] = useState<LLMModelConfig[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState<string | undefined>();

  useEffect(() => {
    setDisplayName(user.displayName);
    setPrompt(user.prompt);
    if (user.status !== "deleting") setStatus(user.status);
    setModelConfigId(user.modelConfigId);
    setError("");
    setErrorDetail(undefined);
  }, [user]);

  useEffect(() => {
    let active = true;
    setModelLoading(true);
    api
      .listLLMModels(true)
      .then((result) => {
        if (active) setModels(result.items);
      })
      .catch(() => {
        // model pool may be unavailable; keep current model selection usable
      })
      .finally(() => {
        if (active) setModelLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    setError("");
    setErrorDetail(undefined);
    try {
      await api.patchHumanUser(user.humanUserId, { displayName, prompt, status, modelConfigId });
      Toast.success(i18n.t("user.infoSaved"));
      await onSaved();
    } catch (caught) {
      setError(errorMessage(caught, "user.saveUserFailed"));
      setErrorDetail(caught instanceof ApiError ? caught.detail : undefined);
    } finally {
      setBusy(false);
    }
  }, [displayName, modelConfigId, prompt, onSaved, status, user.humanUserId]);

  return {
    displayName,
    prompt,
    status,
    modelConfigId,
    models,
    modelLoading,
    busy,
    error,
    errorDetail,
    setDisplayName,
    setPrompt,
    setStatus,
    setModelConfigId,
    save,
  };
}

interface FieldsProps {
  displayName: string;
  prompt: string;
  status: Exclude<HumanUserStatus, "deleting">;
  modelConfigId: string;
  currentBoundId: string;
  models: LLMModelConfig[];
  modelLoading: boolean;
  currentModel: LLMModelView;
  onDisplayName: (value: string) => void;
  onPrompt: (value: string) => void;
  onStatus: (value: Exclude<HumanUserStatus, "deleting">) => void;
  onModelConfigId: (value: string) => void;
}

function BasicUserFields(props: FieldsProps) {
  const { t } = useTranslation();
  const modelOptions = props.models.map((model) => ({
    value: model.modelConfigId,
    label: `${model.displayName} (${model.provider}/${model.model})`,
  }));
  // Always keep the currently bound model selectable, even while a new unbound
  // model is picked but not yet saved; selecting it again means no change.
  if (
    props.currentBoundId &&
    !props.models.some((model) => model.modelConfigId === props.currentBoundId)
  ) {
    modelOptions.unshift({
      value: props.currentBoundId,
      label: t("user.currentModelLabel", {
        provider: props.currentModel.provider,
        model: props.currentModel.model,
      }),
    });
  }
  const selectedKey =
    props.models.find((model) => model.modelConfigId === props.modelConfigId)?.apiKey ??
    props.currentModel.apiKey;
  return (
    <div className={styles.formGrid}>
      <Field label={t("user.displayName")}>
        <Input
          aria-label={t("user.editDisplayName")}
          value={props.displayName}
          onChange={props.onDisplayName}
        />
      </Field>
      <Field label={t("common.status")}>
        <Select
          aria-label={t("user.statusAria")}
          value={props.status}
          optionList={userStatusOptions(t).slice(1)}
          onChange={(value) => props.onStatus(normalizeStatus(String(value)) || "pending")}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label={t("user.modelConfig")}>
        <Select
          aria-label={t("user.modelConfig")}
          value={props.modelConfigId}
          loading={props.modelLoading}
          placeholder={t("user.selectUnboundModel")}
          optionList={modelOptions}
          onChange={(value) => props.onModelConfigId(String(value ?? ""))}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label={t("user.modelKey")}>
        <div className="mono">{selectedKey || t("user.configured")}</div>
      </Field>
      <div className={styles.full}>
        <Field label={t("user.prompt")}>
          <TextArea
            aria-label={t("user.editPrompt")}
            value={props.prompt}
            onChange={props.onPrompt}
            maxCount={4000}
          />
        </Field>
      </div>
    </div>
  );
}
