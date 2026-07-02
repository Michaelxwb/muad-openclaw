import { useEffect, useState } from "react";
import { Card, Button, Toast } from "@douyinfe/semi-ui";
import { api, Container, LLMForm } from "../api";

const empty: LLMForm = { provider: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "", model: "" };

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
  const [tested, setTested] = useState(false);

  useEffect(() => {
    api.getLLM().then((c) => {
      setConfigured(c.configured);
      if (c.configured) setForm((f) => ({ ...f, provider: c.provider ?? "", baseUrl: c.baseUrl ?? "", model: c.model ?? "" }));
    }).catch((e) => setErr((e as Error).message));
    api.listContainers().then((res) => setContainers(res.items)).catch(() => {});
  }, []);

  function field(key: keyof LLMForm, value: string) { setForm({ ...form, [key]: value }); setTested(false); }

  async function test() {
    setErr(""); setMsg(""); setTestError(""); setTestLoading(true); setTestOutput("Testing…");
    try {
      await api.testLLM(form);
      setTestOutput("连通性测试通过 ✓"); setTestError(""); setTested(true);
    } catch (e) {
      setTestOutput(""); setTestError(`FAILED: ${(e as Error).message}`);
    } finally { setTestLoading(false); }
  }

  async function save() {
    setErr(""); setMsg("");
    try {
      await api.setLLM(form);
      setConfigured(true); setTested(true); Toast.success("已保存");
    } catch (e) { setErr((e as Error).message); }
  }

  async function apply() {
    if (!tested) { setErr("请先通过「连通性测试」再批量应用"); return; }
    const ids = Object.keys(selected).filter((k) => selected[k]);
    if (ids.length === 0) { setErr("请先勾选要应用的容器"); return; }
    setErr(""); setMsg("");
    try {
      const r = await api.applyLLM(ids);
      Toast.success("批量应用结果：" + JSON.stringify(r.results));
    } catch (e) { setErr((e as Error).message); }
  }

  async function saveOverride() {
    if (!overrideId) { setErr("请填写 user_id"); return; }
    setErr(""); setMsg("");
    try {
      await api.setUserLLM(overrideId, override);
      Toast.success(`已为 ${overrideId} 设置覆盖`);
    } catch (e) { setErr((e as Error).message); }
  }

  const input = (k: keyof LLMForm, placeholder?: string, type = "text") => (
    <input
      type={type === "password" ? "password" : "text"}
      style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--semi-color-border)", borderRadius: 4, background: "var(--semi-color-fill-0)", color: "var(--semi-color-text-1)", fontSize: 13 }}
      value={form[k]} onChange={(e) => field(k, e.target.value)}
      placeholder={type === "password" && configured ? "（已配置，留空不改）" : placeholder}
    />
  );

  return (
    <div>
      {err && <p style={{ color: "var(--semi-color-danger)", fontSize: 13 }}>{err}</p>}
      {msg && <p style={{ color: "var(--semi-color-success)", fontSize: 13 }}>{msg}</p>}

      <Card title={`全局配置 ${configured ? "" : "（未配置）"}`} style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "10px 12px", alignItems: "center", maxWidth: 560 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--semi-color-text-2)" }}>provider</label>
          {input("provider")}
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--semi-color-text-2)" }}>baseUrl</label>
          {input("baseUrl")}
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--semi-color-text-2)" }}>apiKey</label>
          {input("apiKey", "", "password")}
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--semi-color-text-2)" }}>model</label>
          {input("model")}
        </div>
        <div style={{ marginTop: 12 }}>
          <Button onClick={save}>保存</Button>
        </div>
      </Card>

      <Card title="连通性测试" style={{ marginBottom: 16 }}>
        <Button onClick={test} loading={testLoading}>测试连接</Button>
        {testOutput && <pre style={{ marginTop: 10, padding: 10, background: "var(--semi-color-fill-0)", borderRadius: 4, fontFamily: "monospace", fontSize: 12, color: testError ? "var(--semi-color-danger)" : "var(--semi-color-success)" }}>{testOutput || testError}</pre>}
      </Card>

      <Card title="批量应用与覆盖" style={{ marginBottom: 16 }}>
        <p className="hint">改全局后只影响新建；勾选容器「应用到所选」会<b>完整重建容器</b>（保留状态卷），不是热加载。{!tested && <span style={{ color: "var(--semi-color-danger)" }}> 需先通过「连通性测试」才能批量应用。</span>}</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, margin: "10px 0" }}>
          {containers.map((c) => (
            <label key={c.userId} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={!!selected[c.userId]} onChange={(e) => setSelected({ ...selected, [c.userId]: e.target.checked })} />
              {c.userId}
            </label>
          ))}
        </div>
        <Button onClick={apply} disabled={!tested}>应用到所选</Button>

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--semi-color-border)" }}>
          <h4 style={{ fontSize: 14, color: "var(--semi-color-text-2)", margin: "0 0 10px" }}>单用户覆盖</h4>
          <p className="hint">保存覆盖时会先做连通性测试，不通过则不保存；保存后需对该用户「应用到所选」才生效。</p>
          <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "8px 12px", alignItems: "center", maxWidth: 560, margin: "10px 0" }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--semi-color-text-2)" }}>user_id</label>
            <input style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--semi-color-border)", borderRadius: 4, background: "var(--semi-color-fill-0)", color: "var(--semi-color-text-1)", fontSize: 13 }} value={overrideId} onChange={(e) => setOverrideId(e.target.value)} />
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--semi-color-text-2)" }}>provider</label>
            <input style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--semi-color-border)", borderRadius: 4, background: "var(--semi-color-fill-0)", color: "var(--semi-color-text-1)", fontSize: 13 }} value={override.provider} onChange={(e) => setOverride({ ...override, provider: e.target.value })} />
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--semi-color-text-2)" }}>baseUrl</label>
            <input style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--semi-color-border)", borderRadius: 4, background: "var(--semi-color-fill-0)", color: "var(--semi-color-text-1)", fontSize: 13 }} value={override.baseUrl} onChange={(e) => setOverride({ ...override, baseUrl: e.target.value })} />
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--semi-color-text-2)" }}>apiKey</label>
            <input type="password" style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--semi-color-border)", borderRadius: 4, background: "var(--semi-color-fill-0)", color: "var(--semi-color-text-1)", fontSize: 13 }} value={override.apiKey} onChange={(e) => setOverride({ ...override, apiKey: e.target.value })} />
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--semi-color-text-2)" }}>model</label>
            <input style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--semi-color-border)", borderRadius: 4, background: "var(--semi-color-fill-0)", color: "var(--semi-color-text-1)", fontSize: 13 }} value={override.model} onChange={(e) => setOverride({ ...override, model: e.target.value })} />
          </div>
          <Button onClick={saveOverride}>保存覆盖</Button>
        </div>
      </Card>
    </div>
  );
}
