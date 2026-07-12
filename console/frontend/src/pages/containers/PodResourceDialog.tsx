import { useCallback, useEffect, useRef, useState } from "react";
import { Input, Modal, Select, Toast } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type { Pod, ResourceConfig } from "../../api";
import { FeedbackBanner } from "../../components/ConsolePage";
import { useMountedRef } from "../../hooks/useMountedRef";
import styles from "../Containers.module.css";

interface Props {
  pod: Pod | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

const EMPTY: ResourceConfig = { memLimit: "", cpuLimit: "", restartPolicy: "" };

export function PodResourceDialog(props: Props) {
  const state = usePodResourceForm(props.pod);
  const save = async () => {
    if (!props.pod) return;
    state.setBusy(true);
    state.setError("");
    try {
      await api.setPodResources(props.pod.podId, state.form);
      Toast.success("已保存资源覆盖");
      props.onClose();
      await props.onSaved();
    } catch (caught) {
      state.setError(caught instanceof Error ? caught.message : "保存 Pod 资源失败");
    } finally {
      state.setBusy(false);
    }
  };
  return (
    <Modal
      title={`资源覆盖 ${props.pod?.podId ?? ""}`}
      visible={props.pod !== null}
      onCancel={props.onClose}
      onOk={() => void save()}
      okText="保存"
      confirmLoading={state.busy}
      width={420}
    >
      <FeedbackBanner error={state.error} />
      <ResourceFields form={state.form} setForm={state.setForm} />
    </Modal>
  );
}

function usePodResourceForm(pod: Pod | null) {
  const [form, setForm] = useState<ResourceConfig>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    if (!pod) return;
    const requestId = ++requestRef.current;
    setError("");
    try {
      const resources = await api.getPodResources(pod.podId);
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setForm({
        memLimit: resources.overrides.memLimit,
        cpuLimit: resources.overrides.cpuLimit,
        restartPolicy: resources.overrides.restartPolicy,
      });
    } catch (caught) {
      if (mountedRef.current && requestId === requestRef.current) {
        setError(caught instanceof Error ? caught.message : "加载 Pod 资源失败");
      }
    }
  }, [mountedRef, pod]);
  useEffect(() => {
    void load();
  }, [load]);
  return { form, busy, error, setForm, setBusy, setError };
}

function ResourceFields({
  form,
  setForm,
}: {
  form: ResourceConfig;
  setForm: (form: ResourceConfig) => void;
}) {
  return (
    <div className={styles.dialogFields}>
      <ResourceInput
        label="内存上限"
        value={form.memLimit}
        onChange={(memLimit) => setForm({ ...form, memLimit })}
      />
      <ResourceInput
        label="CPU 上限"
        value={form.cpuLimit}
        onChange={(cpuLimit) => setForm({ ...form, cpuLimit })}
      />
      <label className={styles.field}>
        <span>重启策略</span>
        <Select
          aria-label="Pod 重启策略覆盖"
          value={form.restartPolicy}
          optionList={[
            { value: "", label: "继承全局" },
            { value: "unless-stopped", label: "unless-stopped" },
            { value: "always", label: "always" },
            { value: "on-failure", label: "on-failure" },
            { value: "no", label: "no" },
          ]}
          onChange={(value) => setForm({ ...form, restartPolicy: String(value ?? "") })}
          style={{ width: "100%" }}
        />
      </label>
    </div>
  );
}

function ResourceInput(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className={styles.field}>
      <span>{props.label}</span>
      <Input aria-label={`Pod ${props.label}覆盖`} value={props.value} onChange={props.onChange} />
    </label>
  );
}
