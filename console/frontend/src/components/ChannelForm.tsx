import { useState, useEffect } from "react";
import { Banner, Button, Checkbox, Input, Space, Typography } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { CHANNEL_DEFS, ChannelDef, channelDef } from "../channels";
import { ChannelCredential } from "../api";
import { ErrorDetail } from "../utils/error";
import styles from "./ChannelForm.module.css";

const { Text } = Typography;

interface Props {
  mode: "create" | "edit";
  initial?: {
    channels: string[];
    channelConfigs: Record<
      string,
      {
        botId?: string;
        baseUrl?: string;
        allowPrivateNetwork?: string;
        secretConfigured?: boolean;
        lastUpdated?: string;
      }
    >;
  } | null;
  busy: boolean;
  error: string;
  errorDetail?: string;
  onSubmit: (v: { channels: string[]; channelConfigs: Record<string, ChannelCredential> }) => void;
  onCancel: () => void;
}

export type ChannelInitial = NonNullable<Props["initial"]>;

/** Toggle a channel in the selected set. */
function toggle(arr: string[], id: string, on: boolean): string[] {
  return on ? [...arr, id] : arr.filter((c) => c !== id);
}

/**
 * 通道表单状态与校验逻辑，供 <ChannelForm>（创建/独立编辑弹窗）与
 * <PodEditForm>（Pod 合并编辑弹窗）复用。
 */
export function useChannelForm({
  mode,
  initial,
  onSubmit,
}: {
  mode: "create" | "edit";
  initial?: ChannelInitial | null;
  onSubmit: Props["onSubmit"];
}) {
  const { t } = useTranslation();
  const editMode = mode === "edit";
  const [selected, setSelected] = useState<string[]>(initial?.channels ?? []);
  const [creds, setCreds] = useState<Record<string, Record<string, string>>>({});
  const [localErr, setLocalErr] = useState("");

  // Seed credentials from initial config in edit mode.
  useEffect(() => {
    if (editMode && initial?.channelConfigs) {
      const init: Record<string, Record<string, string>> = {};
      for (const [ch, cfg] of Object.entries(initial.channelConfigs)) {
        init[ch] = {};
        if (cfg.botId) init[ch].botId = cfg.botId;
        if (cfg.baseUrl) init[ch].baseUrl = cfg.baseUrl;
        if (cfg.allowPrivateNetwork === "true") init[ch].allowPrivateNetwork = "true";
        // secret stays empty — user fills to update, leaves empty to keep current
      }
      setCreds(init);
    }
  }, [editMode, initial]);

  function handleToggle(ch: string, checked: boolean) {
    setSelected(toggle(selected, ch, checked));
    if (checked && !creds[ch]) {
      setCreds((prev) => ({ ...prev, [ch]: {} }));
    }
  }

  function handleCredChange(ch: string, key: string, val: string) {
    setCreds((prev) => ({ ...prev, [ch]: { ...prev[ch], [key]: val } }));
  }

  function validate(): string {
    if (selected.length === 0) return t("channel.selectAtLeastOne");
    for (const ch of selected) {
      const def = CHANNEL_DEFS.find((d) => d.id === ch);
      if (!def) continue;
      for (const f of def.credentialFields) {
        const hasExistingSecret =
          editMode && f.type === "password" && initial?.channelConfigs?.[ch]?.secretConfigured;
        if (f.required && !hasExistingSecret && !(creds[ch]?.[f.key] ?? "").trim()) {
          return t("channel.fieldRequired", { label: `${t(def.label)}: ${t(f.label)}` });
        }
      }
    }
    return "";
  }

  function submit() {
    const msg = validate();
    if (msg) {
      setLocalErr(msg);
      return;
    }
    setLocalErr("");
    const channelConfigs: Record<string, ChannelCredential> = {};
    for (const ch of selected) {
      const config = { ...(creds[ch] ?? {}) } as ChannelCredential & Record<string, string>;
      for (const field of channelDef(ch)?.credentialFields ?? []) {
        if (field.type === "checkbox" && config[field.key] === undefined) {
          config[field.key] = "false";
        }
      }
      channelConfigs[ch] = config;
    }
    onSubmit({ channels: selected, channelConfigs });
  }

  return { selected, creds, localErr, handleToggle, handleCredChange, submit };
}

export type ChannelFormState = ReturnType<typeof useChannelForm>;

