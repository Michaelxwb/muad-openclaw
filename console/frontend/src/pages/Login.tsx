import { useState } from "react";
import { Button, Form, Typography } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api, token } from "../api";
import { errorMessage } from "../utils/error";
import { FeedbackBanner } from "../components/ConsolePage";
import styles from "./Login.module.css";

interface LoginValues {
  username: string;
  password: string;
}

export function Login({ onLogin }: { onLogin: () => void }) {
  const { t } = useTranslation();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(values: LoginValues) {
    setErr("");
    setBusy(true);
    try {
      const res = await api.login(values.username, values.password);
      token.set(res.token);
      onLogin();
    } catch (e) {
      setErr(errorMessage(e, "errors.badCredentials"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <main className={styles.panel}>
        <div className={styles.heading}>
          <Typography.Title heading={3}>{t("login.consoleTitle")}</Typography.Title>
          <Typography.Text type="tertiary">{t("login.adminLogin")}</Typography.Text>
        </div>
        <FeedbackBanner error={err} />
        <Form<LoginValues> onSubmit={(values) => void submit(values)}>
          <Form.Input
            field="username"
            label={t("login.username")}
            placeholder={t("login.usernamePlaceholder")}
            size="large"
            rules={[{ required: true, message: t("login.usernamePlaceholder") }]}
          />
          <Form.Input
            field="password"
            label={t("login.password")}
            type="password"
            placeholder={t("login.passwordPlaceholder")}
            size="large"
            rules={[{ required: true, message: t("login.passwordPlaceholder") }]}
          />
          <Button theme="solid" htmlType="submit" loading={busy} size="large" block>
            {t("login.submit")}
          </Button>
        </Form>
      </main>
    </div>
  );
}
