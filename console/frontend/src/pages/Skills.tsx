import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, ReactNode } from "react";
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
  Tooltip,
} from "@douyinfe/semi-ui";
import { IconHelpCircleStroked, IconPlus, IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../api";
import i18n from "../i18n";
import { errorMessage } from "../utils/error";
import type {
  PublicSkillStorageStatus,
  SkillAsset,
  SkillReloadResult,
  SkillScope,
  SkillStatus,
} from "../api";
import {
  DEFAULT_PAGE_SIZE,
  renderTablePagination,
  tablePagination,
} from "../components/Pagination";
import { requestAlertsRefresh } from "../components/NotificationBell";
import { FeedbackBanner, ListToolbar, PageHeader, PageSection } from "../components/ConsolePage";
import { useMountedRef } from "../hooks/useMountedRef";
import { PublicSkillUploadDialog } from "./skills/PublicSkillUploadDialog";
import styles from "./Skills.module.css";

type ScopeFilter = SkillScope | "";
type StatusFilter = Extract<SkillStatus, "active" | "disabled" | "pending"> | "";
type SkillActionKind = "status" | "approve" | "reject";

interface DetailFieldRow {
  label: string;
  value: ReactNode;
  wide?: boolean;
  mono?: boolean;
}

interface SkillStatusAction {
  skill: SkillAsset;
  kind: SkillActionKind;
  status: SkillStatus;
  label: string;
  danger?: boolean;
}

const SKILL_DETAIL_SHEET_WIDTH = 720;
const POST_APPLY_REFRESH_DELAYS_MS = [1000, 3000, 7000, 15000];

interface RefreshOptions {
  background?: boolean;
}

export function Skills() {
  const { t } = useTranslation();
  const state = useSkillAssets();
  const storage = usePublicSkillStorage();
  const [selected, setSelected] = useState<SkillAsset | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<SkillStatusAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const applyRefreshTimersRef = useRef<number[]>([]);
  const mountedRef = useMountedRef();

  useEffect(
    () => () => {
      clearApplyRefreshTimers(applyRefreshTimersRef);
    },
    [],
  );

  const refreshAfterUpload = async () => {
    state.setPage(1);
    await state.refresh();
    await storage.refresh();
  };
  const refreshApplyState = () => {
    requestAlertsRefresh();
    void state.refresh({ background: true });
  };
  const schedulePostApplyRefresh = () => {
    clearApplyRefreshTimers(applyRefreshTimersRef);
    refreshApplyState();
    applyRefreshTimersRef.current = POST_APPLY_REFRESH_DELAYS_MS.map((delay) =>
      window.setTimeout(() => {
        if (!mountedRef.current) return;
        refreshApplyState();
      }, delay),
    );
  };
  const applyStatusAction = async () => {
    if (!pendingAction) return;
    setActionBusy(true);
    try {
      if (pendingAction.kind === "approve") {
        await api.approveSkill(pendingAction.skill.skillId);
      } else if (pendingAction.kind === "reject") {
        await api.rejectSkill(pendingAction.skill.skillId);
      } else {
        await api.updateSkill(pendingAction.skill.skillId, { status: pendingAction.status });
      }
      if (!mountedRef.current) return;
      Toast.warning(
        t("skill.applyStatusToast", {
          name: pendingAction.skill.name,
          action: pendingAction.label,
        }),
      );
      setPendingAction(null);
      await state.refresh();
    } catch (caught) {
      if (mountedRef.current) Toast.error(errorMessage(caught, "skill.updateStatusFailed"));
    } finally {
      if (mountedRef.current) setActionBusy(false);
    }
  };
  const applyAllSkills = () => {
    Modal.confirm({
      title: t("skill.applyAllTitle"),
      content: t("skill.applyAllContent"),
      okText: t("skill.applySkill"),
      onOk: async () => {
        setApplying(true);
        let submitted = false;
        try {
          const result = await api.applySkills();
          if (!mountedRef.current) return;
          notifySkillApplyResult(result);
          submitted = true;
        } catch (caught) {
          if (mountedRef.current) Toast.error(errorMessage(caught, "skill.applyAllFailed"));
        } finally {
          if (mountedRef.current) setApplying(false);
        }
        if (submitted && mountedRef.current) {
          schedulePostApplyRefresh();
        }
      },
    });
  };
  return (
    <div>
      <PageHeader title={t("nav.skills")} description={t("skill.pageDescription")} />
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

function notifySkillApplyResult(result: SkillReloadResult) {
  const results = result.results;
  const hasWarning = Object.values(results).some((status) =>
    ["failed_sync", "failed_queue", "skipped_not_running"].includes(status),
  );
  const message = skillApplyMessage(results, result.warnings ?? []);
  if (hasWarning || (result.warnings?.length ?? 0) > 0) {
    Toast.warning(message);
    return;
  }
  Toast.success(message);
}

function skillApplyMessage(results: Record<string, string>, warnings: string[] = []) {
  const entries = Object.values(results);
  const queued = entries.filter((status) => status === "queued").length;
  const synced = entries.filter((status) => status === "synced").length;
  const skipped = entries.filter((status) => status === "skipped_not_running").length;
  const failed = entries.filter((status) => status === "failed_sync").length;
  const failedQueue = entries.filter((status) => status === "failed_queue").length;
  const suffix = warnings.length > 0 ? ` ${warnings.join("；")}` : "";
  if (queued === 0 && failed === 0 && failedQueue === 0 && skipped === 0 && synced > 0) {
    return i18n.t("skill.applyAllSynced", { synced, suffix });
  }
  return i18n.t("skill.applySubmitted", { queued, synced, failed, failedQueue, skipped, suffix });
}

function clearApplyRefreshTimers(ref: MutableRefObject<number[]>) {
  for (const timer of ref.current) window.clearTimeout(timer);
  ref.current = [];
}

function usePublicSkillStorage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PublicSkillStorageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mountedRef = useMountedRef();

  const refresh = useCallback(
    async (options: RefreshOptions = {}) => {
      if (!options.background) setLoading(true);
      setError("");
      try {
        const result = await api.getPublicSkillStorage();
        if (!mountedRef.current) return;
        setStatus(result);
      } catch (caught) {
        if (mountedRef.current) setError(errorMessage(caught, "skill.loadPvcFailed"));
      } finally {
        if (mountedRef.current && !options.background) setLoading(false);
      }
    },
    [mountedRef],
  );

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
      setMessage(result.ready ? t("skill.pvcReady") : t("skill.pvcCreatedPending"));
    } catch (caught) {
      if (mountedRef.current) setError(errorMessage(caught, "skill.createPvcFailed"));
    } finally {
      if (mountedRef.current) setCreating(false);
    }
  };

  return { status, loading, creating, error, message, refresh, create };
}

