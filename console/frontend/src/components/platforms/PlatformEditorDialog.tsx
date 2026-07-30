import { useEffect, useState } from "react";
import { Input, Modal, Switch, Toast } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type { Platform } from "../../api";
import { FeedbackBanner, setRepeatableError } from "../ConsolePage";
import { Field } from "../human-users/shared";
import styles from "./PlatformSettings.module.css";

interface Props {
  visible: boolean;
  platform: Platform | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

interface Form {
  platform: string;
  displayName: string;
  enabled: boolean;
}

function initialForm(platform: Platform | null): Form {
  return {
    platform: platform?.platform ?? "",
    displayName: platform?.displayName ?? "",
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
        editing={props.platform !== null}
        setForm={editor.setForm}
      />
    </Modal>
  );
}

function usePlatformEditor(props: Props) {
  const [form, setForm] = useState<Form>(() => initialForm(props.platform));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!props.visible) return;
    setForm(initialForm(props.platform));
    setError("");
  }, [props.platform, props.visible]);

  const submit = async () => {
    if (!form.platform || !form.displayName.trim()) {
      return setRepeatableError(setError, "平台和显示名称必填");
    }
    setBusy(true);
    setError("");
    try {
      if (props.platform) {
        await api.patchPlatform(props.platform.platform, {
          displayName: form.displayName.trim(),
          enabled: form.enabled,
        });
      } else {
        await api.createPlatform({
          platform: form.platform,
          displayName: form.displayName.trim(),
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

function PlatformFields({
  form,
  editing,
  setForm,
}: {
  form: Form;
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
          placeholder="例如 mssw"
          onChange={(platform) => setForm({ ...form, platform })}
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
    </div>
  );
}
