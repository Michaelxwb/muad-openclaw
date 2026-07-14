import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Modal, Select, Space, Table, Tag, Toast, Upload } from "@douyinfe/semi-ui";
import type { FileItem } from "@douyinfe/semi-ui/lib/es/upload";
import { IconPlus, IconSearch, IconRefresh } from "@douyinfe/semi-icons";
import { api } from "../../api";
import type { EffectiveSkill, HumanUser } from "../../api";
import { FeedbackBanner, ListToolbar } from "../ConsolePage";
import { useMountedRef } from "../../hooks/useMountedRef";
import styles from "../HumanUsersPanel.module.css";

type SkillStatusFilter = "" | "effective" | "conflict" | "disabled" | "missing_credential";

const SKILL_STATUS_OPTIONS = [
  { label: "全部状态", value: "" },
  { label: "可执行", value: "effective" },
  { label: "冲突", value: "conflict" },
  { label: "缺凭证", value: "missing_credential" },
  { label: "禁用", value: "disabled" },
];

export function HumanUserSkillsTab({
  user,
  onChanged,
}: {
  user: HumanUser;
  onChanged: () => Promise<void>;
}) {
  const state = useHumanUserSkills(user.humanUserId);
  const [uploadOpen, setUploadOpen] = useState(false);
  const changed = async () => {
    await Promise.all([state.refresh(), onChanged()]);
  };
  return (
    <div>
      <FeedbackBanner error={state.error} message={state.message} />
      <ListToolbar
        actions={
          <Space>
            <Button icon={<IconPlus />} onClick={() => setUploadOpen(true)}>
              上传 Private Skill
            </Button>
            <Button
              icon={<IconRefresh />}
              loading={state.loading}
              onClick={() => void state.refresh()}
            >
              刷新
            </Button>
          </Space>
        }
        filters={<SkillFilters state={state} />}
      />
      <Table
        rowKey="name"
        dataSource={state.items}
        columns={skillColumns(user.humanUserId, state) as never}
        loading={false}
        pagination={false}
        empty={state.loading ? "正在加载 Skill" : "暂无可见 Skill"}
        size="small"
      />
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

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
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
        setError(caught instanceof Error ? caught.message : "加载用户 Skill 失败");
      }
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [humanUserId, mountedRef, query, status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createPolicy = async (skillName: string, action: "disable" | "allow_override") => {
    setError("");
    setMessage("");
    try {
      await api.createSkillPolicy(humanUserId, { skillName, action, reason: "console" });
      if (!mountedRef.current) return;
      setMessage(action === "disable" ? "已禁用 Skill" : "已允许 Private 覆盖");
      await refresh();
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : "策略操作失败");
    }
  };

  const deletePrivate = async (skill: EffectiveSkill) => {
    if (!skill.privateSkillId) return;
    Modal.confirm({
      title: "删除 Private Skill",
      content: `删除 ${skill.name} 后，该用户将无法继续使用该 private 版本。`,
      onOk: async () => {
        await api.deletePrivateSkill(humanUserId, skill.privateSkillId ?? "");
        Toast.success("Private Skill 已删除");
        await refresh();
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
  const [search, setSearch] = useState("");
  const submit = () => state.setQuery(search.trim());
  return (
    <Space>
      <Input
        prefix={<IconSearch />}
        value={search}
        onChange={setSearch}
        onEnterPress={submit}
        placeholder="Skill 名称"
        style={{ width: 180 }}
      />
      <Button aria-label="查询用户 Skill" icon={<IconSearch />} onClick={submit} />
      <Select
        aria-label="Skill 状态过滤"
        value={state.status}
        optionList={SKILL_STATUS_OPTIONS}
        onChange={(value) => state.setStatus(String(value ?? "") as SkillStatusFilter)}
        style={{ width: 120 }}
      />
    </Space>
  );
}

function skillColumns(humanUserId: string, state: HumanUserSkillsState) {
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
      title: "来源",
      key: "source",
      width: 110,
      render: (_: unknown, skill: EffectiveSkill) => <Tag>{skill.effectiveSource}</Tag>,
    },
    {
      title: "状态",
      key: "status",
      width: 160,
      render: (_: unknown, skill: EffectiveSkill) => <SkillState skill={skill} />,
    },
    {
      title: "平台凭证",
      key: "platforms",
      width: 190,
      render: (_: unknown, skill: EffectiveSkill) => <CredentialTags skill={skill} />,
    },
    {
      title: "最近执行",
      key: "lastExecution",
      width: 150,
      render: (_: unknown, skill: EffectiveSkill) =>
        skill.lastExecution ? (
          <div>
            <Tag>{skill.lastExecution.status}</Tag>
            <div className="mono">{skill.lastExecution.durationMs}ms</div>
          </div>
        ) : (
          "-"
        ),
    },
    {
      title: "操作",
      key: "actions",
      width: 220,
      render: (_: unknown, skill: EffectiveSkill) => (
        <Space spacing={4}>
          {skill.conflict && (
            <Button
              size="small"
              onClick={() => void state.createPolicy(skill.name, "allow_override")}
            >
              允许覆盖
            </Button>
          )}
          {skill.effective && (
            <Button size="small" onClick={() => void state.createPolicy(skill.name, "disable")}>
              禁用
            </Button>
          )}
          {skill.privateSkillId && (
            <Button
              size="small"
              type="danger"
              onClick={() => void state.deletePrivate(skill)}
              aria-label={`删除 Private Skill ${skill.name} ${humanUserId}`}
            >
              删除 Private
            </Button>
          )}
        </Space>
      ),
    },
  ];
}

function SkillState({ skill }: { skill: EffectiveSkill }) {
  if (skill.conflict) {
    return (
      <Space spacing={4}>
        <Tag color="orange">冲突</Tag>
        <span>{skill.conflictReason || "需要确认覆盖策略"}</span>
      </Space>
    );
  }
  const tags = [];
  if (skill.status === "missing_credential") {
    tags.push(
      <Tag key="credential" color="red">
        缺少平台凭证
      </Tag>,
    );
  } else if (skill.status === "disabled") {
    tags.push(
      <Tag key="disabled" color="grey">
        已禁用
      </Tag>,
    );
  } else {
    tags.push(
      <Tag key="effective" color="green">
        可执行
      </Tag>,
    );
  }
  if (skill.runtimePending) {
    tags.push(
      <Tag key="pending" color="orange">
        待应用
      </Tag>,
    );
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
      return "已配置";
    case "platform_disabled":
      return "平台禁用";
    case "platform_missing":
      return "平台缺失";
    default:
      return "缺凭证";
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
  const [file, setFile] = useState<File | null>(null);
  const [fileList, setFileList] = useState<FileItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reset = () => {
    setFile(null);
    setFileList([]);
    setError("");
  };
  const close = () => {
    reset();
    onClose();
  };
  const submit = async () => {
    if (!file) {
      setError("请选择 .tar.gz 或 .zip Skill 包");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.uploadPrivateSkill(user.humanUserId, {
        bundle: file,
        filename: file.name,
      });
      Toast.success("Private Skill 上传成功");
      close();
      await onUploaded();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "上传失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="上传 Private Skill"
      visible={visible}
      onCancel={close}
      confirmLoading={busy}
      onOk={() => void submit()}
    >
      <Space vertical align="start">
        {error && <span className={styles.errorText}>{error}</span>}
        <Upload
          aria-label="Private Skill 包"
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
          }}
          onRemove={() => {
            setFile(null);
            setFileList([]);
          }}
        >
          <span className={styles.uploadTrigger}>选择 .tar.gz / .zip 包</span>
        </Upload>
        {file && <span className="mono">{file.name}</span>}
      </Space>
    </Modal>
  );
}
