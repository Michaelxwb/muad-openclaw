import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Modal, Table, Tag, Select, Input, Space, Toast, Card } from "@douyinfe/semi-ui";
import { IconSearch } from "@douyinfe/semi-icons";
import type { BasicSelectValue } from "@douyinfe/semi-ui/lib/es/select";
import QRCode from "qrcode";
import { api, Container } from "../api";
import { CHANNELS } from "../channels";
import { ChannelForm } from "../components/ChannelForm";
import type { ChannelCredential } from "../api";
import { Pagination } from "../components/Pagination";
import { EditChannelModal } from "../components/EditChannelModal";
import { BatchToolbar } from "../components/BatchToolbar";
import { RowActions } from "../components/RowActions";
import { ChannelTags } from "../components/ChannelTags";

const STATUS_TAGS: Record<
  string,
  { label: string; color: "green" | "blue" | "red" | "orange" | "grey" | "light-blue"; dot: string }
> = {
  creating: { label: "创建中", color: "light-blue", dot: "#4db8ff" },
  running: { label: "运行中", color: "green", dot: "#3cdc80" },
  stopped: { label: "已停止", color: "grey", dot: "#8899aa" },
  archived: { label: "已归档", color: "grey", dot: "#8899aa" },
  unhealthy: { label: "不健康", color: "orange", dot: "#ffa940" },
  error: { label: "异常", color: "red", dot: "#ff4d4f" },
  missing: { label: "已删除", color: "grey", dot: "#8899aa" },
};

const STATUS_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "running", label: "运行中" },
  { value: "stopped", label: "已停止" },
  { value: "error", label: "异常" },
  { value: "unhealthy", label: "不健康" },
  { value: "missing", label: "已删除" },
];

const CHANNEL_OPTIONS = CHANNELS.map((c) => ({ value: c.value, label: c.icon + " " + c.label }));

const CONN_OPTIONS = [
  { value: "all", label: "全部连接" },
  { value: "online", label: "在线" },
  { value: "offline", label: "离线" },
];

