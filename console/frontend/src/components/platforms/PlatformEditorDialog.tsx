import { useEffect, useState } from "react";
import { Input, Modal, Switch, Toast } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api";
import type { Platform } from "../../api";
import { FeedbackBanner, setRepeatableError } from "../ConsolePage";
import { Field } from "../human-users/shared";
import { errorMessage, ErrorDetail } from "../../utils/error";
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
  const { t } = useTranslation();
  const editor = usePlatformEditor(props);
  return (
    <Modal
      className="standard-modal"
      title={
        props.platform
          ? t("platform.editTitle", { name: props.platform.displayName })
          : t("platform.createTitle")
      }
      visible={props.visible}
      onCancel={props.onClose}
      onOk={() => void editor.submit()}
      okText={t("common.save")}
      confirmLoading={editor.busy}
      width={620}
    >
      <FeedbackBanner error={editor.error} />
      <ErrorDetail detail={editor.errorDetail} />
      <PlatformFields
        form={editor.form}
        editing={props.platform !== null}
        setForm={editor.setForm}
      />
    </Modal>
  );
}

function usePlatformEditor(props: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<Form>(() => initialForm(props.platform));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState<string | undefined>();
  useEffect(() => {
    if (!props.visible) return;
    setForm(initialForm(props.platform));
    setError("");
    setErrorDetail(undefined);
  }, [props.platform, props.visible]);

  const submit = async () => {
    if (!form.platform || !form.displayName.trim()) {
      setErrorDetail(undefined);
      return setRepeatableError(setError, t("platform.nameRequired"));
    }
    setBusy(true);
    setError("");
    setErrorDetail(undefined);
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
      Toast.success(props.platform ? t("platform.saved") : t("platform.created"));
      await props.onSaved();
    } catch (caught) {
      setError(errorMessage(caught, "platform.saveFailed"));
      setErrorDetail(caught instanceof ApiError ? caught.detail : undefined);
    } finally {
      setBusy(false);
    }
  };

  return { form, busy, error, errorDetail, setForm, submit };
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
  const { t } = useTranslation();
  return (
    <div className={styles.formGrid}>
      <Field label={t("platform.platformLabel")}>
        <Input
          aria-label={t("platform.platformAria")}
          value={form.platform}
          disabled={editing}
          placeholder={t("platform.platformPlaceholder")}
          onChange={(platform) => setForm({ ...form, platform })}
        />
      </Field>
      <Field label={t("platform.displayName")}>
        <Input
          aria-label={t("platform.displayNameAria")}
          value={form.displayName}
          onChange={(displayName) => setForm({ ...form, displayName })}
        />
      </Field>
      <Field label={t("platform.enabled")}>
        <Switch
          aria-label={t("platform.enabledAria")}
          checked={form.enabled}
          onChange={(enabled) => setForm({ ...form, enabled })}
        />
      </Field>
    </div>
  );
}
