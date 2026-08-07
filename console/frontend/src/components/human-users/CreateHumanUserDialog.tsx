import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, InputNumber, Modal, RadioGroup, Select, TextArea } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import type {
  CreateHumanUserInput,
  HumanUserBootstrapResult,
  LLMModelConfig,
  Pod,
} from "../../api";
import { channelMeta } from "../../channels";
import { FeedbackBanner, setRepeatableError } from "../ConsolePage";
import { errorMessage } from "../../utils/error";
import i18n from "../../i18n";
import styles from "../HumanUsersPanel.module.css";
import { Field } from "./shared";

type CreateMode = "identity" | "activation";

interface CreateUserForm {
  mode: CreateMode;
  displayName: string;
  modelConfigId: string;
  agentId: string;
  notes: string;
  channel: string;
  accountId: string;
  externalId: string;
  externalIdType: string;
  expiresInMinutes: number;
}

interface Props {
  pod: Pod;
  podOptions?: Pod[];
  visible: boolean;
  onClose: () => void;
  onCreated: (result: HumanUserBootstrapResult) => Promise<void>;
}

function initialForm(pod: Pod): CreateUserForm {
  return {
    mode: "identity",
    displayName: "",
    modelConfigId: "",
    agentId: "",
    notes: "",
    channel: pod.channels[0] ?? "",
    accountId: "default",
    externalId: "",
    externalIdType: "user_id",
    expiresInMinutes: 30,
  };
}

function validate(form: CreateUserForm): string {
  if (form.displayName.trim() === "") return i18n.t("user.displayNameRequired");
  if (form.modelConfigId.trim() === "") return i18n.t("user.modelConfigRequired");
  if (form.channel === "") return i18n.t("user.channelRequired");
  if (form.mode === "identity" && form.externalId === "") return i18n.t("user.externalIdRequired");
  if (form.mode === "identity" && !/^[a-z][a-z0-9_]{0,63}$/.test(form.externalIdType))
    return i18n.t("user.externalIdTypeInvalid");
  if (form.expiresInMinutes < 1 || form.expiresInMinutes > 1440)
    return i18n.t("user.validityRange");
  return "";
}

function createInput(form: CreateUserForm): CreateHumanUserInput {
  const common = {
    displayName: form.displayName.trim(),
    modelConfigId: form.modelConfigId.trim(),
    agentId: form.agentId.trim() || undefined,
    notes: form.notes,
  };
  if (form.mode === "identity") {
    return {
      ...common,
      identity: {
        channel: form.channel,
        accountId: form.accountId.trim() || "default",
        externalId: form.externalId,
        externalIdType: form.externalIdType.trim(),
        peerKind: "direct",
      },
    };
  }
  return {
    ...common,
    activation: {
      channel: form.channel,
      accountId: form.accountId.trim() || "default",
      expiresInMinutes: form.expiresInMinutes,
    },
  };
}

