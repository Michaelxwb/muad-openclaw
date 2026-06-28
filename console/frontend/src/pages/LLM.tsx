import { useEffect, useState } from "react";
import { api, Container, LLMForm } from "../api";
import styles from "./LLM.module.css";

const empty: LLMForm = {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "",
};

export function LLM() {
  const [form, setForm] = useState<LLMForm>(empty);
  const [configured, setConfigured] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const [containers, setContainers] = useState<Container[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const [overrideId, setOverrideId] = useState("");
  const [override, setOverride] = useState<LLMForm>(empty);

  const [testOutput, setTestOutput] = useState("");
  const [testLoading, setTestLoading] = useState(false);
  const [testError, setTestError] = useState("");
  // 连通性测试通过后才允许批量应用；全局配置一变更即失效，需重新测试。
  const [tested, setTested] = useState(false);

  useEffect(() => {
    api
      .getLLM()
      .then((c) => {
        setConfigured(c.configured);
        if (c.configured) {
          setForm((f) => ({
            ...f,
            provider: c.provider ?? "",
            baseUrl: c.baseUrl ?? "",
            model: c.model ?? "",
          }));
        }
      })
      .catch((e) => setErr((e as Error).message));
    api
      .listContainers()
      .then((res) => setContainers(res.items))
      .catch(() => {});
  }, []);

  function field(key: keyof LLMForm, value: string) {
    setForm({ ...form, [key]: value });
    setTested(false); // 配置变更 → 之前的测试结果失效
  }

  async function test() {
    setErr("");
    setMsg("");
    setTestError("");
    setTestLoading(true);
    setTestOutput("Testing…");
    try {
      await api.testLLM(form);
      setTestOutput("连通性测试通过 ✓");
      setTestError("");
      setMsg("连通性测试通过");
      setTested(true);
    } catch (e) {
      setTestOutput("");
      setTestError(`FAILED: ${(e as Error).message}`);
    } finally {
      setTestLoading(false);
    }
  }

  async function save() {
    setErr("");
    setMsg("");
    try {
      await api.setLLM(form);
      setConfigured(true);
      setTested(true); // 保存接口已重新连通性测试
      setMsg("已保存");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function apply() {
    if (!tested) {
      setErr("请先通过「连通性测试」再批量应用");
      return;
    }
    const ids = Object.keys(selected).filter((k) => selected[k]);
    if (ids.length === 0) {
      setErr("请先勾选要应用的容器");
      return;
    }
    setErr("");
    setMsg("");
    try {
      const r = await api.applyLLM(ids);
      setMsg("批量应用结果：" + JSON.stringify(r.results));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function saveOverride() {
    if (!overrideId) {
      setErr("请填写 user_id");
      return;
    }
    setErr("");
    setMsg("");
    try {
      await api.setUserLLM(overrideId, override);
      setMsg(`已为 ${overrideId} 设置覆盖`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className={styles.page}>
      {err && <div className="error">{err}</div>}
      {msg && <div className="ok">{msg}</div>}

      {/* Card 1: Global Config */}
      <div className={styles.card}>
        <h3 className={styles.cardTitle}>全局配置 {configured ? "" : "（未配置）"}</h3>
        <div className={styles.formGrid}>
          <label>provider</label>
          <input value={form.provider} onChange={(e) => field("provider", e.target.value)} />
          <label>baseUrl</label>
          <input value={form.baseUrl} onChange={(e) => field("baseUrl", e.target.value)} />
          <label>apiKey</label>
          <input
            type="password"
            placeholder={configured ? "（已配置，留空不改请勿保存）" : ""}
            value={form.apiKey}
            onChange={(e) => field("apiKey", e.target.value)}
          />
          <label>model</label>
          <input value={form.model} onChange={(e) => field("model", e.target.value)} />
        </div>
        <div className="row">
          <button onClick={save}>保存</button>
        </div>
      </div>

      {/* Card 2: Connectivity Test */}
      {testOutput || testError || testLoading ? (
        <div className={styles.card}>
          <h3 className={styles.cardTitle}>连通性测试</h3>
          <div className="row">
            <button onClick={test}>测试连接</button>
          </div>
          <div
            className={`${styles.terminal} ${
              testError ? styles.terminalError : testLoading ? styles.terminalLoading : ""
            }`}
          >
            {testOutput || testError}
          </div>
        </div>
      ) : (
        <div className={styles.card}>
          <h3 className={styles.cardTitle}>连通性测试</h3>
          <div className="row">
            <button onClick={test}>测试连接</button>
          </div>
        </div>
      )}

      {/* Card 3: Batch Apply + Per-User Override */}
      <div className={styles.card}>
        <h3 className={styles.cardTitle}>批量应用与覆盖</h3>
        <p className="hint">
          改全局后只影响新建；勾选容器「应用到所选」会<b>完整重建容器</b>（保留状态卷与登录态）使新
          LLM 生效——不是热加载、也不是 docker restart（重启不会重载 env 里的 LLM）。
          {!tested && <span className="error"> 需先通过「连通性测试」才能批量应用。</span>}
        </p>
        <div className={styles.checks}>
          {containers.map((c) => (
            <label key={c.userId} className={styles.check}>
              <input
                type="checkbox"
                checked={!!selected[c.userId]}
                onChange={(e) => setSelected({ ...selected, [c.userId]: e.target.checked })}
              />
              {c.userId}
            </label>
          ))}
          {containers.length === 0 && <span className="hint">暂无容器</span>}
        </div>
        <button onClick={apply} disabled={!tested} title={tested ? "" : "请先连通性测试"}>
          应用到所选
        </button>

        <h3 className={styles.subTitle}>单用户覆盖</h3>
        <p className="hint">
          保存覆盖时会先做连通性测试（global ⊕
          覆盖），不通过则不保存；保存后需对该用户「应用到所选」才生效。
        </p>
        <div className={styles.formGrid}>
          <label>user_id</label>
          <input value={overrideId} onChange={(e) => setOverrideId(e.target.value)} />
          <label>provider</label>
          <input
            value={override.provider}
            onChange={(e) => setOverride({ ...override, provider: e.target.value })}
          />
          <label>baseUrl</label>
          <input
            value={override.baseUrl}
            onChange={(e) => setOverride({ ...override, baseUrl: e.target.value })}
          />
          <label>apiKey</label>
          <input
            type="password"
            value={override.apiKey}
            onChange={(e) => setOverride({ ...override, apiKey: e.target.value })}
          />
          <label>model</label>
          <input
            value={override.model}
            onChange={(e) => setOverride({ ...override, model: e.target.value })}
          />
        </div>
        <button onClick={saveOverride}>保存覆盖</button>
      </div>
    </div>
  );
}