function useSkillAssets() {
  const { t } = useTranslation();
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
  const foregroundRequestRef = useRef(0);

  const refresh = useCallback(
    async (options: RefreshOptions = {}) => {
      const requestId = ++requestRef.current;
      const foregroundRequestId = options.background ? 0 : ++foregroundRequestRef.current;
      if (!options.background) setLoading(true);
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
          setError(errorMessage(caught, "skill.loadFailed"));
        }
      } finally {
        if (
          mountedRef.current &&
          !options.background &&
          foregroundRequestId === foregroundRequestRef.current
        ) {
          setLoading(false);
        }
      }
    },
    [mountedRef, page, pageSize, query, scope, status],
  );

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
      setMessage(t("skill.scanDone", { count: result.scanned }));
      await refresh();
    } catch (caught) {
      if (mountedRef.current) setError(errorMessage(caught, "skill.scanFailed"));
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
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const scopeOptions = useMemo(
    () => [
      { value: "", label: t("skill.scopeFilterAll") },
      { value: "system", label: "System" },
      { value: "public", label: "Public" },
      { value: "private", label: "Private" },
    ],
    [t],
  );
  const statusOptions = useMemo(
    () => [
      { value: "", label: t("skill.statusFilterAll") },
      { value: "active", label: t("status.active") },
      { value: "disabled", label: t("status.disabled") },
      { value: "pending", label: t("status.pending") },
    ],
    [t],
  );
  const submit = () => {
    state.setPage(1);
    state.setQuery(search.trim());
  };
  return (
    <ListToolbar
      actions={
        <Space>
          <Button
            aria-label={t("skill.upload")}
            icon={<IconPlus />}
            disabled={!storage.status?.ready}
            onClick={onUpload}
          >
            {t("skill.upload")}
          </Button>
          <Tooltip content={t("skill.autoSyncTooltip")}>
            <Button className={styles.applyAllButton} loading={applying} onClick={onApply}>
              <span className={styles.applyAllButtonContent}>
                <span>{t("skill.applyAllPods")}</span>
                <IconHelpCircleStroked className={styles.applyAllInfoIcon} aria-hidden />
              </span>
            </Button>
          </Tooltip>
          <PublicStorageAction storage={storage} />
          <Button
            aria-label={t("skill.scan")}
            icon={<IconRefresh />}
            loading={state.scanning}
            disabled={state.loading}
            onClick={() => void state.scan()}
          >
            {t("skill.scan")}
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
            placeholder={t("skill.searchPlaceholder")}
            style={{ width: 240 }}
          />
          <Button aria-label={t("skill.query")} icon={<IconSearch />} onClick={submit} />
          <Select
            value={state.scope}
            optionList={scopeOptions}
            onChange={(value) => {
              state.setPage(1);
              state.setScope(String(value ?? "") as ScopeFilter);
            }}
            style={{ width: 120 }}
          />
          <Select
            value={state.status}
            optionList={statusOptions}
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
  const { t } = useTranslation();
  const status = storage.status;
  if (!status || status.ready || !status.configured) return null;
  return (
    <Button
      aria-label={t("skill.createPvcLabel")}
      icon={<IconPlus />}
      loading={storage.creating}
      onClick={() => void storage.create()}
    >
      {t("skill.createPvc")}
    </Button>
  );
}

function PublicStorageNotice({ storage }: { storage: PublicSkillStorageState }) {
  const { t } = useTranslation();
  const status = storage.status;
  if (storage.loading && !status) {
    return (
      <Banner
        className={styles.storageNotice}
        type="info"
        description={t("skill.checkingStorage")}
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
    return i18n.t("skill.storageUnconfigured");
  }
  return i18n.t("skill.storageNotReady", {
    message: status.message || i18n.t("skill.pvcNotReady"),
  });
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
  const { t } = useTranslation();
  return (
    <Table
      columns={skillColumns(t, onOpen, onStatusAction) as never}
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
      empty={t("skill.empty")}
      size="small"
    />
  );
}

function skillColumns(
  t: TFunction,
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
      title: t("skill.scope"),
      dataIndex: "scope",
      width: 150,
      render: (_: unknown, skill: SkillAsset) => (
        <Space spacing={4}>
          <ScopeTag scope={skill.scope} />
          {skill.source === "user" && <Tag color="green">{t("skill.userUploaded")}</Tag>}
        </Space>
      ),
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      width: 90,
      render: (_: unknown, skill: SkillAsset) => <StatusTag status={skill.status} />,
    },
    {
      title: t("skill.version"),
      dataIndex: "version",
      width: 120,
      render: (_: unknown, skill: SkillAsset) => skill.version || "-",
    },
    {
      title: t("skill.platform"),
      key: "platforms",
      width: 180,
      render: (_: unknown, skill: SkillAsset) => (
        <PlatformTags platformsJson={skill.platformsJson} />
      ),
    },
    {
      title: t("skill.features"),
      key: "features",
      width: 160,
      render: (_: unknown, skill: SkillAsset) => (
        <Space spacing={4}>
          {skill.progressSupported && <Tag>{t("skill.featureProgress")}</Tag>}
          {skill.browserRequired && <Tag>{t("skill.featureBrowser")}</Tag>}
          {skill.longTask && <Tag>{t("skill.featureLongTask")}</Tag>}
          {!skill.progressSupported && !skill.browserRequired && !skill.longTask && (
            <span className={styles.subtle}>-</span>
          )}
        </Space>
      ),
    },
    {
      title: t("skill.owner"),
      key: "owner",
      width: 210,
      render: (_: unknown, skill: SkillAsset) => <SkillOwner skill={skill} />,
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 190,
      render: (_: unknown, skill: SkillAsset) => (
        <SkillRowActions skill={skill} onOpen={onOpen} onStatusAction={onStatusAction} />
      ),
    },
  ];
}

function SkillOwner({ skill }: { skill: SkillAsset }) {
  const { t } = useTranslation();
  if (skill.scope === "system") return <span>{t("skill.ownerSystem")}</span>;
  if (skill.scope === "public") return <span>{t("skill.ownerPublic")}</span>;
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
  const { t } = useTranslation();
  const actions = skillStatusActions(skill);
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    setDownloading(true);
    try {
      await api.downloadSkill(skill.skillId, skill.name);
    } catch (caught) {
      Toast.error(errorMessage(caught, "skill.downloadFailed"));
    } finally {
      setDownloading(false);
    }
  };
  return (
    <Space spacing={4}>
      <Button size="small" onClick={() => onOpen(skill)}>
        {t("skill.detail")}
      </Button>
      <Button size="small" loading={downloading} onClick={() => void download()}>
        {t("skill.download")}
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
  if (skill.status === "pending") {
    actions.push({ skill, kind: "approve", status: "active", label: i18n.t("skill.approve") });
    actions.push({
      skill,
      kind: "reject",
      status: "deleted",
      label: i18n.t("skill.reject"),
      danger: true,
    });
    return actions;
  }
  if (skill.status === "active") {
    actions.push({ skill, kind: "status", status: "disabled", label: i18n.t("status.disable") });
  }
  if (skill.status === "disabled") {
    actions.push({ skill, kind: "status", status: "active", label: i18n.t("status.enable") });
  }
  if (skill.status !== "deleted" && skill.scope === "public") {
    actions.push({
      skill,
      kind: "status",
      status: "deleted",
      label: i18n.t("common.delete"),
      danger: true,
    });
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
  const { t } = useTranslation();
  return (
    <Modal
      className="standard-modal"
      title={action ? `${action.label} ${action.skill.name}` : t("skill.updateStatusTitle")}
      visible={Boolean(action)}
      onCancel={onClose}
      onOk={onConfirm}
      okText={t("skill.confirmAction", { action: action?.label ?? "" })}
      confirmLoading={busy}
      okButtonProps={{ type: action?.danger ? ("danger" as const) : ("primary" as const) }}
    >
      {action && (
        <div className={styles.statusActionBody}>
          <div>
            {t("skill.statusUpdateBodyPrefix", { name: action.skill.name })}
            <StatusTag status={action.status} />
            {t("skill.statusUpdateBodySuffix")}
          </div>
          <div className={styles.subtle}>{t("skill.statusUpdateHint")}</div>
          {action.status === "deleted" && (
            <div className={styles.subtle}>{t("skill.statusDeleteHint")}</div>
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
  const { t } = useTranslation();
  const color =
    status === "active"
      ? "green"
      : status === "disabled"
        ? "grey"
        : status === "pending"
          ? "amber"
          : "orange";
  const label =
    status === "active"
      ? t("status.active")
      : status === "disabled"
        ? t("status.disabled")
        : status === "pending"
          ? t("status.pending")
          : t("skill.statusDeleted");
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
  const { t } = useTranslation();
  const detailRows: DetailFieldRow[] = skill
    ? [
        { label: "Skill ID", value: skill.skillId, wide: true, mono: true },
        { label: t("skill.scope"), value: <ScopeTag scope={skill.scope} /> },
        { label: t("common.status"), value: <StatusTag status={skill.status} /> },
        { label: t("skill.version"), value: skill.version || "-" },
        { label: t("skill.entryType"), value: skill.entryType || "-" },
        {
          label: t("skill.featureLongTask"),
          value: skill.longTask ? t("common.yes") : t("common.no"),
        },
        { label: "Manifest", value: skill.manifestHash || "-", wide: true, mono: true },
        { label: "Human User", value: skill.humanUserId || "-", mono: Boolean(skill.humanUserId) },
        { label: "Pod", value: skill.podId || "-", mono: Boolean(skill.podId) },
        { label: t("skill.sourcePath"), value: skill.sourcePath || "-", wide: true, mono: true },
      ]
    : [];
  return (
    <SideSheet
      title={skill ? `${t("skill.detailTitle")} ${skill.name}` : t("skill.detailTitle")}
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
            <div className={styles.subtle}>{t("skill.platform")}</div>
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
