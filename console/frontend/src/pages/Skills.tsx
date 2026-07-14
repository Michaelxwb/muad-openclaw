import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Banner,
  Button,
  Input,
  Modal,
  Select,
  SideSheet,
  Space,
  Table,
  Tag,
  Toast,
} from "@douyinfe/semi-ui";
import { IconPlus, IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import { api } from "../api";
import type { PublicSkillStorageStatus, SkillAsset, SkillScope, SkillStatus } from "../api";
import {
  DEFAULT_PAGE_SIZE,
  renderTablePagination,
  tablePagination,
} from "../components/Pagination";
import { FeedbackBanner, ListToolbar, PageHeader, PageSection } from "../components/ConsolePage";
import { useMountedRef } from "../hooks/useMountedRef";
import { PublicSkillUploadDialog } from "./skills/PublicSkillUploadDialog";
import styles from "./Skills.module.css";

type ScopeFilter = SkillScope | "";
type StatusFilter = Extract<SkillStatus, "active" | "disabled"> | "";

interface DetailFieldRow {
  label: string;
  value: ReactNode;
  wide?: boolean;
  mono?: boolean;
}

interface SkillStatusAction {
  skill: SkillAsset;
  status: SkillStatus;
  label: string;
  danger?: boolean;
}

const SCOPE_OPTIONS = [
  { value: "", label: "全部范围" },
  { value: "system", label: "System" },
  { value: "public", label: "Public" },
  { value: "private", label: "Private" },
];

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "active", label: "启用" },
  { value: "disabled", label: "禁用" },
];

const SKILL_DETAIL_SHEET_WIDTH = 720;

export function Skills() {
  const state = useSkillAssets();
  const storage = usePublicSkillStorage();
  const [selected, setSelected] = useState<SkillAsset | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<SkillStatusAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const mountedRef = useMountedRef();
  const refreshAfterUpload = async () => {
    state.setPage(1);
    await state.refresh();
    await storage.refresh();
  };
  const applyStatusAction = async () => {
    if (!pendingAction) return;
    setActionBusy(true);
    try {
      await api.updateSkill(pendingAction.skill.skillId, { status: pendingAction.status });
      if (!mountedRef.current) return;
      Toast.warning(
        `${pendingAction.skill.name} 已${pendingAction.label}，需要点击「应用 Skill」后才会对所有 Pod 生效。`,
      );
      setPendingAction(null);
      await state.refresh();
    } catch (caught) {
      if (mountedRef.current)
        Toast.error(caught instanceof Error ? caught.message : "更新 Skill 状态失败");
    } finally {
      if (mountedRef.current) setActionBusy(false);
    }
  };
  const applyAllSkills = () => {
    Modal.confirm({
      title: "应用 Skill 到所有 Pod",
      content: "将同步 Public Skill，并对所有运行中的 Pod 应用最新 Skill 配置。",
      okText: "应用 Skill",
      onOk: async () => {
        setApplying(true);
        try {
          const result = await api.applySkills();
          if (!mountedRef.current) return;
          Toast.success(skillApplyMessage(result.results));
          await state.refresh();
        } catch (caught) {
          if (mountedRef.current)
            Toast.error(caught instanceof Error ? caught.message : "应用 Skill 失败");
        } finally {
          if (mountedRef.current) setApplying(false);
        }
      },
    });
  };
  return (
    <div>
      <PageHeader title="Skill 管理" description="查看系统、公共和用户私有 Skill 的资产状态" />
      <FeedbackBanner error={state.error} message={state.message} />
      <FeedbackBanner error={storage.error} message={storage.message} />
      <PageSection>
        <SkillToolbar
          state={state}
          storage={storage}
          applying={applying}
          onApply={applyAllSkills}
          onUpload={() => setUploadOpen(true)}
        />
        <SkillApplyNotice />
        <PublicStorageNotice storage={storage} />
        <SkillTable state={state} onOpen={setSelected} onStatusAction={setPendingAction} />
      </PageSection>
      <SkillDetailDrawer skill={selected} onClose={() => setSelected(null)} />
      <SkillStatusActionDialog
        action={pendingAction}
        busy={actionBusy}
        onClose={() => setPendingAction(null)}
        onConfirm={applyStatusAction}
      />
      <PublicSkillUploadDialog
        visible={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={refreshAfterUpload}
      />
    </div>
  );
}

function SkillApplyNotice() {
  return (
    <Banner
      className={styles.storageNotice}
      type="warning"
      description="启用、禁用或删除 Skill 后，需要点击「应用 Skill」才会同步 Public Skill，并对所有运行中的 Pod 生效。"
      fullMode={false}
      bordered
      closeIcon={null}
    />
  );
}

function skillApplyMessage(results: Record<string, string>) {
  const entries = Object.values(results);
  const queued = entries.filter((status) => status === "queued").length;
  const skipped = entries.filter((status) => status === "skipped_not_running").length;
  const failed = entries.filter((status) => status === "failed_sync").length;
  if (failed > 0) {
    return `Skill 应用已提交：${queued} 个 Pod 排队，${failed} 个同步失败，${skipped} 个未运行跳过。`;
  }
  return `Skill 应用已提交：${queued} 个 Pod 排队，${skipped} 个未运行跳过。`;
}

function usePublicSkillStorage() {
  const [status, setStatus] = useState<PublicSkillStorageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mountedRef = useMountedRef();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api.getPublicSkillStorage();
      if (!mountedRef.current) return;
      setStatus(result);
    } catch (caught) {
      if (mountedRef.current)
        setError(caught instanceof Error ? caught.message : "加载 PVC 状态失败");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [mountedRef]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    setCreating(true);
    setError("");
    setMessage("");
    try {
      const result = await api.ensurePublicSkillStorage();
      if (!mountedRef.current) return;
      setStatus(result);
      setMessage(result.ready ? "Public Skill PVC 已就绪" : "Public Skill PVC 已创建，等待绑定");
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : "创建 PVC 失败");
    } finally {
      if (mountedRef.current) setCreating(false);
    }
  };

  return { status, loading, creating, error, message, refresh, create };
}