export function CreateHumanUserDialog({ pod, podOptions, visible, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const [selectedPodId, setSelectedPodId] = useState(pod.podId);
  const [form, setForm] = useState<CreateUserForm>(() => initialForm(pod));
  const [models, setModels] = useState<LLMModelConfig[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const previousVisibleRef = useRef(visible);
  const selectablePods = useMemo(() => podOptions ?? [pod], [pod, podOptions]);
  const canSwitchPod = Boolean(podOptions);
  const selectedPod = selectablePods.find((item) => item.podId === selectedPodId) ?? pod;

  useEffect(() => {
    const opened = visible && !previousVisibleRef.current;
    previousVisibleRef.current = visible;
    if (!opened) return;
    const nextPod = firstAvailablePod(selectablePods) ?? pod;
    setSelectedPodId(nextPod.podId);
    setForm(initialForm(nextPod));
    setError("");
    void loadAvailableModels();
  }, [pod, selectablePods, visible]);

  const modelsRequestRef = useRef(0);
  const loadAvailableModels = async () => {
    const requestId = ++modelsRequestRef.current;
    try {
      const result = await api.listLLMModels(true);
      if (requestId !== modelsRequestRef.current || !visible) return;
      setModels(result.items);
      setForm((previous) => ({
        ...previous,
        modelConfigId: previous.modelConfigId || result.items[0]?.modelConfigId || "",
      }));
    } catch (caught) {
      if (requestId !== modelsRequestRef.current || !visible) return;
      setModels([]);
      setError(errorMessage(caught, "user.loadModelsFailed"));
    }
  };

  const submit = async () => {
    if (canSwitchPod && selectedPod.availableSlots <= 0) {
      return setRepeatableError(setError, t("user.selectAvailablePod"));
    }
    const validation = validate(form);
    if (validation) return setRepeatableError(setError, validation);
    setBusy(true);
    setError("");
    try {
      await onCreated(await api.createHumanUser(selectedPod.podId, createInput(form)));
    } catch (caught) {
      setError(errorMessage(caught, "user.createUserFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      className="standard-modal"
      title={t("user.createUserTitle")}
      visible={visible}
      onCancel={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button theme="solid" loading={busy} onClick={() => void submit()}>
            {t("common.create")}
          </Button>
        </>
      }
      width={640}
    >
      <FeedbackBanner error={error} />
      <CreateForm
        pod={selectedPod}
        podOptions={selectablePods}
        canSwitchPod={canSwitchPod}
        models={models}
        form={form}
        setForm={setForm}
        onPodChange={(nextPod) => {
          setSelectedPodId(nextPod.podId);
          setForm((previous) => ({
            ...initialForm(nextPod),
            modelConfigId: previous.modelConfigId,
          }));
        }}
      />
    </Modal>
  );
}

function firstAvailablePod(pods: Pod[]): Pod | undefined {
  return pods.find((item) => item.availableSlots > 0) ?? pods[0];
}

interface FormProps {
  pod: Pod;
  podOptions: Pod[];
  canSwitchPod: boolean;
  models: LLMModelConfig[];
  form: CreateUserForm;
  setForm: (update: (previous: CreateUserForm) => CreateUserForm) => void;
  onPodChange: (pod: Pod) => void;
}

function CreateForm({
  pod,
  podOptions,
  canSwitchPod,
  models,
  form,
  setForm,
  onPodChange,
}: FormProps) {
  const { t } = useTranslation();
  const set = (key: keyof CreateUserForm, value: string | number) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  return (
    <>
      <RadioGroup
        aria-label={t("user.activationMode")}
        type="button"
        value={form.mode}
        options={[
          { value: "identity", label: t("user.modeKnownExternalId") },
          { value: "activation", label: t("user.modeBindingCode") },
        ]}
        onChange={(event) =>
          set("mode", event.target.value === "activation" ? "activation" : "identity")
        }
      />
      <div className={styles.formGrid}>
        <PodField pod={pod} pods={podOptions} disabled={!canSwitchPod} onPodChange={onPodChange} />
        <CommonFields pod={pod} models={models} form={form} set={set} />
        {form.mode === "identity" ? (
          <IdentityFields form={form} set={set} />
        ) : (
          <ActivationFields form={form} set={set} />
        )}
        <div className={styles.full}>
          <Field label={t("user.notes")}>
            <TextArea
              aria-label={t("user.notes")}
              value={form.notes}
              onChange={(value) => set("notes", value)}
              maxCount={4000}
            />
          </Field>
        </div>
      </div>
    </>
  );
}

function PodField({
  pod,
  pods,
  disabled,
  onPodChange,
}: {
  pod: Pod;
  pods: Pod[];
  disabled: boolean;
  onPodChange: (pod: Pod) => void;
}) {
  return (
    <Field label="Pod">
      <Select
        aria-label="Pod"
        value={pod.podId}
        disabled={disabled}
        optionList={pods.map((item) => ({
          value: item.podId,
          label: `${item.displayName} (${item.podId}) ${item.userCount}/${item.maxUsers}`,
          disabled: item.availableSlots <= 0,
        }))}
        onChange={(value) => {
          const nextPod = pods.find((item) => item.podId === String(value ?? ""));
          if (nextPod && nextPod.availableSlots > 0) onPodChange(nextPod);
        }}
        style={{ width: "100%" }}
      />
    </Field>
  );
}

type SetField = (key: keyof CreateUserForm, value: string | number) => void;

function CommonFields({
  pod,
  models,
  form,
  set,
}: {
  pod: Pod;
  models: LLMModelConfig[];
  form: CreateUserForm;
  set: SetField;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t("user.displayName")}>
        <Input
          aria-label={t("user.displayName")}
          value={form.displayName}
          onChange={(value) => set("displayName", value)}
        />
      </Field>
      <Field label="Agent ID">
        <Input
          aria-label="Agent ID"
          value={form.agentId}
          onChange={(value) => set("agentId", value)}
          placeholder={t("user.agentIdAuto")}
        />
      </Field>
      <Field label={t("user.modelConfig")}>
        <Select
          aria-label={t("user.modelConfig")}
          value={form.modelConfigId}
          placeholder={models.length === 0 ? t("user.noModels") : t("user.selectUnboundModel")}
          optionList={models.map((model) => ({
            value: model.modelConfigId,
            label: `${model.displayName} (${model.provider}/${model.model})`,
          }))}
          onChange={(value) => set("modelConfigId", String(value ?? ""))}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label={t("user.messageChannel")}>
        <Select
          aria-label={t("user.messageChannel")}
          value={form.channel}
          optionList={pod.channels.map((channel) => ({
            value: channel,
            label: channelMeta(channel).label,
          }))}
          onChange={(value) => set("channel", String(value ?? ""))}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="Account ID">
        <Input
          aria-label="Account ID"
          value={form.accountId}
          onChange={(value) => set("accountId", value)}
        />
      </Field>
    </>
  );
}

function IdentityFields({ form, set }: { form: CreateUserForm; set: SetField }) {
  const { t } = useTranslation();
  return (
    <>
      <Field label="External ID">
        <Input
          aria-label="External ID"
          value={form.externalId}
          onChange={(value) => set("externalId", value)}
        />
      </Field>
      <Field label={t("user.externalIdType")}>
        <Input
          aria-label={t("user.externalIdType")}
          value={form.externalIdType}
          onChange={(value) => set("externalIdType", value)}
        />
      </Field>
    </>
  );
}

function ActivationFields({ form, set }: { form: CreateUserForm; set: SetField }) {
  const { t } = useTranslation();
  return (
    <Field label={t("user.bindingValidityMinutes")}>
      <InputNumber
        aria-label={t("user.bindingValidity")}
        min={1}
        max={1440}
        value={form.expiresInMinutes}
        onNumberChange={(value) => set("expiresInMinutes", value)}
        style={{ width: "100%" }}
      />
    </Field>
  );
}
