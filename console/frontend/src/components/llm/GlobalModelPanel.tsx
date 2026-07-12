import { Button, Input, Space, Tag } from "@douyinfe/semi-ui";
import type { LLMForm } from "../../api";
import { FeedbackBanner, SectionHeader } from "../ConsolePage";
import type { GlobalModelState } from "./useGlobalModel";
import styles from "./LLM.module.css";

export function GlobalModelPanel({ state }: { state: GlobalModelState }) {
  const set = (key: keyof LLMForm, value: string) => {
    state.setForm((previous) => ({ ...previous, [key]: value }));
  };
  return (
    <section className={styles.section} aria-labelledby="global-model-title">
      <SectionHeader
        title="全局模型配置"
        extra={
          <Tag color={state.config?.configured ? "green" : "grey"}>
            {state.config?.configured ? "已配置" : "未配置"}
          </Tag>
        }
      />
      <FeedbackBanner error={state.error} message={state.message} />
      {state.config?.keyFingerprint && (
        <div className={styles.fingerprint}>
          API Key fingerprint: <span className="mono">{state.config.keyFingerprint}</span>
        </div>
      )}
      <div className={styles.formGrid}>
        <ModelField
          label="Provider"
          value={state.form.provider}
          onChange={(value) => set("provider", value)}
        />
        <ModelField
          label="Model"
          value={state.form.model}
          onChange={(value) => set("model", value)}
        />
        <ModelField
          label="Base URL"
          value={state.form.baseUrl}
          onChange={(value) => set("baseUrl", value)}
          wide
        />
        <ModelField
          label="API Key"
          value={state.form.apiKey}
          onChange={(value) => set("apiKey", value)}
          placeholder={state.config?.apiKeyConfigured ? "留空保留现有密钥" : "输入 API Key"}
          password
          wide
        />
      </div>
      <Space>
        <Button
          loading={state.busy === "test"}
          disabled={state.busy !== null}
          onClick={() => void state.test()}
        >
          测试连接
        </Button>
        <Button
          theme="solid"
          loading={state.busy === "save"}
          disabled={state.busy !== null}
          onClick={() => void state.save()}
        >
          保存全局配置
        </Button>
      </Space>
    </section>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  password?: boolean;
  wide?: boolean;
}

export function ModelField(props: FieldProps) {
  return (
    <label className={props.wide ? styles.wide : undefined}>
      <span>{props.label}</span>
      <Input
        aria-label={props.label}
        type={props.password ? "password" : "text"}
        value={props.value}
        onChange={props.onChange}
        placeholder={props.placeholder}
      />
    </label>
  );
}
