import { useState, useEffect } from "react";
import { Checkbox, Input } from "@douyinfe/semi-ui";
import { CHANNEL_DEFS, ChannelDef } from "../channels";
import { ChannelCredential } from "../api";

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
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {displayErr && (
        <p style={{ color: "var(--semi-color-danger)", fontSize: 13, margin: 0 }}>{displayErr}</p>
      )}
      <div>
        <label
          style={{
            fontSize: 12,
            color: "var(--semi-color-text-2)",
            marginBottom: 8,
            display: "block",
          }}
        >
          消息通道
        </label>
        {CHANNEL_DEFS.map((def) => {
          const isSelected = selected.includes(def.id);
          const existing = initial?.channelConfigs?.[def.id];
          return (
            <div key={def.id} style={{ marginBottom: 8 }}>
              <Checkbox
                checked={isSelected}
                onChange={(e) => handleToggle(def.id, (e.target as HTMLInputElement).checked)}
              >
                {def.icon} {def.label}
                {editMode && existing?.secretConfigured !== undefined && (
                  <span style={{ fontSize: 11, color: "var(--semi-color-text-2)", marginLeft: 8 }}>
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
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          className="semi-button semi-button-default"
          onClick={onCancel}
          disabled={busy}
        >
          取消
        </button>
        <button
          type="button"
          className="semi-button semi-button-primary"
          onClick={handleSubmit}
          disabled={busy}
        >
          {busy ? "提交中…" : mode === "create" ? "创建" : "保存"}
        </button>
      </div>
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
    return (
      <p
        className="hint"
        style={{ margin: "4px 0 0 28px", fontSize: 12, color: "var(--semi-color-text-2)" }}
      >
        {channelDef.hint}
      </p>
    );
  }
  return (
    <div
      style={{
        marginLeft: 28,
        paddingLeft: 12,
        borderLeft: "2px solid var(--semi-color-border)",
        marginTop: 4,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {channelDef.credentialFields.map((f) => {
        const isSecret = f.type === "password";
        const existingVal = (existingConfig?.[f.key] ?? undefined) as string | undefined;
        const hasExisting = editMode && existingVal && existingVal !== "";
        const isSecretConfigured = editMode && isSecret && existingConfig?.secretConfigured;
        return (
          <div key={f.key}>
            <label style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>
              {f.label}
              {hasExisting && !isSecretConfigured && (
                <span style={{ marginLeft: 4, fontSize: 11, color: "var(--semi-color-success)" }}>
                  已配置
                </span>
              )}
              {isSecretConfigured && (
                <span style={{ marginLeft: 4, fontSize: 11, color: "var(--semi-color-text-2)" }}>
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
