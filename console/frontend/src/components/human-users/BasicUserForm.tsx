import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Input, Select, TextArea, Toast } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type { HumanUser, HumanUserStatus, LLMModelConfig, LLMModelView } from "../../api";
import { FeedbackBanner } from "../ConsolePage";
import styles from "../HumanUsersPanel.module.css";
import { Field, normalizeStatus, USER_STATUS_OPTIONS } from "./shared";

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
      <BasicUserFields
        displayName={form.displayName}
        notes={form.notes}
        status={form.status}
        modelConfigId={form.modelConfigId}
        currentBoundId={user.modelConfigId}
        models={form.models}
        modelLoading={form.modelLoading}
        currentModel={user.modelConfig}
        onDisplayName={form.setDisplayName}
        onNotes={form.setNotes}
        onStatus={form.setStatus}
        onModelConfigId={form.setModelConfigId}
      />
    </form>
  );
}

function useBasicUserForm(user: HumanUser, onSaved: () => Promise<void>) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [notes, setNotes] = useState(user.notes);
  const [status, setStatus] = useState<Exclude<HumanUserStatus, "deleting">>(
    user.status === "deleting" ? "disabled" : user.status,
  );
  const [modelConfigId, setModelConfigId] = useState(user.modelConfigId);
  const [models, setModels] = useState<LLMModelConfig[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDisplayName(user.displayName);
    setNotes(user.notes);
    if (user.status !== "deleting") setStatus(user.status);
    setModelConfigId(user.modelConfigId);
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
    try {
      await api.patchHumanUser(user.humanUserId, { displayName, notes, status, modelConfigId });
      Toast.success("用户信息已保存");
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存用户失败");
    } finally {
      setBusy(false);
    }
  }, [displayName, modelConfigId, notes, onSaved, status, user.humanUserId]);

  return {
    displayName,
    notes,
    status,
    modelConfigId,
    models,
    modelLoading,
    busy,
    error,
    setDisplayName,
    setNotes,
    setStatus,
    setModelConfigId,
    save,
  };
}

interface FieldsProps {
  displayName: string;
  notes: string;
  status: Exclude<HumanUserStatus, "deleting">;
  modelConfigId: string;
  currentBoundId: string;
  models: LLMModelConfig[];
  modelLoading: boolean;
  currentModel: LLMModelView;
  onDisplayName: (value: string) => void;
  onNotes: (value: string) => void;
  onStatus: (value: Exclude<HumanUserStatus, "deleting">) => void;
  onModelConfigId: (value: string) => void;
}

function BasicUserFields(props: FieldsProps) {
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
      label: `${props.currentModel.provider}/${props.currentModel.model}（当前）`,
    });
  }
  const selectedKey =
    props.models.find((model) => model.modelConfigId === props.modelConfigId)?.apiKey ??
    props.currentModel.apiKey;
  return (
    <div className={styles.formGrid}>
      <Field label="显示名称">
        <Input aria-label="编辑显示名称" value={props.displayName} onChange={props.onDisplayName} />
      </Field>
      <Field label="状态">
        <Select
          aria-label="用户状态"
          value={props.status}
          optionList={USER_STATUS_OPTIONS.slice(1)}
          onChange={(value) => props.onStatus(normalizeStatus(String(value)) || "pending")}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="模型配置">
        <Select
          aria-label="模型配置"
          value={props.modelConfigId}
          loading={props.modelLoading}
          placeholder="选择未绑定模型"
          optionList={modelOptions}
          onChange={(value) => props.onModelConfigId(String(value ?? ""))}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="模型 Key">
        <div className="mono">{selectedKey || "已配置"}</div>
      </Field>
      <div className={styles.full}>
        <Field label="备注">
          <TextArea
            aria-label="编辑备注"
            value={props.notes}
            onChange={props.onNotes}
            maxCount={4000}
          />
        </Field>
      </div>
    </div>
  );
}
