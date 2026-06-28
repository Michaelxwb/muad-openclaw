import { useCallback, useEffect, useMemo, useState } from "react";
import { api, Container } from "../api";
import { ActionDropdown } from "../components/ActionDropdown";
import { CreateModal } from "../components/CreateModal";
import { Modal } from "../components/Modal";
import QRCode from "qrcode";
import { Pagination } from "../components/Pagination";
import { Select } from "../components/Select";
import { CHANNELS, channelMeta } from "../channels";
import styles from "./Containers.module.css";

const ACTIONS = [
  { key: "start", label: "启动" },
  { key: "stop", label: "停止" },
  { key: "restart", label: "重启" },
  { key: "reap", label: "回收" },
  { key: "revive", label: "唤醒" },
];

const STATUS_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "running", label: "运行中" },
  { value: "stopped", label: "已停止" },
  { value: "error", label: "异常" },
  { value: "unhealthy", label: "不健康" },
  { value: "missing", label: "已删除" },
];

const CHANNEL_FILTER_OPTIONS = [
  { value: "all", label: "全部通道" },
  ...CHANNELS.map((c) => ({ value: c.value, label: `${c.icon} ${c.label}` })),
];

const CONN_FILTER_OPTIONS = [
  { value: "all", label: "全部连接" },
  { value: "online", label: "🟢 在线" },
  { value: "offline", label: "⚪ 离线" },
];

// 容器状态中文展示（badge 颜色仍按原始 state 类名）。
const STATE_LABELS: Record<string, string> = {
  creating: "创建中",
  running: "运行中",
  stopped: "已停止",
  archived: "已归档",
  unhealthy: "不健康",
  error: "异常",
  missing: "已删除",
};

