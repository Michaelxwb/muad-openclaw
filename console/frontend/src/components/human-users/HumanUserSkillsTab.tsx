import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Toast,
  Upload,
} from "@douyinfe/semi-ui";
import type { FileItem } from "@douyinfe/semi-ui/lib/es/upload";
import { IconPlus, IconSearch, IconRefresh } from "@douyinfe/semi-icons";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../../api";
import type { EffectiveSkill, HumanUser, Platform, SkillScope } from "../../api";
import { ApiError } from "../../api";
import { FeedbackBanner, ListToolbar } from "../ConsolePage";
import { useMountedRef } from "../../hooks/useMountedRef";
import { errorMessage, ErrorDetail } from "../../utils/error";
import i18n from "../../i18n";
import styles from "../HumanUsersPanel.module.css";

type SkillStatusFilter = "" | "effective" | "conflict" | "disabled" | "missing_credential";

function skillStatusOptions(t: (key: string) => string) {
  return [
    { label: t("user.statusAll"), value: "" },
    { label: t("user.skillEffective"), value: "effective" },
    { label: t("user.skillConflict"), value: "conflict" },
    { label: t("user.skillMissingCredential"), value: "missing_credential" },
    { label: t("user.skillDisabled"), value: "disabled" },
  ];
}
const SKILL_TABLE_SCROLL_X = 1040;

interface RefreshOptions {
  background?: boolean;
}

