import { useState } from "react";
import { Button, Form, Typography } from "@douyinfe/semi-ui";
import { api, token } from "../api";
import { FeedbackBanner } from "../components/ConsolePage";
import styles from "./Login.module.css";

interface LoginValues {
  username: string;
  password: string;
}

export function Login({ onLogin }: { onLogin: () => void }) {
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
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <main className={styles.panel}>
        <div className={styles.heading}>
          <Typography.Title heading={3}>muad 控制台</Typography.Title>
          <Typography.Text type="tertiary">管理员登录</Typography.Text>
        </div>
        <FeedbackBanner error={err} />
        <Form<LoginValues> onSubmit={(values) => void submit(values)}>
          <Form.Input
            field="username"
            label="管理员账号"
            placeholder="请输入管理员账号"
            size="large"
            rules={[{ required: true, message: "请输入管理员账号" }]}
          />
          <Form.Input
            field="password"
            label="密码"
            type="password"
            placeholder="请输入密码"
            size="large"
            rules={[{ required: true, message: "请输入密码" }]}
          />
          <Button theme="solid" htmlType="submit" loading={busy} size="large" block>
            登录
          </Button>
        </Form>
      </main>
    </div>
  );
}
