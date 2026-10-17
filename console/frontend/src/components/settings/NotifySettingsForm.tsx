import { Button, Input, Space, Switch } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import styles from "../../pages/Settings.module.css";

export interface NotifySettingsFormValue {
  enabled: boolean;
  webhook: string;
}

export interface NotifySettingsFormProps {
  value: NotifySettingsFormValue;
  busy: boolean;
  testing: boolean;
  maskedWebhook: string;
  onChange: (next: NotifySettingsFormValue) => void;
  onSave: () => void;
  onTest: () => void;
}

export function NotifySettingsForm({
  value,
  busy,
  testing,
  maskedWebhook,
  onChange,
  onSave,
  onTest,
}: NotifySettingsFormProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.notifyGrid}>
      <div className={styles.notifyField}>
        <label htmlFor="notify-enabled">{t("settings.notifyEnabled")}</label>
        <Switch
          id="notify-enabled"
          aria-label={t("settings.notifyEnabledAria")}
          checked={value.enabled}
          disabled={busy || testing}
          onChange={(enabled) => onChange({ ...value, enabled })}
        />
      </div>
      <div className={styles.notifyField}>
        <label htmlFor="notify-webhook">{t("settings.notifyWebhook")}</label>
        <Input
          id="notify-webhook"
          aria-label={t("settings.notifyWebhookLabel")}
          value={value.webhook}
          disabled={busy || testing}
          autoComplete="off"
          onChange={(webhook) => onChange({ ...value, webhook })}
          placeholder={
            maskedWebhook ? t("settings.notifyKeepHint") : t("settings.notifyWebhookPlaceholder")
          }
        />
        {maskedWebhook ? (
          <>
            <span className={styles.fieldHint}>
              {t("settings.notifyMaskedCurrent", { webhook: maskedWebhook })}
            </span>
            <span className={styles.fieldHint}>{t("settings.notifyKeepHint")}</span>
          </>
        ) : (
          <span className={styles.fieldHint}>{t("settings.notifyNotConfigured")}</span>
        )}
      </div>
      <div className={styles.notifyActions}>
        <Space>
          <Button theme="solid" loading={busy} disabled={testing} onClick={onSave}>
            {t("settings.notifySave")}
          </Button>
          <Button loading={testing} disabled={busy} onClick={onTest}>
            {t("settings.notifyTest")}
          </Button>
        </Space>
      </div>
    </div>
  );
}