/** 通道勾选与凭据输入区，纯展示（状态与校验在 useChannelForm）。 */
export function ChannelFields({
  form,
  initial,
  editMode,
  t,
}: {
  form: ChannelFormState;
  initial?: ChannelInitial | null;
  editMode: boolean;
  t: TFunction;
}) {
  return (
    <div>
      <Text className={styles.label} type="tertiary" size="small">
        {t("channel.messageChannels")}
      </Text>
      {CHANNEL_DEFS.map((def) => {
        const isSelected = form.selected.includes(def.id);
        const existing = initial?.channelConfigs?.[def.id];
        return (
          <div className={styles.channelItem} key={def.id}>
            <Checkbox
              checked={isSelected}
              onChange={(e) => form.handleToggle(def.id, (e.target as HTMLInputElement).checked)}
            >
              {def.icon} {t(def.label)}
              {editMode && existing?.secretConfigured !== undefined && (
                <span className={styles.channelMeta}>
                  {existing.secretConfigured ? `· ${t("channel.configured")}` : ""}
                </span>
              )}
            </Checkbox>
            {isSelected && (
              <ChannelCredentialFields
                channelDef={def}
                values={form.creds[def.id] ?? {}}
                existingConfig={existing}
                editMode={editMode}
                onChange={(key, val) => form.handleCredChange(def.id, key, val)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ChannelForm({
  mode,
  initial,
  busy,
  error,
  errorDetail,
  onSubmit,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const form = useChannelForm({ mode, initial, onSubmit });
  const displayErr = error || form.localErr;

  return (
    <div className={styles.form}>
      {displayErr && <Banner type="danger" description={displayErr} fullMode={false} bordered />}
      <ErrorDetail detail={errorDetail} />
      <ChannelFields form={form} initial={initial} editMode={mode === "edit"} t={t} />
      <Space className={styles.actions}>
        <Button onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button theme="solid" loading={busy} disabled={busy} onClick={form.submit}>
          {mode === "create" ? t("common.create") : t("common.save")}
        </Button>
      </Space>
    </div>
  );
}

/** Renders credential input fields for one channel based on its ChannelDef. */
function ChannelCredentialFields({
  channelDef,
  values,
  existingConfig,
  editMode,
  onChange,
}: {
  channelDef: ChannelDef;
  values: Record<string, string>;
  existingConfig?: {
    botId?: string;
    secretConfigured?: boolean;
    lastUpdated?: string;
    [k: string]: unknown;
  } | null;
  editMode: boolean;
  onChange: (key: string, val: string) => void;
}) {
  const { t } = useTranslation();
  if (channelDef.credentialFields.length === 0) {
    return <p className={styles.hint}>{channelDef.hint ? t(channelDef.hint) : ""}</p>;
  }
  return (
    <div className={styles.credentials}>
      {channelDef.credentialFields.map((f) => {
        const isSecret = f.type === "password";
        const isCheckbox = f.type === "checkbox";
        const existingVal = (existingConfig?.[f.key] ?? undefined) as string | undefined;
        const hasExisting = editMode && existingVal && existingVal !== "";
        const isSecretConfigured = editMode && isSecret && existingConfig?.secretConfigured;
        if (isCheckbox) {
          return (
            <div key={f.key}>
              <Checkbox
                checked={values[f.key] === "true"}
                onChange={(e) =>
                  onChange(f.key, (e.target as HTMLInputElement).checked ? "true" : "false")
                }
              >
                {t(f.label)}
              </Checkbox>
              {f.help && <p className={styles.hint}>{t(f.help)}</p>}
            </div>
          );
        }
        return (
          <div key={f.key}>
            <label className={styles.credentialLabel}>
              {t(f.label)}
              {hasExisting && !isSecretConfigured && (
                <span className={styles.configured}>{t("channel.configured")}</span>
              )}
              {isSecretConfigured && (
                <span className={styles.secretMeta}>
                  · {t("channel.lastUpdated")}:{" "}
                  {existingConfig?.lastUpdated
                    ? new Date(existingConfig.lastUpdated).toLocaleDateString()
                    : "—"}
                </span>
              )}
            </label>
            <Input
              type={isSecret ? "password" : "text"}
              value={values[f.key] ?? ""}
              onChange={(v) => onChange(f.key, v)}
              placeholder={
                isSecretConfigured ? t("channel.placeholder.keepSecret") : t(f.placeholder)
              }
            />
            {f.help && <p className={styles.hint}>{t(f.help)}</p>}
          </div>
        );
      })}
    </div>
  );
}