const FILTER_SELECT_WIDTH = 120;

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
  const [channelFilter, setChannelFilter] = useState<string[]>([]);
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
  const [upgradeIds, setUpgradeIds] = useState<string[]>([]);
  const [upgradeTag, setUpgradeTag] = useState("");
  const [resTarget, setResTarget] = useState<Container | null>(null);
  const [resForm, setResForm] = useState({ memLimit: "", cpuLimit: "", restartPolicy: "" });

  // Create-modal form
  const [newUserId, setNewUserId] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState("");
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  function handleReloadSkills() {
    if (selectedIds.length === 0) return;
    void guard(
      () => api.reloadSkills(selectedIds),
      `已触发 ${selectedIds.length} 个容器 skill 重载`,
    );
  }

  function handleBatchUpgrade() {
    if (selectedIds.length === 0) return;
    setUpgradeIds(selectedIds);
    setUpgradeTag("");
  }

  function handleBatchDelete(_ids: string[]) {
    setSelectedIds([]);
    void refresh();
  }

  const refresh = useCallback(async () => {
    try {
      const res = await api.listContainers();
      setItems(res.items);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const res = await api.listContainers();
        if (mounted) setItems(res.items);
      } catch (e) {
        if (mounted) setErr((e as Error).message);
      }
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, [refresh]);

  const filtered = useMemo(() => {
    return items.filter((c) => {
      const matchSearch = !search || c.userId.toLowerCase().includes(search.toLowerCase());
      const matchStatus = statusFilter === "all" || c.state === statusFilter;
      const chs = c.channels?.length ? c.channels : [];
      const matchChannel = channelFilter.length === 0 || chs.some((c) => channelFilter.includes(c));
      const anyConnected = c.channelStatuses
        ? Object.values(c.channelStatuses).some((s) => s.connected)
        : false;
      const matchConn =
        connFilter === "all" || (connFilter === "online" ? anyConnected : !anyConnected);
      return matchSearch && matchStatus && matchChannel && matchConn;
    });
  }, [items, search, statusFilter, channelFilter, connFilter]);

  // Stats overview
  const stats = useMemo(() => {
    let running = 0,
      stopped = 0,
      error = 0;
    for (const c of items) {
      if (c.state === "running") running++;
      else if (c.state === "error" || c.state === "unhealthy") error++;
      else if (c.state === "stopped" || c.state === "missing" || c.state === "archived") stopped++;
    }
    return { total: items.length, running, stopped, error };
  }, [items]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize],
  );

  function onSearch(v: string) {
    setSearch(v);
    setPage(1);
  }
  function onStatusFilter(v: BasicSelectValue | undefined | BasicSelectValue[]) {
    setStatusFilter(String(v ?? "all"));
    setPage(1);
  }
  function onChannelFilter(v: BasicSelectValue | undefined | BasicSelectValue[]) {
    const arr = Array.isArray(v) ? v.map(String) : v !== undefined ? [String(v)] : [];
    setChannelFilter(arr);
    setPage(1);
  }
  function onConnFilter(v: BasicSelectValue | undefined | BasicSelectValue[]) {
    setConnFilter(String(v ?? "all"));
    setPage(1);
  }

  async function guard(fn: () => Promise<unknown>, ok?: string) {
    setErr("");
    setMsg("");
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

  async function openQr(id: string, force = false) {
    setQrTarget(id);
    setQrDataUrl("");
    setQrConnected(false);
    setQrLoading(true);
    setErr("");
    try {
      const q = await api.qrcode(id, force);
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

  async function handleCreate(channelForm: {
    channels: string[];
    channelConfigs: Record<string, ChannelCredential>;
  }) {
    const uid = newUserId.trim();
    const fe: string[] = [];
    if (!uid) fe.push("user_id 必填");
    else if (!USER_ID_RE.test(uid)) fe.push("user_id 格式: 字母/数字开头");
    else if (items.find((c) => c.userId === uid)) fe.push("用户已存在");
    if (fe.length) {
      setCreateErr(fe.join("; "));
      return;
    }
    setCreateBusy(true);
    setCreateErr("");
    try {
      await api.createContainer({
        userId: uid,
        channels: channelForm.channels,
        channelConfigs: channelForm.channelConfigs,
      });
      setCreateOpen(false);
      Toast.success("创建成功");
      refresh();
    } catch (e) {
      setCreateErr((e as Error).message);
    } finally {
      setCreateBusy(false);
    }
  }

  async function confirmUpgrade() {
    if (upgradeIds.length === 0 || !upgradeTag.trim()) return;
    const ids = [...upgradeIds];
    const tag = upgradeTag.trim();
    setUpgradeIds([]);
    const results = await Promise.allSettled(ids.map((id) => api.upgrade(id, tag)));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) {
      Toast.success(`已升级 ${ids.length} 个容器`);
    } else {
      Toast.warning(`升级完成：${ids.length - failed} 成功，${failed} 失败`);
    }
    await refresh();
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
      title: "消息通道",
      dataIndex: "channels",
      key: "channels",
      width: 180,
      render: (_: unknown, r: Container) => <ChannelTags container={r} />,
    },
    {
      title: "状态",
      dataIndex: "state",
      key: "state",
      width: 90,
      render: (_: unknown, r: Container) => {
        const t = STATUS_TAGS[r.state] || {
          label: r.state,
          color: "grey" as const,
          dot: "#8899aa",
        };
        return (
          <Tag color={t.color}>
            <span
              style={{
                display: "inline-block",
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: t.dot,
                marginRight: 5,
                verticalAlign: "middle",
              }}
            />
            {t.label}
          </Tag>
        );
      },
    },
    { title: "镜像", dataIndex: "imageTag", key: "imageTag", width: 160, className: "mono" },
    {
      title: "CPU",
      dataIndex: "cpuPercent",
      key: "cpu",
      width: 65,
      render: (_: unknown, r: Container) => `${r.cpuPercent.toFixed(1)}%`,
    },
    {
      title: "内存",
      dataIndex: "memMiB",
      key: "mem",
      width: 75,
      render: (_: unknown, r: Container) => `${r.memMiB} MiB`,
    },
    {
      title: "最后活跃",
      dataIndex: "lastActiveAt",
      key: "ts",
      width: 140,
      render: (_: unknown, r: Container) => fmtActive(r.lastActiveAt),
    },
    {
      title: "回收倒计时",
      dataIndex: "reapInSeconds",
      key: "reap",
      width: 85,
      render: (_: unknown, r: Container) => fmtReap(r.reapInSeconds),
    },
    {
      title: "操作",
      key: "ops",
      width: 280,
      render: (_: unknown, r: Container) => (
        <RowActions
          container={r}
          actions={ACTIONS}
          onViewLogs={viewLogs}
          onOpenQr={openQr}
          onEditChannels={setEditTarget}
          onOpenResources={openRes}
          onAction={(id, key) => guard(() => api.action(id, key))}
        />
      ),
    },
  ];

  const statCards = [
    { label: "总容器", value: stats.total, color: "var(--semi-color-text-1)" },
    { label: "运行中", value: stats.running, color: "var(--semi-color-success)" },
    { label: "异常", value: stats.error, color: "var(--semi-color-danger)" },
    { label: "已停止", value: stats.stopped, color: "var(--semi-color-text-2)" },
  ];

  return (
    <div>
      {err && <div style={{ color: "var(--semi-color-danger)", marginBottom: 8 }}>{err}</div>}
      {msg && <div style={{ color: "var(--semi-color-success)", marginBottom: 8 }}>{msg}</div>}

      {/* Stats overview */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        {statCards.map((s) => (
          <Card key={s.label} style={{ flex: 1, minWidth: 0 }} bodyStyle={{ padding: "14px 16px" }}>
            <div style={{ fontSize: 12, color: "var(--semi-color-text-2)", marginBottom: 4 }}>
              {s.label}
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontFamily: "monospace" }}>
              {s.value}
            </div>
          </Card>
        ))}
      </div>

      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 12,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <Space spacing={8}>
          <Button
            theme="solid"
            onClick={() => {
              setCreateOpen(true);
              setNewUserId("");
              setCreateErr("");
            }}
          >
            创建容器
          </Button>
          <span
            aria-hidden="true"
            style={{
              width: 1,
              height: 24,
              background: "var(--semi-color-border)",
              display: "inline-block",
            }}
          />
          <BatchToolbar
            selectedIds={selectedIds}
            onReloadSkills={handleReloadSkills}
            onBatchUpgrade={handleBatchUpgrade}
            onBatchDelete={handleBatchDelete}
          />
        </Space>
        <Space>
          <Input
            prefix={<IconSearch />}
            placeholder="搜索…"
            value={search}
            onChange={onSearch}
            onEnterPress={() => {}}
            style={{ width: 180 }}
          />
          <Select
            multiple
            value={channelFilter}
            optionList={CHANNEL_OPTIONS}
            onChange={onChannelFilter}
            placeholder="通道"
            style={{ width: FILTER_SELECT_WIDTH }}
          />
          <Select
            value={connFilter}
            optionList={CONN_OPTIONS}
            onChange={onConnFilter}
            style={{ width: FILTER_SELECT_WIDTH }}
          />
          <Select
            value={statusFilter}
            optionList={STATUS_OPTIONS}
            onChange={onStatusFilter}
            style={{ width: FILTER_SELECT_WIDTH }}
          />
        </Space>
      </div>

      {/* Table */}
      <Table
        columns={columns as never}
        dataSource={paged}
        pagination={false}
        rowKey="userId"
        size="small"
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys: (string | number)[] | undefined) =>
            setSelectedIds((keys ?? []).map(String)),
        }}
      />

      <Pagination
        page={page}
        pageSize={pageSize}
        total={filtered.length}
        onPageChange={setPage}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setPage(1);
        }}
      />

      {/* Create Modal */}
      <Modal
        title="创建容器"
        visible={createOpen}
        onCancel={() => setCreateOpen(false)}
        footer={null}
        width={520}
      >
        <div>
          {createErr && (
            <p style={{ color: "var(--semi-color-danger)", fontSize: 13, margin: "0 0 14px" }}>
              {createErr}
            </p>
          )}
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>用户 ID</label>
            <Input value={newUserId} onChange={setNewUserId} placeholder="alice" />
          </div>
          <ChannelForm
            mode="create"
            busy={createBusy}
            error={createErr}
            onSubmit={handleCreate}
            onCancel={() => setCreateOpen(false)}
          />
        </div>
      </Modal>

      {/* Upgrade Modal */}
      <Modal
        title={
          upgradeIds.length === 1
            ? `升级容器 ${upgradeIds[0]}`
            : `批量升级 ${upgradeIds.length} 个容器`
        }
        visible={upgradeIds.length > 0}
        onCancel={() => setUpgradeIds([])}
        onOk={confirmUpgrade}
        okText="确认升级"
        okButtonProps={{ disabled: !upgradeTag.trim() }}
        width={420}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>
            镜像 tag（保留状态卷）
          </label>
          <Input
            autoFocus
            value={upgradeTag}
            onChange={setUpgradeTag}
            placeholder="muad-openclaw:local"
          />
        </div>
      </Modal>

      {/* Delete Modal */}
      <Modal
        title={`删除容器 ${delTarget ?? ""}`}
        visible={delTarget !== null}
        onCancel={() => setDelTarget(null)}
        onOk={confirmDelete}
        okText="确认删除"
        okButtonProps={{ type: "danger" as const }}
      >
        <p>确认删除容器 {delTarget}？此操作不可撤销。</p>
        <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 10 }}>
          <input
            type="checkbox"
            checked={delVolume}
            onChange={(e) => setDelVolume(e.target.checked)}
          />
          同时删除状态卷（记忆/会话将永久丢失）
        </label>
      </Modal>

      {/* Log Viewer */}
      {logView && (
        <Modal
          className="log-modal"
          title={`${logView.id} 日志`}
          visible
          width="82vw"
          onCancel={() => setLogView(null)}
          footer={
            <>
              <Button onClick={() => viewLogs(logView.id)}>刷新</Button>
              <Button onClick={() => setLogView(null)}>关闭</Button>
            </>
          }
        >
          <pre className="log-pre">{logView.text}</pre>
        </Modal>
      )}

      {/* QR Code */}
      {qrTarget && (
        <Modal
          title={`扫码登录 ${qrTarget}`}
          visible
          onCancel={() => setQrTarget(null)}
          footer={
            <>
              <Button onClick={() => openQr(qrTarget)} loading={qrLoading}>
                刷新
              </Button>
              <Button onClick={() => openQr(qrTarget, true)} loading={qrLoading} type="primary">
                重新扫码
              </Button>
              <Button onClick={() => setQrTarget(null)}>关闭</Button>
            </>
          }
        >
          <div style={{ textAlign: "center" }}>
            {qrLoading ? (
              <p className="hint">正在检查登录状态…</p>
            ) : qrConnected ? (
              <div>
                <p style={{ color: "var(--semi-color-success)" }}>微信已登录，无需扫码。</p>
                <p className="hint">如需更换绑定，请点击「重新扫码」获取新的二维码。</p>
              </div>
            ) : qrDataUrl ? (
              <img className="qr-img" src={qrDataUrl} alt="微信登录二维码" />
            ) : (
              <p className="hint">未获取到二维码，请点刷新重试。</p>
            )}
          </div>
        </Modal>
      )}

      {/* Edit Channel Modal */}
      <EditChannelModal
        userId={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          refresh();
        }}
      />

      {/* Resource Override Modal */}
      <Modal
        title={`资源覆盖 ${resTarget?.userId ?? ""}`}
        visible={resTarget !== null}
        onCancel={() => setResTarget(null)}
        onOk={confirmRes}
        okText="保存"
        width={420}
      >
        <p className="hint">留空 = 继承全局默认。保存后需重建生效。</p>
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>
              内存上限（留空继承）
            </label>
            <Input
              value={resForm.memLimit}
              onChange={(e) => setResForm({ ...resForm, memLimit: e })}
              placeholder="如 3g"
            />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>
              CPU 上限（留空继承）
            </label>
            <Input
              value={resForm.cpuLimit}
              onChange={(e) => setResForm({ ...resForm, cpuLimit: e })}
              placeholder="如 2"
            />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>重启策略</label>
            <Select
              value={resForm.restartPolicy}
              optionList={[
                { value: "", label: "继承全局" },
                { value: "unless-stopped", label: "除手动停止外总重启" },
                { value: "always", label: "总是重启" },
                { value: "on-failure", label: "失败时重启" },
                { value: "no", label: "不自动重启" },
              ]}
              onChange={(v) => setResForm({ ...resForm, restartPolicy: v as string })}
              style={{ width: "100%" }}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
