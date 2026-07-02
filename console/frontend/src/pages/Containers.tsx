import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Modal, Table, Tag, Select, Dropdown, Input, Space, Toast } from "@douyinfe/semi-ui";
import type { BasicSelectValue } from "@douyinfe/semi-ui/lib/es/select";
import QRCode from "qrcode";
import { api, Container } from "../api";
import { CHANNELS, channelMeta } from "../channels";
import { Pagination } from "../components/Pagination";

const STATUS_TAGS: Record<string, { label: string; color: "green" | "blue" | "red" | "orange" | "grey" | "light-blue" }> = {
  creating: { label: "创建中", color: "light-blue" },
  running: { label: "运行中", color: "green" },
  stopped: { label: "已停止", color: "grey" },
  archived: { label: "已归档", color: "grey" },
  unhealthy: { label: "不健康", color: "orange" },
  error: { label: "异常", color: "red" },
  missing: { label: "已删除", color: "grey" },
};

const STATUS_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "running", label: "运行中" },
  { value: "stopped", label: "已停止" },
  { value: "error", label: "异常" },
  { value: "unhealthy", label: "不健康" },
  { value: "missing", label: "已删除" },
];

const CHANNEL_OPTIONS = [
  { value: "all", label: "全部通道" },
  ...CHANNELS.map((c) => ({ value: c.value, label: c.icon + " " + c.label })),
];

const CONN_OPTIONS = [
  { value: "all", label: "全部连接" },
  { value: "online", label: "在线" },
  { value: "offline", label: "离线" },
];

const ACTIONS = [
  { key: "start", label: "启动" },
  { key: "stop", label: "停止" },
  { key: "restart", label: "重启" },
  { key: "reap", label: "回收" },
  { key: "revive", label: "唤醒" },
];

function fmtReap(sec?: number): string {
  if (sec === undefined) return "—";
  if (sec <= 0) return "可回收";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d > 0 ? `${d}天${h}时` : `${h}时`;
}

function fmtActive(ts?: string): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

