import { useEffect, useState } from "react";
import { Card, Button, Select, Toast } from "@douyinfe/semi-ui";
import { api, ResourceConfig } from "../api";

const RESTART_OPTIONS = [
  { value: "unless-stopped", label: "除手动停止外总重启 (unless-stopped)" },
  { value: "always", label: "总是重启 (always)" },
  { value: "on-failure", label: "失败时重启 (on-failure)" },
  { value: "no", label: "不自动重启 (no)" },
];

const empty: ResourceConfig = { memLimit: "", cpuLimit: "", restartPolicy: "unless-stopped" };

export function Settings() {
  const [form, setForm] = useState<ResourceConfig>(empty);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.getResources().then((c) => setForm({ memLimit: c.memLimit, cpuLimit: c.cpuLimit, restartPolicy: c.restartPolicy })).catch((e) => setErr((e as Error).message));
  }, []);

  function field(key: keyof ResourceConfig, value: string) { setForm({ ...form, [key]: value }); }

  async function save() {
    setErr("");
    try {
      await api.setResources(form);
      Toast.success("已保存。对已运行容器需重建后生效。");
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div>
      {err && <p style={{ color: "var(--semi-color-danger)", fontSize: 13 }}>{err}</p>}
      <Card title="容器资源默认配置（全局）">
        <p className="hint">新建/重建容器时套用。已运行容器改动后需<b>重建</b>才生效。每用户可在容器页单独覆盖。</p>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "10px 12px", alignItems: "center", maxWidth: 520, margin: "12px 0" }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--semi-color-text-2)" }}>内存上限</label>
          <input style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--semi-color-border)", borderRadius: 4, background: "var(--semi-color-fill-0)", color: "var(--semi-color-text-1)", fontSize: 13 }} value={form.memLimit} onChange={(e) => field("memLimit", e.target.value)} placeholder="如 2g / 2560m" />
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--semi-color-text-2)" }}>CPU 上限</label>
          <input style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--semi-color-border)", borderRadius: 4, background: "var(--semi-color-fill-0)", color: "var(--semi-color-text-1)", fontSize: 13 }} value={form.cpuLimit} onChange={(e) => field("cpuLimit", e.target.value)} placeholder="如 1.5" />
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--semi-color-text-2)" }}>重启策略</label>
          <Select value={form.restartPolicy} optionList={RESTART_OPTIONS} onChange={(v) => field("restartPolicy", v as string)} style={{ width: 300 }} />
        </div>
        <p className="hint">
          重启策略 = 容器异常退出或宿主重启后是否自动拉起：<br />
          · <b>除手动停止外总重启</b>：崩溃/宿主重启都拉起，但手动停的保持停止（默认推荐）<br />
          · <b>总是重启</b>：连手动停的也会被拉起<br />
          · <b>失败时重启</b>：仅非正常退出（退出码≠0）时重启<br />
          · <b>不自动重启</b>：退出后保持停止
        </p>
        <div style={{ marginTop: 12 }}><Button onClick={save}>保存</Button></div>
      </Card>
    </div>
  );
}
