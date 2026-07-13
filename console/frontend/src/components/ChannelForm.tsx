import { useState, useEffect } from "react";
import { Banner, Button, Checkbox, Input, Space, Typography } from "@douyinfe/semi-ui";
import { CHANNEL_DEFS, ChannelDef } from "../channels";
import { ChannelCredential } from "../api";
import styles from "./ChannelForm.module.css";

const { Text } = Typography;

interface Props {
  mode: "create" | "edit";
  initial?: {
    channels: string[];
    channelConfigs: Record<
      string,
      { botId?: string; secretConfigured?: boolean; lastUpdated?: string }
    >;
  } | null;
  busy: boolean;
  error: string;
  onSubmit: (v: { channels: string[]; channelConfigs: Record<string, ChannelCredential> }) => void;
  onCancel: () => void;
}

/** Toggle a channel in the selected set. */
function toggle(arr: string[], id: string, on: boolean): string[] {
  return on ? [...arr, id] : arr.filter((c) => c !== id);
}

export function ChannelForm({ mode, initial, busy, error, onSubmit, onCancel }: Props) {
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
    if (selected.length === 0) return "至少选择一个通道";
    for (const ch of selected) {
      const def = CHANNEL_DEFS.find((d) => d.id === ch);
      if (!def) continue;
      if (editMode && initial?.channelConfigs?.[ch]?.secretConfigured) {
        // In edit mode, existing credentials are already configured — skip required check.
        continue;
      }
      for (const f of def.credentialFields) {
        if (f.required && !(creds[ch]?.[f.key] ?? "").trim()) {
          return `${def.label}: ${f.label} 必填`;
        }
      }
    }
    return "";
  }

  function handleSubmit() {
    const msg = validate();
    if (msg) {
      setLocalErr(msg);
      return;
    }
    setLocalErr("");
    const channelConfigs: Record<string, ChannelCredential> = {};
    for (const ch of selected) {
      channelConfigs[ch] = creds[ch] ?? {};
    }
    onSubmit({ channels: selected, channelConfigs });
  }

  const displayErr = error || localErr;

  return (
    <div className={styles.form}>
      {displayErr && <Banner type="danger" description={displayErr} fullMode={false} bordered />}
      <div>
        <Text className={styles.label} type="tertiary" size="small">
          消息通道
        </Text>
        {CHANNEL_DEFS.map((def) => {
          const isSelected = selected.includes(def.id);
          const existing = initial?.channelConfigs?.[def.id];
          return (
            <div className={styles.channelItem} key={def.id}>
              <Checkbox
                checked={isSelected}
                onChange={(e) => handleToggle(def.id, (e.target as HTMLInputElement).checked)}
              >
                {def.icon} {def.label}
                {editMode && existing?.secretConfigured !== undefined && (
                  <span className={styles.channelMeta}>
                    {existing.secretConfigured ? "· 已配置" : ""}
                  </span>
                )}
              </Checkbox>
              {isSelected && (
                <ChannelCredentialFields
                  channelDef={def}
                  values={creds[def.id] ?? {}}
                  existingConfig={existing}
                  editMode={editMode}
                  onChange={(key, val) => handleCredChange(def.id, key, val)}
                />
              )}
            </div>
          );
        })}
      </div>
      <Space className={styles.actions}>
        <Button onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button theme="solid" loading={busy} disabled={busy} onClick={handleSubmit}>
          {mode === "create" ? "创建" : "保存"}
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
  if (channelDef.credentialFields.length === 0) {
    return <p className={styles.hint}>{channelDef.hint}</p>;
  }
  return (
    <div className={styles.credentials}>
      {channelDef.credentialFields.map((f) => {
        const isSecret = f.type === "password";
        const existingVal = (existingConfig?.[f.key] ?? undefined) as string | undefined;
        const hasExisting = editMode && existingVal && existingVal !== "";
        const isSecretConfigured = editMode && isSecret && existingConfig?.secretConfigured;
        return (
          <div key={f.key}>
            <label className={styles.credentialLabel}>
              {f.label}
              {hasExisting && !isSecretConfigured && (
                <span className={styles.configured}>已配置</span>
              )}
              {isSecretConfigured && (
                <span className={styles.secretMeta}>
                  · 上次更新:{" "}
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
              placeholder={isSecretConfigured ? "留空则保持当前 secret" : f.placeholder}
            />
          </div>
        );
      })}
    </div>
  );
}