export function Containers() {
  const [items, setItems] = useState<Container[]>([]);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [connFilter, setConnFilter] = useState("all");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [createOpen, setCreateOpen] = useState(false);
  const [logView, setLogView] = useState<{ id: string; text: string } | null>(null);
  const [qrTarget, setQrTarget] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [qrLoading, setQrLoading] = useState(false);
  const [qrConnected, setQrConnected] = useState(false);
  const [delTarget, setDelTarget] = useState<string | null>(null);
  const [delVolume, setDelVolume] = useState(false);
  const [upgradeTarget, setUpgradeTarget] = useState<Container | null>(null);
  const [upgradeTag, setUpgradeTag] = useState("");
  const [reloadOpen, setReloadOpen] = useState(false);
  const [resTarget, setResTarget] = useState<Container | null>(null);
  const [resForm, setResForm] = useState({ memLimit: "", cpuLimit: "", restartPolicy: "" });

  // Create-modal form
  const [newUserId, setNewUserId] = useState("");
  const [newChannel, setNewChannel] = useState<"wecom" | "wechat">("wecom");
  const [newBotId, setNewBotId] = useState("");
  const [newSecret, setNewSecret] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState("");

  const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  const refresh = useCallback(async () => {
    try {
      const res = await api.listContainers();
      setItems(res.items);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const filtered = useMemo(() => {
    return items.filter((c) => {
      const matchSearch = !search || c.userId.toLowerCase().includes(search.toLowerCase());
      const matchStatus = statusFilter === "all" || c.state === statusFilter;
      const matchChannel = channelFilter === "all" || c.channel === channelFilter;
      const matchConn = connFilter === "all" || (connFilter === "online" ? c.channelConnected : !c.channelConnected);
      return matchSearch && matchStatus && matchChannel && matchConn;
    });
  }, [items, search, statusFilter, channelFilter, connFilter]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize],
  );

  function onSearch(v: string) { setSearch(v); setPage(1); }
  function onStatusFilter(v: BasicSelectValue | undefined | BasicSelectValue[]) { setStatusFilter(String(v ?? "all")); setPage(1); }
  function onChannelFilter(v: BasicSelectValue | undefined | BasicSelectValue[]) { setChannelFilter(String(v ?? "all")); setPage(1); }
  function onConnFilter(v: BasicSelectValue | undefined | BasicSelectValue[]) { setConnFilter(String(v ?? "all")); setPage(1); }

  async function guard(fn: () => Promise<unknown>, ok?: string) {
    setErr(""); setMsg("");
    try {
      await fn();
      if (ok) Toast.success(ok);
      await refresh();
    } catch (e) {
      Toast.error((e as Error).message);
    }
  }

  async function viewLogs(id: string) {
    try {
      const r = await api.logs(id, 300);
      setLogView({ id, text: r.logs });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function openQr(id: string) {
    setQrTarget(id); setQrDataUrl(""); setQrConnected(false); setQrLoading(true);
    try {
      const q = await api.qrcode(id);
      if (q.connected) {
        setQrConnected(true);
      } else if (q.loginUrl) {
        setQrDataUrl(await QRCode.toDataURL(q.loginUrl, { margin: 1, width: 220 }));
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setQrLoading(false);
    }
  }

  function openRes(c: Container) {
    setResTarget(c);
    setResForm({ memLimit: c.memLimit, cpuLimit: c.cpuLimit, restartPolicy: c.restartPolicy });
  }

  async function confirmCreate() {
    const uid = newUserId.trim();
    const fe: string[] = [];
    if (!uid) fe.push("user_id 必填");
    else if (!USER_ID_RE.test(uid)) fe.push("user_id 格式: 字母/数字开头");
    else if (items.find((c) => c.userId === uid)) fe.push("用户已存在");
    if (newChannel === "wecom" && (!newBotId.trim() || !newSecret.trim())) {
      fe.push("企业微信需填 botId 和 secret");
    }
    if (fe.length) { setCreateErr(fe.join("; ")); return; }
    setCreateBusy(true); setCreateErr("");
    try {
      await api.createContainer({ userId: uid, channel: newChannel, botId: newBotId.trim(), secret: newSecret });
      setCreateOpen(false);
      Toast.success("创建成功");
      refresh();
    } catch (e) {
      setCreateErr((e as Error).message);
    } finally {
      setCreateBusy(false);
    }
  }

  function confirmReloadSkills() {
    setReloadOpen(false);
    void guard(() => api.reloadSkills(), "已触发 skill 重载");
  }

  function confirmUpgrade() {
    if (!upgradeTarget || !upgradeTag.trim()) return;
    const id = upgradeTarget.userId;
    const tag = upgradeTag.trim();
    setUpgradeTarget(null);
    void guard(() => api.upgrade(id, tag), "已升级");
  }

  function confirmDelete() {
    if (!delTarget) return;
    const id = delTarget;
    const deleteVolume = delVolume;
    setDelTarget(null);
    void guard(() => api.deleteContainer(id, deleteVolume), "已删除");
  }

  function confirmRes() {
    if (!resTarget) return;
    const id = resTarget.userId;
    const body = { ...resForm };
    setResTarget(null);
    void guard(() => api.setUserResources(id, body), "已保存资源覆盖（重建后生效）");
  }

  const columns = [
    { title: "用户", dataIndex: "userId", key: "userId", width: 100 },
    {
      title: "消息通道", dataIndex: "channel", key: "channel", width: 110,
      render: (_: unknown, r: Container) => (
        <Tag color={r.channelConnected ? "green" : "grey"}>
          {channelMeta(r.channel).icon} {channelMeta(r.channel).label}
        </Tag>
      ),
    },
    {
      title: "状态", dataIndex: "state", key: "state", width: 90,
      render: (_: unknown, r: Container) => {
        const t = STATUS_TAGS[r.state] || { label: r.state, color: "grey" };
        return <Tag color={t.color}>{t.label}</Tag>;
      },
    },
    { title: "镜像", dataIndex: "imageTag", key: "imageTag", width: 160, className: "mono" },
    { title: "CPU", dataIndex: "cpuPercent", key: "cpu", width: 65, render: (_: unknown, r: Container) => `${r.cpuPercent.toFixed(1)}%` },
    { title: "内存", dataIndex: "memMiB", key: "mem", width: 75, render: (_: unknown, r: Container) => `${r.memMiB} MiB` },
    { title: "最后活跃", dataIndex: "lastActiveAt", key: "ts", width: 140, render: (_: unknown, r: Container) => fmtActive(r.lastActiveAt) },
    { title: "回收倒计时", dataIndex: "reapInSeconds", key: "reap", width: 85, render: (_: unknown, r: Container) => fmtReap(r.reapInSeconds) },
    {
      title: "操作", key: "ops", width: 310,
      render: (_: unknown, r: Container) => (
        <Space>
          <Dropdown menu={ACTIONS.map((a) => ({ node: "item", name: a.label, onClick: () => guard(() => api.action(r.userId, a.key)) }))}>
            <Button size="small">操作</Button>
          </Dropdown>
          <Button size="small" onClick={() => viewLogs(r.userId)}>日志</Button>
          {r.channel === "wechat" && <Button size="small" onClick={() => openQr(r.userId)}>扫码</Button>}
          <Button size="small" onClick={() => openRes(r)}>资源</Button>
          <Button size="small" onClick={() => setUpgradeTarget(r)}>升级</Button>
          <Button size="small" type="danger" onClick={() => { setDelTarget(r.userId); setDelVolume(false); }}>删除</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {err && <div style={{ color: "var(--semi-color-danger)", marginBottom: 8 }}>{err}</div>}
      {msg && <div style={{ color: "var(--semi-color-success)", marginBottom: 8 }}>{msg}</div>}

      {/* Toolbar */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        <Space>
          <Button theme="solid" icon="+" onClick={() => { setCreateOpen(true); setNewUserId(""); setNewChannel("wecom"); setNewBotId(""); setNewSecret(""); setCreateErr(""); }}>创建容器</Button>
          <Button onClick={() => setReloadOpen(true)}>重载 Skill</Button>
        </Space>
        <Space>
          <Input placeholder="搜索 userId…" value={search} onChange={onSearch} style={{ width: 180 }} />
          <Select value={channelFilter} optionList={CHANNEL_OPTIONS} onChange={onChannelFilter} style={{ width: 130 }} />
          <Select value={connFilter} optionList={CONN_OPTIONS} onChange={onConnFilter} style={{ width: 110 }} />
          <Select value={statusFilter} optionList={STATUS_OPTIONS} onChange={onStatusFilter} style={{ width: 120 }} />
        </Space>
      </div>

      {/* Table */}
      <Table columns={columns as never} dataSource={paged} pagination={false} rowKey="userId" size="small" />

      <Pagination page={page} pageSize={pageSize} total={filtered.length} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />

      {/* Create Modal */}
      <Modal title="创建容器" visible={createOpen} onCancel={() => setCreateOpen(false)} onOk={confirmCreate} okText="创建" confirmLoading={createBusy} width={480}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {createErr && <p style={{ color: "var(--semi-color-danger)", fontSize: 13, margin: 0 }}>{createErr}</p>}
          <div>
            <label style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>用户 ID</label>
            <Input value={newUserId} onChange={setNewUserId} placeholder="alice" />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>消息通道</label>
            <Select value={newChannel} optionList={CHANNELS.map((c) => ({ value: c.value, label: c.icon + " " + c.label }))} onChange={(v) => setNewChannel(v as "wecom" | "wechat")} style={{ width: "100%" }} />
          </div>
          {newChannel === "wecom" ? (
            <>
              <div><label style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>Bot ID</label><Input value={newBotId} onChange={setNewBotId} placeholder="aib…" /></div>
              <div><label style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>Secret</label><Input type="password" value={newSecret} onChange={setNewSecret} placeholder="企业微信 secret" /></div>
            </>
          ) : (
            <p className="hint">微信无需填凭证：创建后在列表「扫码登录」扫码。</p>
          )}
        </div>
      </Modal>

      {/* Reload Modal */}
      <Modal title="重载 Skill" visible={reloadOpen} onCancel={() => setReloadOpen(false)} onOk={confirmReloadSkills} okText="确认重载">
        <p>将滚动重启所有运行中容器以重载 skill，确认？</p>
      </Modal>

      {/* Upgrade Modal */}
      <Modal title={`升级容器 ${upgradeTarget?.userId ?? ""}`} visible={upgradeTarget !== null} onCancel={() => setUpgradeTarget(null)} onOk={confirmUpgrade} okText="确认升级" okButtonProps={{ disabled: !upgradeTag.trim() }} width={420}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>镜像 tag（保留状态卷）</label>
          <Input autoFocus value={upgradeTag} onChange={setUpgradeTag} placeholder="muad-openclaw:local" />
        </div>
      </Modal>

      {/* Delete Modal */}
      <Modal title={`删除容器 ${delTarget ?? ""}`} visible={delTarget !== null} onCancel={() => setDelTarget(null)} onOk={confirmDelete} okText="确认删除" okButtonProps={{ type: "danger" as const }}>
        <p>确认删除容器 {delTarget}？此操作不可撤销。</p>
        <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 10 }}>
          <input type="checkbox" checked={delVolume} onChange={(e) => setDelVolume(e.target.checked)} />
          同时删除状态卷（记忆/会话将永久丢失）
        </label>
      </Modal>

      {/* Log Viewer */}
      {logView && (
        <Modal title={`${logView.id} 日志`} visible width={900} onCancel={() => setLogView(null)} footer={<><Button onClick={() => viewLogs(logView.id)}>刷新</Button><Button onClick={() => setLogView(null)}>关闭</Button></>}>
          <pre className="log-pre">{logView.text}</pre>
        </Modal>
      )}

      {/* QR Code */}
      {qrTarget && (
        <Modal title={`扫码登录 ${qrTarget}`} visible onCancel={() => setQrTarget(null)} footer={<><Button onClick={() => openQr(qrTarget)} loading={qrLoading}>刷新</Button><Button onClick={() => setQrTarget(null)}>关闭</Button></>}>
          <div style={{ textAlign: "center" }}>
            {qrLoading ? <p className="hint">正在检查登录状态…</p> : qrConnected ? <p style={{ color: "var(--semi-color-success)" }}>微信已登录，无需扫码。</p> : qrDataUrl ? <img className="qr-img" src={qrDataUrl} alt="微信登录二维码" /> : <p className="hint">未获取到二维码，请点刷新重试。</p>}
          </div>
        </Modal>
      )}

      {/* Resource Override Modal */}
      <Modal title={`资源覆盖 ${resTarget?.userId ?? ""}`} visible={resTarget !== null} onCancel={() => setResTarget(null)} onOk={confirmRes} okText="保存" width={420}>
        <p className="hint">留空 = 继承全局默认。保存后需重建生效。</p>
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          <div><label style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>内存上限（留空继承）</label><Input value={resForm.memLimit} onChange={(e) => setResForm({ ...resForm, memLimit: e })} placeholder="如 3g" /></div>
          <div><label style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>CPU 上限（留空继承）</label><Input value={resForm.cpuLimit} onChange={(e) => setResForm({ ...resForm, cpuLimit: e })} placeholder="如 2" /></div>
          <div><label style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>重启策略</label>
            <Select value={resForm.restartPolicy} optionList={[{ value: "", label: "继承全局" }, { value: "unless-stopped", label: "除手动停止外总重启" }, { value: "always", label: "总是重启" }, { value: "on-failure", label: "失败时重启" }, { value: "no", label: "不自动重启" }]} onChange={(v) => setResForm({ ...resForm, restartPolicy: v as string })} style={{ width: "100%" }} />
          </div>
        </div>
      </Modal>
    </div>
  );
}