function stateLabel(s: string): string {
  return STATE_LABELS[s] ?? s;
}

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
  const [modalOpen, setModalOpen] = useState(false);
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

  const refresh = useCallback(async () => {
    try {
      const res = await api.listContainers(0, 1000);
      // Support both old (array) and new ({items, total}) response formats.
      setItems(Array.isArray(res as unknown) ? (res as unknown as Container[]) : res.items);
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
      const matchConn =
        connFilter === "all" ||
        (connFilter === "online" ? c.channelConnected : !c.channelConnected);
      return matchSearch && matchStatus && matchChannel && matchConn;
    });
  }, [items, search, statusFilter, channelFilter, connFilter]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize],
  );

  function onSearch(v: string) {
    setSearch(v);
    setPage(1);
  }

  function onStatusFilter(v: string) {
    setStatusFilter(v);
    setPage(1);
  }

  function onChannelFilter(v: string) {
    setChannelFilter(v);
    setPage(1);
  }

  function onConnFilter(v: string) {
    setConnFilter(v);
    setPage(1);
  }

  async function guard(fn: () => Promise<unknown>, ok?: string) {
    setErr("");
    setMsg("");
    try {
      await fn();
      if (ok) setMsg(ok);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  function del(id: string) {
    setDelTarget(id);
    setDelVolume(false);
  }

  function confirmDelete() {
    if (!delTarget) return;
    const id = delTarget;
    const deleteVolume = delVolume;
    setDelTarget(null);
    void guard(() => api.deleteContainer(id, deleteVolume), "已删除");
  }

  function upgrade(c: Container) {
    setUpgradeTarget(c);
    setUpgradeTag(c.imageTag);
  }

  function confirmUpgrade() {
    if (!upgradeTarget || !upgradeTag.trim()) return;
    const id = upgradeTarget.userId;
    const tag = upgradeTag.trim();
    setUpgradeTarget(null);
    void guard(() => api.upgrade(id, tag), "已升级");
  }

  async function viewLogs(id: string) {
    setErr("");
    try {
      const r = await api.logs(id, 300);
      setLogView({ id, text: r.logs });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  // 微信扫码：手动触发。未登录才触发登录并展示二维码；已登录提示无需扫码。
  async function openQr(id: string) {
    setQrTarget(id);
    setQrDataUrl("");
    setQrConnected(false);
    setQrLoading(true);
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

  function confirmReloadSkills() {
    setReloadOpen(false);
    void guard(() => api.reloadSkills(), "已触发 skill 重载");
  }

  return (
    <div className={styles.page}>
      {err && <div className="error">{err}</div>}
      {msg && <div className={styles.msg}>{msg}</div>}

      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.actions}>
          <button className={styles.createBtn} onClick={() => setModalOpen(true)}>
            + 创建容器
          </button>
          <button className={styles.createBtn} onClick={() => setReloadOpen(true)}>
            重载 Skill
          </button>
        </div>
        <div className={styles.filters}>
          <input
            placeholder="搜索 userId…"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
          <Select
            value={channelFilter}
            options={CHANNEL_FILTER_OPTIONS}
            onChange={onChannelFilter}
            minWidth={120}
          />
          <Select
            value={connFilter}
            options={CONN_FILTER_OPTIONS}
            onChange={onConnFilter}
            minWidth={110}
          />
          <Select
            value={statusFilter}
            options={STATUS_OPTIONS}
            onChange={onStatusFilter}
            minWidth={120}
          />
        </div>
      </div>

      {/* Table */}
      <table className={styles.grid}>
        <thead>
          <tr>
            <th>用户</th>
            <th>消息通道</th>
            <th>状态</th>
            <th>镜像</th>
            <th>CPU</th>
            <th>内存</th>
            <th>最后活跃</th>
            <th>回收倒计时</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {paged.map((c) => (
            <tr key={c.userId}>
              <td>{c.userId}</td>
              <td>
                <span
                  className={`${styles.channel} ${
                    c.channelConnected ? styles.channelOn : styles.channelOff
                  }`}
                  title={`${channelMeta(c.channel).label} · ${
                    c.channelConnected ? "在线" : "离线"
                  }`}
                >
                  <span className={styles.channelIcon}>{channelMeta(c.channel).icon}</span>
                  {channelMeta(c.channel).label}
                </span>
              </td>
              <td>
                <span className={`badge ${c.state}`}>{stateLabel(c.state)}</span>
              </td>
              <td className="mono">{c.imageTag}</td>
              <td>{c.cpuPercent.toFixed(1)}%</td>
              <td>{c.memMiB} MiB</td>
              <td>{fmtActive(c.lastActiveAt)}</td>
              <td>{fmtReap(c.reapInSeconds)}</td>
              <td className={styles.ops}>
                <ActionDropdown
                  items={ACTIONS}
                  onSelect={(key) => guard(() => api.action(c.userId, key))}
                />
                <button onClick={() => viewLogs(c.userId)}>日志</button>
                {c.channel === "wechat" && <button onClick={() => openQr(c.userId)}>扫码</button>}
                <button onClick={() => upgrade(c)}>升级</button>
                <button className="danger" onClick={() => del(c.userId)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
          {paged.length === 0 && (
            <tr>
              <td colSpan={9} className={styles.empty}>
                {filtered.length === 0 && items.length === 0 ? (
                  <>
                    暂无容器，
                    <button className={styles.createBtn} onClick={() => setModalOpen(true)}>
                      点击创建容器
                    </button>
                    开始
                  </>
                ) : filtered.length === 0 ? (
                  <>
                    无匹配容器，
                    <button
                      onClick={() => {
                        setSearch("");
                        setStatusFilter("all");
                        setChannelFilter("all");
                        setConnFilter("all");
                      }}
                    >
                      清除过滤
                    </button>
                  </>
                ) : null}
              </td>
            </tr>
          )}
        </tbody>
      </table>

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
      <CreateModal
        open={modalOpen}
        existingIds={items.map((c) => c.userId)}
        onClose={() => setModalOpen(false)}
        onCreated={() => {
          setModalOpen(false);
          setMsg("创建成功");
          refresh();
        }}
      />

      {/* Reload Skill Modal */}
      <Modal
        open={reloadOpen}
        title="重载 Skill"
        onClose={() => setReloadOpen(false)}
        footer={
          <>
            <button onClick={() => setReloadOpen(false)}>取消</button>
            <button className={styles.createBtn} onClick={confirmReloadSkills}>
              确认重载
            </button>
          </>
        }
      >
        <p className={styles.modalText}>将滚动重启所有运行中容器以重载 skill，确认？</p>
      </Modal>

      {/* Upgrade Modal */}
      <Modal
        open={upgradeTarget !== null}
        title={`升级容器 ${upgradeTarget?.userId ?? ""}`}
        onClose={() => setUpgradeTarget(null)}
        footer={
          <>
            <button onClick={() => setUpgradeTarget(null)}>取消</button>
            <button
              className={styles.createBtn}
              onClick={confirmUpgrade}
              disabled={!upgradeTag.trim()}
            >
              确认升级
            </button>
          </>
        }
      >
        <div className={styles.modalField}>
          <label>升级到镜像 tag（保留状态卷）</label>
          <input
            autoFocus
            value={upgradeTag}
            onChange={(e) => setUpgradeTag(e.target.value)}
            placeholder="muad-openclaw:local"
          />
        </div>
      </Modal>

      {/* Delete Modal */}
      <Modal
        open={delTarget !== null}
        title={`删除容器 ${delTarget ?? ""}`}
        onClose={() => setDelTarget(null)}
        footer={
          <>
            <button onClick={() => setDelTarget(null)}>取消</button>
            <button className="danger" onClick={confirmDelete}>
              确认删除
            </button>
          </>
        }
      >
        <p className={styles.modalText}>确认删除容器 {delTarget}？此操作不可撤销。</p>
        <label className={styles.modalCheck}>
          <input
            type="checkbox"
            checked={delVolume}
            onChange={(e) => setDelVolume(e.target.checked)}
          />
          同时删除状态卷（记忆/会话将永久丢失，不可恢复）
        </label>
      </Modal>

      {/* Log Viewer — only the log content scrolls (Modal header/footer fixed). */}
      {logView && (
        <Modal
          open
          wide
          title={`${logView.id} 日志`}
          onClose={() => setLogView(null)}
          footer={
            <>
              <button onClick={() => viewLogs(logView.id)}>刷新</button>
              <button onClick={() => setLogView(null)}>关闭</button>
            </>
          }
        >
          <pre className={styles.logPre}>{logView.text}</pre>
        </Modal>
      )}

      {/* WeChat QR — manual trigger; same Modal shell as the log viewer. */}
      {qrTarget && (
        <Modal
          open
          title={`扫码登录 ${qrTarget}`}
          onClose={() => setQrTarget(null)}
          footer={
            <>
              <button onClick={() => openQr(qrTarget)} disabled={qrLoading}>
                {qrLoading ? "刷新中…" : "刷新"}
              </button>
              <button onClick={() => setQrTarget(null)}>关闭</button>
            </>
          }
        >
          <div className={styles.qrBox}>
            {qrLoading ? (
              <p className="hint">正在检查登录状态、生成二维码…（约数秒）</p>
            ) : qrConnected ? (
              <p className="ok">微信已登录，无需扫码。</p>
            ) : qrDataUrl ? (
              <>
                <img className={styles.qr} src={qrDataUrl} alt="微信登录二维码" />
                <p className="hint">用微信扫码登录；二维码会过期，过期点「刷新」。</p>
              </>
            ) : (
              <p className="hint">未获取到二维码，请点「刷新」重试。</p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