function useSkillAssets() {
  const [items, setItems] = useState<SkillAsset[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const result = await api.listSkills({
        page,
        pageSize,
        q: query,
        scope: scope || undefined,
        status: status || undefined,
      });
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setItems(result.items);
      setTotal(result.total);
    } catch (caught) {
      if (mountedRef.current && requestId === requestRef.current) {
        setError(caught instanceof Error ? caught.message : "加载 Skill 失败");
      }
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [mountedRef, page, pageSize, query, scope, status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const scan = async () => {
    setScanning(true);
    setError("");
    setMessage("");
    try {
      const result = await api.scanSkills();
      if (!mountedRef.current) return;
      setMessage(`扫描完成：${result.scanned} 个 Skill`);
      await refresh();
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : "扫描失败");
    } finally {
      if (mountedRef.current) setScanning(false);
    }
  };

  return {
    items,
    page,
    pageSize,
    total,
    query,
    scope,
    status,
    loading,
    scanning,
    error,
    message,
    setPage,
    setPageSize,
    setQuery,
    setScope,
    setStatus,
    scan,
    refresh,
  };
}

type SkillAssetsState = ReturnType<typeof useSkillAssets>;
type PublicSkillStorageState = ReturnType<typeof usePublicSkillStorage>;

function SkillToolbar({
  state,
  storage,
  applying,
  onApply,
  onUpload,
}: {
  state: SkillAssetsState;
  storage: PublicSkillStorageState;
  applying: boolean;
  onApply: () => void;
  onUpload: () => void;
}) {
  const [search, setSearch] = useState("");
  const submit = () => {
    state.setPage(1);
    state.setQuery(search.trim());
  };
  return (
    <ListToolbar
      actions={
        <Space>
          <Button
            aria-label="上传 Public Skill"
            icon={<IconPlus />}
            disabled={!storage.status?.ready}
            onClick={onUpload}
          >
            上传 Public Skill
          </Button>
          <Button loading={applying} onClick={onApply}>
            应用 Skill
          </Button>
          <PublicStorageAction storage={storage} />
          <Button
            aria-label="扫描 Skill"
            icon={<IconRefresh />}
            loading={state.scanning}
            disabled={state.loading}
            onClick={() => void state.scan()}
          >
            扫描 Skill
          </Button>
        </Space>
      }
      filters={
        <Space>
          <Input
            prefix={<IconSearch />}
            value={search}
            onChange={setSearch}
            onEnterPress={submit}
            placeholder="名称、ID 或路径"
            style={{ width: 240 }}
          />
          <Button aria-label="查询 Skill" icon={<IconSearch />} onClick={submit} />
          <Select
            value={state.scope}
            optionList={SCOPE_OPTIONS}
            onChange={(value) => {
              state.setPage(1);
              state.setScope(String(value ?? "") as ScopeFilter);
            }}
            style={{ width: 120 }}
          />
          <Select
            value={state.status}
            optionList={STATUS_OPTIONS}
            onChange={(value) => {
              state.setPage(1);
              state.setStatus(String(value ?? "") as StatusFilter);
            }}
            style={{ width: 120 }}
          />
        </Space>
      }
    />
  );
}

function PublicStorageAction({ storage }: { storage: PublicSkillStorageState }) {
  const status = storage.status;
  if (!status || status.ready || !status.configured) return null;
  return (
    <Button
      aria-label="创建 Public Skill PVC"
      icon={<IconPlus />}
      loading={storage.creating}
      onClick={() => void storage.create()}
    >
      创建 PVC
    </Button>
  );
}

function PublicStorageNotice({ storage }: { storage: PublicSkillStorageState }) {
  const status = storage.status;
  if (storage.loading && !status) {
    return (
      <Banner
        className={styles.storageNotice}
        type="info"
        description="正在检查 Public Skill 存储状态"
        fullMode={false}
        bordered
        closeIcon={null}
      />
    );
  }
  if (!status || status.ready) return null;
  const description = publicStorageDescription(status);
  return (
    <Banner
      className={styles.storageNotice}
      type={status.configured ? "warning" : "danger"}
      description={description}
      fullMode={false}
      bordered
      closeIcon={null}
    />
  );
}

function publicStorageDescription(status: PublicSkillStorageStatus) {
  if (!status.configured) {
    return "当前后端是 K8s 模式，但未配置 k8sSkillsPVC。请在后端配置 Public Skill PVC 名称并重启 Console。";
  }
  return `${status.message || "Public Skill PVC 未就绪"}。上传 Public Skill 前需要先创建并等待 PVC 绑定。`;
}

function SkillTable({
  state,
  onOpen,
  onStatusAction,
}: {
  state: SkillAssetsState;
  onOpen: (skill: SkillAsset) => void;
  onStatusAction: (action: SkillStatusAction) => void;
}) {
  return (
    <Table
      columns={skillColumns(onOpen, onStatusAction) as never}
      dataSource={state.items}
      rowKey="skillId"
      loading={state.loading}
      pagination={tablePagination({
        page: state.page,
        pageSize: state.pageSize,
        total: state.total,
        onPageChange: state.setPage,
        onPageSizeChange: (pageSize) => {
          state.setPageSize(pageSize);
          state.setPage(1);
        },
      })}
      renderPagination={renderTablePagination}
      empty="暂无 Skill"
      size="small"
    />
  );
}

function skillColumns(
  onOpen: (skill: SkillAsset) => void,
  onStatusAction: (action: SkillStatusAction) => void,
) {
  return [
    {
      title: "Skill",
      key: "name",
      width: 240,
      render: (_: unknown, skill: SkillAsset) => (
        <div>
          <div className={styles.skillName}>{skill.displayName || skill.name}</div>
          <div className="mono">{skill.name}</div>
        </div>
      ),
    },
    {
      title: "范围",
      dataIndex: "scope",
      width: 90,
      render: (_: unknown, skill: SkillAsset) => <ScopeTag scope={skill.scope} />,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 90,
      render: (_: unknown, skill: SkillAsset) => <StatusTag status={skill.status} />,
    },
    {
      title: "版本",
      dataIndex: "version",
      width: 120,
      render: (_: unknown, skill: SkillAsset) => skill.version || "-",
    },
    {
      title: "平台",
      key: "platforms",
      width: 180,
      render: (_: unknown, skill: SkillAsset) => (
        <PlatformTags platformsJson={skill.platformsJson} />
      ),
    },
    {
      title: "能力",
      key: "features",
      width: 160,
      render: (_: unknown, skill: SkillAsset) => (
        <Space spacing={4}>
          {skill.progressSupported && <Tag>进度</Tag>}
          {skill.browserRequired && <Tag>浏览器</Tag>}
          {!skill.progressSupported && !skill.browserRequired && (
            <span className={styles.subtle}>-</span>
          )}
        </Space>
      ),
    },
    {
      title: "归属",
      key: "owner",
      width: 210,
      render: (_: unknown, skill: SkillAsset) => <SkillOwner skill={skill} />,
    },
    {
      title: "操作",
      key: "actions",
      width: 190,
      render: (_: unknown, skill: SkillAsset) => (
        <SkillRowActions skill={skill} onOpen={onOpen} onStatusAction={onStatusAction} />
      ),
    },
  ];
}

function SkillOwner({ skill }: { skill: SkillAsset }) {
  if (skill.scope === "system") return <span>系统内置</span>;
  if (skill.scope === "public") return <span>Public Skill 资产库</span>;
  return (
    <div>
      <div>Private Skill</div>
      <div className="mono">{skill.humanUserId || skill.podId || "-"}</div>
    </div>
  );
}

function SkillRowActions({
  skill,
  onOpen,
  onStatusAction,
}: {
  skill: SkillAsset;
  onOpen: (skill: SkillAsset) => void;
  onStatusAction: (action: SkillStatusAction) => void;
}) {
  const actions = skillStatusActions(skill);
  return (
    <Space spacing={4}>
      <Button size="small" onClick={() => onOpen(skill)}>
        详情
      </Button>
      {actions.map((action) => (
        <Button
          key={`${skill.skillId}-${action.status}`}
          size="small"
          type={action.danger ? "danger" : "primary"}
          theme={action.danger ? "borderless" : "light"}
          onClick={() => onStatusAction(action)}
        >
          {action.label}
        </Button>
      ))}
    </Space>
  );
}

function skillStatusActions(skill: SkillAsset): SkillStatusAction[] {
  if (skill.systemProtected) return [];
  const actions: SkillStatusAction[] = [];
  if (skill.status === "active") {
    actions.push({ skill, status: "disabled", label: "禁用" });
  }
  if (skill.status === "disabled") {
    actions.push({ skill, status: "active", label: "启用" });
  }
  if (skill.status !== "deleted" && skill.scope === "public") {
    actions.push({ skill, status: "deleted", label: "删除", danger: true });
  }
  return actions;
}

function SkillStatusActionDialog({
  action,
  busy,
  onClose,
  onConfirm,
}: {
  action: SkillStatusAction | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      className="standard-modal"
      title={action ? `${action.label} ${action.skill.name}` : "更新 Skill 状态"}
      visible={Boolean(action)}
      onCancel={onClose}
      onOk={onConfirm}
      okText={`确认${action?.label ?? ""}`}
      confirmLoading={busy}
      okButtonProps={{ type: action?.danger ? ("danger" as const) : ("primary" as const) }}
    >
      {action && (
        <div className={styles.statusActionBody}>
          <div>
            将 Skill <span className="mono">{action.skill.name}</span> 状态更新为{" "}
            <StatusTag status={action.status} />。
          </div>
          <div className={styles.subtle}>
            该操作会更新控制面配置；需要在 Skill 管理页点击「应用 Skill」后才会对所有 Pod 生效。
          </div>
          {action.status === "deleted" && (
            <div className={styles.subtle}>
              删除会移除 Console 管理的 Public Skill 目录；应用 Skill 后会从所有 Pod 的公共 Skill
              目录移除。
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function ScopeTag({ scope }: { scope: SkillScope }) {
  const color = scope === "system" ? "red" : scope === "private" ? "violet" : "blue";
  return <Tag color={color}>{scope}</Tag>;
}

function StatusTag({ status }: { status: SkillStatus }) {
  const color = status === "active" ? "green" : status === "disabled" ? "grey" : "orange";
  const label = status === "active" ? "启用" : status === "disabled" ? "禁用" : "已删除";
  return <Tag color={color}>{label}</Tag>;
}

function PlatformTags({ platformsJson }: { platformsJson: string }) {
  const platforms = parsePlatforms(platformsJson);
  if (platforms.length === 0) return <span className={styles.subtle}>-</span>;
  return (
    <div className={styles.platforms}>
      {platforms.map((platform) => (
        <Tag key={platform}>{platform}</Tag>
      ))}
    </div>
  );
}

function SkillDetailDrawer({ skill, onClose }: { skill: SkillAsset | null; onClose: () => void }) {
  const detailRows: DetailFieldRow[] = skill
    ? [
        { label: "Skill ID", value: skill.skillId, wide: true, mono: true },
        { label: "范围", value: <ScopeTag scope={skill.scope} /> },
        { label: "状态", value: <StatusTag status={skill.status} /> },
        { label: "版本", value: skill.version || "-" },
        { label: "入口类型", value: skill.entryType || "-" },
        { label: "Manifest", value: skill.manifestHash || "-", wide: true, mono: true },
        { label: "Human User", value: skill.humanUserId || "-", mono: Boolean(skill.humanUserId) },
        { label: "Pod", value: skill.podId || "-", mono: Boolean(skill.podId) },
        { label: "来源路径", value: skill.sourcePath || "-", wide: true, mono: true },
      ]
    : [];
  return (
    <SideSheet
      title={skill ? `Skill 详情 ${skill.name}` : "Skill 详情"}
      visible={Boolean(skill)}
      onCancel={onClose}
      width={SKILL_DETAIL_SHEET_WIDTH}
    >
      {skill && (
        <div className={styles.details}>
          <div className={styles.detailGrid}>
            {detailRows.map((row) => (
              <DetailField key={row.label} label={row.label} wide={row.wide} mono={row.mono}>
                {row.value}
              </DetailField>
            ))}
          </div>
          <div>
            <div className={styles.subtle}>平台</div>
            <PlatformTags platformsJson={skill.platformsJson} />
          </div>
          <div>
            <div className={styles.subtle}>Manifest JSON</div>
            <pre className={styles.manifest}>{prettyManifest(skill.manifestJson)}</pre>
          </div>
        </div>
      )}
    </SideSheet>
  );
}

function DetailField({
  label,
  children,
  wide = false,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
  mono?: boolean;
}) {
  const valueClass = [styles.detailValue, mono ? styles.monoValue : ""].filter(Boolean).join(" ");
  return (
    <div className={wide ? styles.detailItemWide : styles.detailItem}>
      <div className={styles.detailLabel}>{label}</div>
      <div className={valueClass}>{children}</div>
    </div>
  );
}

function parsePlatforms(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item !== "");
  } catch (caught) {
    console.warn("skill_platforms_parse_failed", caught);
    return [];
  }
}

function prettyManifest(raw: string): string {
  if (!raw) return "{}";
  try {
    return JSON.stringify(JSON.parse(raw) as unknown, null, 2);
  } catch (caught) {
    console.warn("skill_manifest_parse_failed", caught);
    return raw;
  }
}
