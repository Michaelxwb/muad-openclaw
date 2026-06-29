import { useEffect, useState } from "react";
import { api, ResourceConfig } from "../api";
import { Select } from "../components/Select";
import styles from "./Settings.module.css";

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
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api
      .getResources()
      .then((c) => setForm({ memLimit: c.memLimit, cpuLimit: c.cpuLimit, restartPolicy: c.restartPolicy }))
      .catch((e) => setErr((e as Error).message));
  }, []);

  function field(key: keyof ResourceConfig, value: string) {
    setForm({ ...form, [key]: value });
  }

  async function save() {
    setErr("");
    setMsg("");
    try {
      await api.setResources(form);
      setMsg("已保存。对已运行容器需重建（容器页「升级」或模型页「应用到所选」）后生效。");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div>
      {err && <div className="error">{err}</div>}
      {msg && <div className="ok">{msg}</div>}

      <div className={styles.card}>
        <h3 className={styles.cardTitle}>容器资源默认配置（全局）</h3>
        <p className="hint">
          新建/重建容器时套用。已运行容器改动后需<b>重建</b>才生效（非热加载）。每用户可在容器页单独覆盖。
        </p>
        <div className={styles.formGrid}>
          <label>内存上限</label>
          <input
            value={form.memLimit}
            onChange={(e) => field("memLimit", e.target.value)}
            placeholder="如 2g / 2560m"
          />
          <label>CPU 上限</label>
          <input
            value={form.cpuLimit}
            onChange={(e) => field("cpuLimit", e.target.value)}
            placeholder="如 1.5"
          />
          <label>重启策略</label>
          <Select
            value={form.restartPolicy}
            options={RESTART_OPTIONS}
            onChange={(v) => field("restartPolicy", v)}
            minWidth={260}
          />
        </div>
        <p className="hint">
          重启策略 = 容器异常退出或宿主重启后是否自动拉起：
          <br />· <b>除手动停止外总重启</b>：崩溃/宿主重启都拉起，但你手动停的就保持停止（默认，推荐）
          <br />· <b>总是重启</b>：连你手动停的也会被拉起
          <br />· <b>失败时重启</b>：仅非正常退出（退出码≠0）时重启
          <br />· <b>不自动重启</b>：退出后保持停止
        </p>
        <div className="row">
          <button onClick={save}>保存</button>
        </div>
      </div>
    </div>
  );
}