export function HumanUserSkillsTab({
  user,
  onChanged,
}: {
  user: HumanUser;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const state = useHumanUserSkills(user.humanUserId);
  const [uploadOpen, setUploadOpen] = useState(false);

  const changed = async () => {
    await Promise.all([state.refresh(), onChanged()]);
  };
  return (
    <div className={styles.skillTab}>
      <FeedbackBanner error={state.error} message={state.message} />
      <ListToolbar
        actions={
          <Space>
            <Button icon={<IconPlus />} onClick={() => setUploadOpen(true)}>
              {t("user.uploadPrivateSkill")}
            </Button>
            <Button
              icon={<IconRefresh />}
              loading={state.loading}
              onClick={() => void state.refresh()}
            >
              {t("common.refresh")}
            </Button>
          </Space>
        }
        filters={<SkillFilters state={state} />}
      />
      <div className={styles.skillTableShell} data-testid="human-user-skill-table">
        <Table
          rowKey="name"
          dataSource={state.items}
          columns={skillColumns(t, user.humanUserId, state) as never}
          loading={false}
          pagination={false}
          empty={state.loading ? t("user.loadingSkills") : t("user.noVisibleSkills")}
          size="small"
          scroll={{ x: SKILL_TABLE_SCROLL_X }}
        />
      </div>
      <PrivateSkillUploadDialog
        user={user}
        visible={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={changed}
      />
    </div>
  );
}

function useHumanUserSkills(humanUserId: string) {
  const [items, setItems] = useState<EffectiveSkill[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SkillStatusFilter>("");
  const [loading, setLoading] = useState(true);
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
        const result = await api.listHumanUserSkills(humanUserId, {
          q: query,
          status: status || undefined,
        });
        if (!mountedRef.current || requestId !== requestRef.current) return;
        setItems(normalizeEffectiveSkills(result.items));
      } catch (caught) {
        if (mountedRef.current && requestId === requestRef.current) {
          setError(errorMessage(caught, "user.loadSkillsFailed"));
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
    [humanUserId, mountedRef, query, status],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createPolicy = async (skillName: string, action: "disable" | "allow_override") => {
    setError("");
    setMessage("");
    try {
      await api.createSkillPolicy(humanUserId, { skillName, action, reason: "console" });
      if (!mountedRef.current) return;
      setMessage(
        action === "disable"
          ? i18n.t("user.skillDisabledToast")
          : i18n.t("user.privateOverrideAllowed"),
      );
      await refresh();
    } catch (caught) {
      if (mountedRef.current) setError(errorMessage(caught, "user.policyOperationFailed"));
    }
  };

  const deletePrivate = async (skill: EffectiveSkill) => {
    if (!skill.privateSkillId) return;
    Modal.confirm({
      title: i18n.t("user.deletePrivateSkillTitle"),
      content: i18n.t("user.deletePrivateSkillConfirm", { name: skill.name }),
      onOk: async () => {
        try {
          await api.deletePrivateSkill(humanUserId, skill.privateSkillId ?? "");
          if (!mountedRef.current) return;
          Toast.success(i18n.t("user.privateSkillDeleted"));
          await refresh();
        } catch (caught) {
          if (mountedRef.current) {
            setError(errorMessage(caught, "user.deletePrivateSkillFailed"));
          }
          throw caught;
        }
      },
    });
  };

  return {
    items,
    query,
    status,
    loading,
    error,
    message,
    setQuery,
    setStatus,
    refresh,
    createPolicy,
    deletePrivate,
  };
}

type HumanUserSkillsState = ReturnType<typeof useHumanUserSkills>;

function normalizeEffectiveSkills(items: EffectiveSkill[] | null | undefined): EffectiveSkill[] {
  return Array.isArray(items)
    ? items.map((item) => ({
        ...item,
        platforms: Array.isArray(item.platforms) ? item.platforms : [],
        lastExecution: item.lastExecution ?? undefined,
      }))
    : [];
}

function SkillFilters({ state }: { state: HumanUserSkillsState }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const submit = () => state.setQuery(search.trim());
  return (
    <Space>
      <Input
        prefix={<IconSearch />}
        value={search}
        onChange={setSearch}
        onEnterPress={submit}
        placeholder={t("user.skillNamePlaceholder")}
        style={{ width: 180 }}
      />
      <Button aria-label={t("user.queryUserSkill")} icon={<IconSearch />} onClick={submit} />
      <Select
        aria-label={t("user.skillStatusFilter")}
        value={state.status}
        optionList={skillStatusOptions(t)}
        onChange={(value) => state.setStatus(String(value ?? "") as SkillStatusFilter)}
        style={{ width: 120 }}
      />
    </Space>
  );
}

function skillColumns(t: TFunction, humanUserId: string, state: HumanUserSkillsState) {
  return [
    {
      title: "Skill",
      key: "name",
      render: (_: unknown, skill: EffectiveSkill) => (
        <div>
          <div className={styles.primaryText}>{skill.displayName || skill.name}</div>
          <div className="mono">{skill.name}</div>
        </div>
      ),
    },
    {
      title: t("user.columnScope"),
      key: "scope",
      width: 150,
      render: (_: unknown, skill: EffectiveSkill) => (
        <Space spacing={4}>
          <EffectiveScopeTag scope={skill.effectiveSource} />
          {skill.source === "user" && <Tag color="green">{t("user.userUploaded")}</Tag>}
        </Space>
      ),
    },
    {
      title: t("common.status"),
      key: "status",
      width: 160,
      render: (_: unknown, skill: EffectiveSkill) => <SkillState skill={skill} />,
    },
    {
      title: t("user.platformCredentials"),
      key: "platforms",
      width: 190,
      render: (_: unknown, skill: EffectiveSkill) => <CredentialTags skill={skill} />,
    },
    {
      title: t("user.columnLastExecution"),
      key: "lastExecution",
      width: 150,
      render: (_: unknown, skill: EffectiveSkill) =>
        skill.lastExecution ? new Date(skill.lastExecution.startedAt).toLocaleString() : "-",
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 220,
      render: (_: unknown, skill: EffectiveSkill) => (
        <Space spacing={4}>
          {skill.conflict && (
            <Button
              size="small"
              onClick={() => void state.createPolicy(skill.name, "allow_override")}
            >
              {t("user.allowOverride")}
            </Button>
          )}
          {skill.effective && (
            <Button size="small" onClick={() => void state.createPolicy(skill.name, "disable")}>
              {t("user.skillDisabled")}
            </Button>
          )}
          {skill.privateSkillId && (
            <Button
              size="small"
              type="danger"
              onClick={() => void state.deletePrivate(skill)}
              aria-label={t("user.deletePrivateSkillAria", {
                name: skill.name,
                userId: humanUserId,
              })}
            >
              {t("user.deletePrivate")}
            </Button>
          )}
        </Space>
      ),
    },
  ];
}

function EffectiveScopeTag({ scope }: { scope: SkillScope }) {
  const color = scope === "system" ? "red" : scope === "private" ? "violet" : "blue";
  return <Tag color={color}>{scope}</Tag>;
}

function SkillState({ skill }: { skill: EffectiveSkill }) {
  const { t } = useTranslation();
  if (skill.conflict) {
    return (
      <Space spacing={4}>
        <Tag color="orange">{t("user.skillConflict")}</Tag>
        <span>{skill.conflictReason || t("user.conflictNeedsPolicy")}</span>
      </Space>
    );
  }
  const tags = [];
  if (skill.status === "missing_credential") {
    tags.push(
      <Tag key="credential" color="red">
        {t("user.missingPlatformCredential")}
      </Tag>,
    );
  } else if (skill.status === "disabled") {
    tags.push(
      <Tag key="disabled" color="grey">
        {t("user.skillDisabledState")}
      </Tag>,
    );
  } else {
    tags.push(
      <Tag key="effective" color="green">
        {t("user.skillEffective")}
      </Tag>,
    );
  }
  if (skill.runtimePending) {
    tags.push(
      <Tag key="pending" color="orange">
        {t("status.pendingApply")}
      </Tag>,
    );
  }
  if (skill.longTask) {
    tags.push(<Tag key="long-task">{t("skill.featureLongTask")}</Tag>);
  }
  return <Space spacing={4}>{tags}</Space>;
}

function CredentialTags({ skill }: { skill: EffectiveSkill }) {
  const platforms = Array.isArray(skill.platforms) ? skill.platforms : [];
  if (platforms.length === 0) return <span>-</span>;
  return (
    <Space spacing={4} wrap>
      {platforms.map((platform) => (
        <Tag
          key={platform.platform}
          color={platform.credentialStatus === "configured" ? "green" : "red"}
        >
          {platform.platform}: {credentialLabel(platform.credentialStatus)}
        </Tag>
      ))}
    </Space>
  );
}

function credentialLabel(status: string) {
  switch (status) {
    case "configured":
      return i18n.t("user.configured");
    case "platform_disabled":
      return i18n.t("user.platformDisabled");
    case "platform_missing":
      return i18n.t("user.platformMissing");
    default:
      return i18n.t("user.skillMissingCredential");
  }
}

function PrivateSkillUploadDialog({
  user,
  visible,
  onClose,
  onUploaded,
}: {
  user: HumanUser;
  visible: boolean;
  onClose: () => void;
  onUploaded: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [fileList, setFileList] = useState<FileItem[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [platformOptions, setPlatformOptions] = useState<Platform[]>([]);
  const [allowOverride, setAllowOverride] = useState(false);
  const [overrideSkillName, setOverrideSkillName] = useState("");
  const [platformLoading, setPlatformLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    setPlatformLoading(true);
    api
      .listPlatforms()
      .then((result) => {
        if (active) setPlatformOptions(result.items);
      })
      .catch((caught) => {
        if (active) {
          setError(errorMessage(caught, "user.loadPlatformsFailed"));
          setDetail(caught instanceof ApiError ? caught.detail : undefined);
        }
      })
      .finally(() => {
        if (active) setPlatformLoading(false);
      });
    return () => {
      active = false;
    };
  }, [visible]);
  const reset = () => {
    setFile(null);
    setFileList([]);
    setPlatforms([]);
    setAllowOverride(false);
    setOverrideSkillName("");
    setError("");
    setDetail(undefined);
  };
  const close = () => {
    reset();
    onClose();
  };
  const submit = async () => {
    if (!file) {
      setError(t("user.selectSkillBundle"));
      setDetail(undefined);
      return;
    }
    const expectedName = allowOverride ? overrideSkillName.trim() : "";
    if (allowOverride && expectedName === "") {
      setError(t("user.fillPublicSkillName"));
      setDetail(undefined);
      return;
    }
    setBusy(true);
    setError("");
    setDetail(undefined);
    try {
      await api.uploadPrivateSkill(user.humanUserId, {
        bundle: file,
        filename: file.name,
        expectedName: expectedName || undefined,
        platforms,
        allowOverride,
      });
      Toast.success(t("user.privateSkillUploaded"));
      close();
      await onUploaded();
    } catch (caught) {
      setError(errorMessage(caught, "user.uploadFailed"));
      setDetail(caught instanceof ApiError ? caught.detail : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("user.uploadPrivateSkill")}
      visible={visible}
      onCancel={close}
      confirmLoading={busy}
      onOk={() => void submit()}
    >
      <Space vertical align="start">
        {error && <span className={styles.errorText}>{error}</span>}
        <ErrorDetail detail={detail} />
        <Upload
          aria-label={t("user.privateSkillBundleAria")}
          accept=".tar.gz,.zip"
          action=""
          uploadTrigger="custom"
          limit={1}
          fileList={fileList}
          showUploadList={false}
          onFileChange={(files) => {
            const nextFile = files[0] ?? null;
            setFile(nextFile);
            setFileList(
              nextFile
                ? [
                    {
                      uid: `${nextFile.name}-${nextFile.lastModified}`,
                      name: nextFile.name,
                      size: String(nextFile.size),
                      status: "wait",
                      fileInstance: nextFile,
                    },
                  ]
                : [],
            );
            setError("");
            setDetail(undefined);
          }}
          onRemove={() => {
            setFile(null);
            setFileList([]);
          }}
        >
          <span className={styles.uploadTrigger}>{t("user.selectBundleTrigger")}</span>
        </Upload>
        {file && <span className="mono">{file.name}</span>}
        <Checkbox
          checked={allowOverride}
          onChange={(event) => setAllowOverride(Boolean(event.target.checked))}
        >
          {t("user.allowOverridePublic")}
        </Checkbox>
        {allowOverride && (
          <div className={styles.field}>
            <label>{t("user.publicSkillName")}</label>
            <Input
              aria-label={t("user.overrideSkillNameAria")}
              placeholder="skill-name"
              value={overrideSkillName}
              onChange={setOverrideSkillName}
              style={{ width: 320 }}
            />
          </div>
        )}
        <Select
          multiple
          placeholder={t("user.platformDependencies")}
          value={platforms}
          loading={platformLoading}
          optionList={platformOptions.map(platformOption)}
          onChange={(value) => setPlatforms(Array.isArray(value) ? value.map(String) : [])}
          style={{ width: 320 }}
        />
      </Space>
    </Modal>
  );
}

function platformOption(platform: Platform) {
  return {
    value: platform.platform,
    label: platform.enabled
      ? `${platform.displayName} (${platform.platform})`
      : `${platform.displayName} (${platform.platform}) ${i18n.t("user.platformDisabledSuffix")}`,
  };
}
