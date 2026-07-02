import { FormEvent, useState } from "react";
import { Input, Button } from "@douyinfe/semi-ui";
import { api, token } from "../api";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const res = await api.login(username, password);
      token.set(res.token);
      onLogin();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh", background: "var(--semi-color-fill-0)" }}>
      <div style={{ width: 380, padding: 32, borderRadius: 8, background: "var(--semi-color-bg-2)" }}>
        <h2 style={{ textAlign: "center", marginBottom: 24, color: "var(--semi-color-text-0)" }}>muad 控制台</h2>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Input placeholder="管理员账号" value={username} onChange={setUsername} size="large" />
          <Input type="password" placeholder="密码" value={password} onChange={setPassword} size="large" />
          {err && <p style={{ color: "var(--semi-color-danger)", fontSize: 13, margin: 0 }}>{err}</p>}
          <Button theme="solid" type="primary" htmlType="submit" loading={busy} size="large" block>
            登录
          </Button>
        </form>
      </div>
    </div>
  );
}
