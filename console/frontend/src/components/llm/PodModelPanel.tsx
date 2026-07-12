import { Button, Checkbox, Select, Space } from "@douyinfe/semi-ui";
import type { LLMForm } from "../../api";
import { FeedbackBanner, SectionHeader } from "../ConsolePage";
import { ModelField } from "./GlobalModelPanel";
import type { PodModelState } from "./usePodModels";
import styles from "./LLM.module.css";

export function PodModelPanel({ state }: { state: PodModelState }) {
  return (
    <section className={styles.section} aria-labelledby="pod-model-title">
      <SectionHeader title="Pod 模型应用与覆写" />
      <FeedbackBanner error={state.error} message={state.message} />
      <PodSelection state={state} />
      <div className={styles.divider} />
      <PodOverrideForm state={state} />
    </section>
  );
}

function PodSelection({ state }: { state: PodModelState }) {
  return (
    <div>
      <div className={styles.podChoices}>
        {state.pods.map((pod) => (
          <Checkbox
            key={pod.podId}
            checked={Boolean(state.selected[pod.podId])}
            onChange={(event) =>
              state.setSelected((previous) => ({
                ...previous,
                [pod.podId]: Boolean(event.target.checked),
              }))
            }
          >
            {pod.displayName} ({pod.podId})
          </Checkbox>
        ))}
      </div>
      <Button theme="solid" loading={state.busy === "apply"} onClick={() => void state.apply()}>
        应用到所选 Pod
      </Button>
    </div>
  );
}

function PodOverrideForm({ state }: { state: PodModelState }) {
  const set = (key: keyof LLMForm, value: string) =>
    state.setOverride((previous) => ({ ...previous, [key]: value }));
  return (
    <div>
      <Select
        aria-label="选择覆写 Pod"
        value={state.overrideId}
        placeholder="选择 Pod"
        optionList={state.pods.map((pod) => ({
          value: pod.podId,
          label: `${pod.displayName} (${pod.podId})`,
        }))}
        onChange={(value) => void state.chooseOverride(String(value ?? ""))}
        style={{ width: 320, marginBottom: 12 }}
      />
      <div className={styles.formGrid}>
        <ModelField
          label="Pod Provider"
          value={state.override.provider}
          onChange={(value) => set("provider", value)}
        />
        <ModelField
          label="Pod Model"
          value={state.override.model}
          onChange={(value) => set("model", value)}
        />
        <ModelField
          label="Pod Base URL"
          value={state.override.baseUrl}
          onChange={(value) => set("baseUrl", value)}
          wide
        />
        <ModelField
          label="Pod API Key"
          value={state.override.apiKey}
          onChange={(value) => set("apiKey", value)}
          placeholder="留空保留现有密钥"
          password
          wide
        />
      </div>
      <Space>
        <Button
          theme="solid"
          loading={state.busy === "override"}
          onClick={() => void state.saveOverride(false)}
        >
          保存 Pod 覆写
        </Button>
        <Button
          disabled={!state.overrideId || state.busy !== null}
          onClick={() => void state.saveOverride(true)}
        >
          清除 Pod 覆写
        </Button>
      </Space>
    </div>
  );
}
