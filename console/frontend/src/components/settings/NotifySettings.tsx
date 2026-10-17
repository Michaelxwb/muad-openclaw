import { useCallback, useEffect, useRef, useState } from "react";
import { Banner, Button, Skeleton } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api";
import { PageSection } from "../ConsolePage";
import { useMountedRef } from "../../hooks/useMountedRef";
import { errorMessage, ErrorDetail } from "../../utils/error";
import { NotifySettingsForm, type NotifySettingsFormValue } from "./NotifySettingsForm";

const EMPTY: NotifySettingsFormValue = { enabled: false, webhook: "" };

// NotifySettings reads/writes the WeCom alert channel. The backend only ever
// returns a masked webhook, so the input stays empty and an empty value on save
// means "keep the stored webhook".
export function NotifySettings() {
  const { t } = useTranslation();
  const [value, setValue] = useState<NotifySettingsFormValue>(EMPTY);
  const [masked, setMasked] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState<string | undefined>();
  const [message, setMessage] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoadError("");
    setLoading(true);
    try {
      const result = await api.getNotifySettings();
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setValue({ enabled: result.enabled, webhook: "" });
      setMasked(result.webhook);
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setLoadError(errorMessage(caught, "settings.notifyLoadFailed"));
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [mountedRef]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError("");
    setErrorDetail(undefined);
    setMessage("");
    try {
      const webhook = value.webhook.trim();
      const saved = await api.setNotifySettings({
        enabled: value.enabled,
        ...(webhook ? { webhook } : {}),
      });
      if (!mountedRef.current) return;
      setValue({ enabled: saved.enabled, webhook: "" });
      setMasked(saved.webhook);
      setMessage(t("settings.notifySaved"));
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(errorMessage(caught, "settings.notifySaveFailed"));
      setErrorDetail(caught instanceof ApiError ? caught.detail : undefined);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setError("");
    setErrorDetail(undefined);
    setMessage("");
    try {
      const result = await api.testNotifySettings();
      if (!mountedRef.current) return;
      if (result.ok) {
        setMessage(t("settings.notifyTestSucceeded"));
      } else {
        setError(
          t("settings.notifyTestFailed", { errcode: result.errcode, errmsg: result.errmsg }),
        );
      }
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(errorMessage(caught, "settings.notifyTestFailedGeneric"));
      setErrorDetail(caught instanceof ApiError ? caught.detail : undefined);
    } finally {
      if (mountedRef.current) setTesting(false);
    }
  };

  return (
    <PageSection title={t("settings.notifyTitle")}>
      {loading ? (
        <Skeleton placeholder={<Skeleton.Paragraph rows={2} />} loading />
      ) : loadError ? (
        <>
          <Banner type="danger" description={loadError} />
          <Button onClick={() => void load()}>{t("common.retry")}</Button>
        </>
      ) : (
        <>
          {error ? <Banner type="danger" description={error} /> : null}
          {message ? <Banner type="success" description={message} /> : null}
          <ErrorDetail detail={errorDetail} />
          <NotifySettingsForm
            value={value}
            busy={busy}
            testing={testing}
            maskedWebhook={masked}
            onChange={setValue}
            onSave={() => void save()}
            onTest={() => void test()}
          />
        </>
      )}
    </PageSection>
  );
}
