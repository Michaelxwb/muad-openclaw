import { useEffect, useState } from "react";
import { Button, Input, Space, Toast } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type { HumanUser, ModelOverrideInput } from "../../api";
import { FeedbackBanner } from "../ConsolePage";
import styles from "../HumanUsersPanel.module.css";
import { Field } from "./shared";

interface Props {
  user: HumanUser;
  onSaved: () => Promise<void>;
}

export function UserModelForm({ user, onSaved }: Props) {
  const form = useModelForm(user, onSaved);
  const model = user.modelOverride;
  return (
    <div>
      <FeedbackBanner error={form.error} />
      <p>
        密钥不回显。当前：{model.keyConfigured ? model.keyFingerprint || "已配置" : "继承 Pod/全局"}
      </p>
      <ModelFields
        provider={form.provider}
        baseUrl={form.baseUrl}
        modelName={form.modelName}
        apiKey={form.apiKey}
        keyConfigured={model.keyConfigured}
        onProvider={form.setProvider}
        onBaseUrl={form.setBaseUrl}
        onModelName={form.setModelName}
        onApiKey={form.setApiKey}
      />
      <Space>
        <Button theme="solid" loading={form.busy} onClick={() => void form.submit(false)}>
          保存模型覆写
        </Button>
        <Button disabled={form.busy || !model.keyConfigured} onClick={() => void form.submit(true)}>
          清除覆写
        </Button>
      </Space>
    </div>
  );
}

function useModelForm(user: HumanUser, onSaved: () => Promise<void>) {
  const model = user.modelOverride;
  const [provider, setProvider] = useState(model.provider ?? "");
  const [baseUrl, setBaseUrl] = useState(model.baseUrl ?? "");
  const [modelName, setModelName] = useState(model.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setProvider(model.provider ?? "");
    setBaseUrl(model.baseUrl ?? "");
    setModelName(model.model ?? "");
    setApiKey("");
  }, [model]);

  const submit = async (clear = false) => {
    const input: ModelOverrideInput = clear
      ? { clear: true }
      : { provider, baseUrl, model: modelName };
    if (!clear && apiKey.trim()) input.apiKey = apiKey.trim();
    setBusy(true);
    setError("");
    try {
      await api.setHumanUserModel(user.humanUserId, input);
      Toast.success(clear ? "模型覆写已清除" : "模型覆写已保存");
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存模型覆写失败");
    } finally {
      setBusy(false);
    }
  };

  return {
    provider,
    baseUrl,
    modelName,
    apiKey,
    busy,
    error,
    setProvider,
    setBaseUrl,
    setModelName,
    setApiKey,
    submit,
  };
}

interface FieldsProps {
  provider: string;
  baseUrl: string;
  modelName: string;
  apiKey: string;
  keyConfigured: boolean;
  onProvider: (value: string) => void;
  onBaseUrl: (value: string) => void;
  onModelName: (value: string) => void;
  onApiKey: (value: string) => void;
}

function ModelFields(props: FieldsProps) {
  return (
    <div className={styles.formGrid}>
      <Field label="Provider">
        <Input aria-label="模型 Provider" value={props.provider} onChange={props.onProvider} />
      </Field>
      <Field label="Model">
        <Input aria-label="模型名称" value={props.modelName} onChange={props.onModelName} />
      </Field>
      <div className={styles.full}>
        <Field label="Base URL">
          <Input aria-label="模型 Base URL" value={props.baseUrl} onChange={props.onBaseUrl} />
        </Field>
      </div>
      <div className={styles.full}>
        <Field label="API Key">
          <Input
            aria-label="模型 API Key"
            type="password"
            value={props.apiKey}
            onChange={props.onApiKey}
            placeholder={props.keyConfigured ? "留空保留现有密钥" : "输入 API Key"}
          />
        </Field>
      </div>
    </div>
  );
}
