import { useEffect, useState } from "react";
import { Input, Modal, Switch, TextArea, Toast } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type { Platform } from "../../api";
import { FeedbackBanner } from "../ConsolePage";
import { Field } from "../human-users/shared";
import type { PLATFORM_OPTIONS } from "./PlatformSettings";
import styles from "./PlatformSettings.module.css";

type PlatformOption = (typeof PLATFORM_OPTIONS)[number];

interface Props {
  visible: boolean;
  platform: Platform | null;
  available: PlatformOption[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}

interface Form {
  platform: string;
  displayName: string;
  config: string;
  enabled: boolean;
}

function initialForm(platform: Platform | null, available: PlatformOption[]): Form {
  const selected = available[0];
  return {
    platform: platform?.platform ?? selected?.value ?? "",
    displayName: platform?.displayName ?? selected?.label ?? "",
    config: JSON.stringify(platform?.config ?? {}, null, 2),
    enabled: platform?.enabled ?? true,
  };
}

export function PlatformEditorDialog(props: Props) {
  const editor = usePlatformEditor(props);
  return (
    <Modal
      className="standard-modal"
      title={props.platform ? `编辑 ${props.platform.displayName}` : "增加业务平台"}
      visible={props.visible}
      onCancel={props.onClose}
      onOk={() => void editor.submit()}
      okText="保存"
      confirmLoading={editor.busy}
      width={620}
    >
      <FeedbackBanner error={editor.error} />
      <PlatformFields
        form={editor.form}
        available={props.available}
        editing={props.platform !== null}
        setForm={editor.setForm}
      />
    </Modal>
  );
}

function usePlatformEditor(props: Props) {
  const [form, setForm] = useState<Form>(() => initialForm(props.platform, props.available));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!props.visible) return;
    setForm(initialForm(props.platform, props.available));
    setError("");
  }, [props.available, props.platform, props.visible]);

  const submit = async () => {
    const parsed = parseConfig(form.config);
    if (typeof parsed === "string") return setError(parsed);
    if (!form.platform || !form.displayName.trim()) return setError("平台和显示名称必填");
    setBusy(true);
    setError("");
    try {
      if (props.platform) {
        await api.patchPlatform(props.platform.platform, {
          displayName: form.displayName.trim(),
          config: parsed,
          enabled: form.enabled,
        });
      } else {
        await api.createPlatform({
          platform: form.platform,
          displayName: form.displayName.trim(),
          config: parsed,
          enabled: form.enabled,
        });
      }
      Toast.success(props.platform ? "平台配置已保存" : "平台已增加");
      await props.onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存平台失败");
    } finally {
      setBusy(false);
    }
  };

  return { form, busy, error, setForm, submit };
}

function parseConfig(raw: string): Record<string, unknown> | string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "平台配置必须是 JSON 对象";
    }
    return parsed as Record<string, unknown>;
  } catch (caught) {
    return caught instanceof Error ? `平台配置 JSON 无效：${caught.message}` : "平台配置 JSON 无效";
  }
}

function PlatformFields({
  form,
  available,
  editing,
  setForm,
}: {
  form: Form;
  available: PlatformOption[];
  editing: boolean;
  setForm: (form: Form) => void;
}) {
  return (
    <div className={styles.formGrid}>
      <Field label="平台">
        <Input
          aria-label="业务平台"
          value={form.platform}
          disabled={editing}
          placeholder={available.length > 0 ? available[0]?.value : "例如 custom_api"}
          onChange={(platform) => {
            const selected = available.find((option) => option.value === platform);
            setForm({ ...form, platform, displayName: selected?.label ?? form.displayName });
          }}
        />
      </Field>
      <Field label="显示名称">
        <Input
          aria-label="平台显示名称"
          value={form.displayName}
          onChange={(displayName) => setForm({ ...form, displayName })}
        />
      </Field>
      <Field label="启用">
        <Switch
          aria-label="平台启用状态"
          checked={form.enabled}
          onChange={(enabled) => setForm({ ...form, enabled })}
        />
      </Field>
      <div className={styles.full}>
        <Field label="平台配置（JSON）">
          <TextArea
            aria-label="平台配置 JSON"
            value={form.config}
            onChange={(config) => setForm({ ...form, config })}
            rows={8}
          />
        </Field>
      </div>
    </div>
  );
}
