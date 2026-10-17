import { useEffect, useRef, useState } from "react";
import {
  Banner,
  Button,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Toast,
  Typography,
} from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api";
import type { ResourceConfig } from "../../api";
import { ChannelFields, useChannelForm, type ChannelInitial } from "../../components/ChannelForm";
import { errorMessage, ErrorDetail } from "../../utils/error";
import { memLimitToGB } from "../../utils/memLimit";
import { MAX_USERS_PER_POD } from "./createPodModel";
import formStyles from "../../components/ChannelForm.module.css";
import containerStyles from "../Containers.module.css";

const { Text } = Typography;

interface Props {
  podId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Pod 列表行「编辑」合并弹窗：一个弹窗同时编辑消息通道与资源覆盖，一次保存同时生效。 */
export function PodEditDialog({ podId, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<{
    channels: ChannelInitial;
    resources: ResourceConfig;
    maxUsers: number;
    userCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState<string | undefined>();
  const requestRef = useRef(0);

  useEffect(() => {
    if (!podId) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    setError("");
    setErrorDetail(undefined);
    setLoaded(null);
    Promise.all([api.getPod(podId), api.getPodResources(podId)])
      .then(([pod, resources]) => {
        if (requestId !== requestRef.current) return;
        setLoaded({
          channels: { channels: pod.channels, channelConfigs: pod.channelConfigs ?? {} },
          resources: {
            memLimit: memLimitToGB(resources.overrides.memLimit),
            cpuLimit: resources.overrides.cpuLimit,
            restartPolicy: resources.overrides.restartPolicy,
            maxSkillConcurrency: resources.overrides.maxSkillConcurrency,
            maxBrowserConcurrency: resources.overrides.maxBrowserConcurrency,
            maxLongTaskConcurrency: resources.overrides.maxLongTaskConcurrency,
          },
          maxUsers: pod.maxUsers,
          userCount: pod.userCount,
        });
      })
      .catch((e) => {
        if (requestId !== requestRef.current) return;
        setError(errorMessage(e, "channel.loadFailed"));
        setErrorDetail(e instanceof ApiError ? e.detail : undefined);
      })
      .finally(() => {
        if (requestId === requestRef.current) setLoading(false);
      });
  }, [podId]);

  return (
    <Modal
      className="standard-modal"
      title={t("pod.editTitle", { podId: podId ?? "" })}
      visible={podId !== null}
      onCancel={onClose}
      footer={null}
      width={640}
    >
      {loading ? (
        <Spin />
      ) : error && !loaded ? (
        <>
          <Banner type="danger" description={error} fullMode={false} bordered />
          <ErrorDetail detail={errorDetail} />
        </>
      ) : loaded ? (
        <PodEditForm
          podId={podId!}
          initial={loaded.channels}
          resourceInitial={loaded.resources}
          maxUsersInitial={loaded.maxUsers}
          userCount={loaded.userCount}
          onClose={onClose}
          onSaved={onSaved}
        />
      ) : null}
    </Modal>
  );
}

function PodEditForm({
  podId,
  initial,
  resourceInitial,
  maxUsersInitial,
  userCount,
  onClose,
  onSaved,
}: {
  podId: string;
  initial: ChannelInitial;
  resourceInitial: ResourceConfig;
  maxUsersInitial: number;
  userCount: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState<string | undefined>();
  const [resources, setResources] = useState<ResourceConfig>(resourceInitial);
  const [maxUsers, setMaxUsers] = useState(maxUsersInitial);
  const channelForm = useChannelForm({
    mode: "edit",
    initial,
    onSubmit: async (v) => {
      if (maxUsers < 1 || maxUsers > MAX_USERS_PER_POD) {
        setError(t("pod.maxUsersRange", { max: MAX_USERS_PER_POD }));
        return;
      }
      if (maxUsers < userCount) {
        setError(t("pod.maxUsersBelowUserCount", { count: userCount }));
        return;
      }
      setBusy(true);
      setError("");
      setErrorDetail(undefined);
      try {
        // 容量先提交：低于当前用户数会被后端拒绝，避免通道/资源已落的中间态。
        if (maxUsers !== maxUsersInitial) {
          await api.patchPod(podId, { maxUsers });
        }
        await api.updatePodChannels(podId, v);
        const result = await api.setPodResources(podId, resources);
        if (result?.requiresPodRestart) {
          Toast.warning(t("pod.requiresRestartWarning"));
        } else {
          Toast.success(t("channel.updated"));
        }
        onSaved();
      } catch (e) {
        setError(errorMessage(e, "channel.updateFailed"));
        setErrorDetail(e instanceof ApiError ? e.detail : undefined);
      } finally {
        setBusy(false);
      }
    },
  });

  const displayErr = error || channelForm.localErr;

  return (
    <div className={formStyles.form}>
      {displayErr && <Banner type="danger" description={displayErr} fullMode={false} bordered />}
      <ErrorDetail detail={errorDetail} />
      <ChannelFields form={channelForm} initial={initial} editMode t={t} />
      <div>
        <Text className={formStyles.label} type="tertiary" size="small">
          {t("common.resources")}
        </Text>
        <ResourceFields
          form={resources}
          setForm={setResources}
          maxUsers={maxUsers}
          userCount={userCount}
          onMaxUsers={setMaxUsers}
        />
      </div>
      <Space className={formStyles.actions}>
        <Button onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button theme="solid" loading={busy} disabled={busy} onClick={channelForm.submit}>
          {t("common.save")}
        </Button>
      </Space>
    </div>
  );
}

function ResourceFields({
  form,
  setForm,
  maxUsers,
  userCount,
  onMaxUsers,
}: {
  form: ResourceConfig;
  setForm: (form: ResourceConfig) => void;
  maxUsers: number;
  userCount: number;
  onMaxUsers: (value: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={containerStyles.dialogFields}>
      <label className={containerStyles.field}>
        <span>{t("pod.maxUsers")}</span>
        <InputNumber
          aria-label={t("pod.maxUsers")}
          value={maxUsers}
          min={1}
          max={MAX_USERS_PER_POD}
          onChange={(value) => onMaxUsers(Number(value ?? 0))}
          style={{ width: "100%" }}
        />
        <span className={containerStyles.fieldHint}>
          {t("pod.maxUsersCurrent", { count: userCount })}
        </span>
      </label>
      <ResourceInput
        label={t("pod.memLimit")}
        value={form.memLimit}
        onChange={(memLimit) => setForm({ ...form, memLimit })}
      />
      <ResourceInput
        label={t("pod.cpuLimit")}
        value={form.cpuLimit}
        onChange={(cpuLimit) => setForm({ ...form, cpuLimit })}
      />
      <label className={containerStyles.field}>
        <span>{t("pod.restartPolicy")}</span>
        <Select
          aria-label={t("pod.restartPolicyAria")}
          value={form.restartPolicy}
          optionList={[
            { value: "", label: t("pod.restartInheritGlobal") },
            { value: "unless-stopped", label: "unless-stopped" },
            { value: "always", label: "always" },
            { value: "on-failure", label: "on-failure" },
            { value: "no", label: "no" },
          ]}
          onChange={(value) => setForm({ ...form, restartPolicy: String(value ?? "") })}
          style={{ width: "100%" }}
        />
      </label>
      <ResourceNumber
        label={t("pod.maxSkillConcurrency")}
        value={form.maxSkillConcurrency ?? 0}
        onChange={(maxSkillConcurrency) => setForm({ ...form, maxSkillConcurrency })}
      />
      <ResourceNumber
        label={t("pod.maxBrowserConcurrency")}
        value={form.maxBrowserConcurrency ?? 0}
        onChange={(maxBrowserConcurrency) => setForm({ ...form, maxBrowserConcurrency })}
      />
      <ResourceNumber
        label={t("pod.maxLongTaskConcurrency")}
        value={form.maxLongTaskConcurrency ?? 0}
        onChange={(maxLongTaskConcurrency) => setForm({ ...form, maxLongTaskConcurrency })}
      />
    </div>
  );
}

function ResourceInput(props: { label: string; value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <label className={containerStyles.field}>
      <span>{props.label}</span>
      <Input
        aria-label={t("pod.fieldOverrideAria", { label: props.label })}
        value={props.value}
        onChange={props.onChange}
      />
    </label>
  );
}

function ResourceNumber(props: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className={containerStyles.field}>
      <span>{props.label}</span>
      <InputNumber
        aria-label={t("pod.fieldOverrideAria", { label: props.label })}
        value={props.value}
        min={0}
        max={1000}
        onChange={(value) => props.onChange(Number(value ?? 0))}
        style={{ width: "100%" }}
      />
    </label>
  );
}
