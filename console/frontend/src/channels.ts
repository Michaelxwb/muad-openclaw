import { Channel } from "./api";

// --- Channel definition registry ---
// Add new channels by appending to CHANNEL_DEFS — no code changes needed elsewhere.

export interface CredentialField {
  key: string;
  label: string;
  type: "text" | "password";
  required: boolean;
  placeholder: string;
}

export interface ChannelDef {
  id: Channel;
  label: string;
  icon: string;
  credentialFields: CredentialField[];
  hint?: string; // shown for credential-less channels (e.g. WeChat QR login)
}

export const CHANNEL_DEFS: ChannelDef[] = [
  {
    id: "wecom",
    label: "企业微信",
    icon: "🏢",
    credentialFields: [
      { key: "botId", label: "Bot ID", type: "text", required: true, placeholder: "aib…" },
      {
        key: "secret",
        label: "Secret",
        type: "password",
        required: true,
        placeholder: "企业微信 secret",
      },
    ],
  },
  {
    id: "wechat",
    label: "微信",
    icon: "💬",
    credentialFields: [],
    hint: "无需凭证，创建后在列表点击「扫码」授权登录",
  },
];

// --- Legacy helpers — kept for migration compatibility ---

/** Legacy channel option list for dropdowns and filters. */
export const CHANNELS: { value: Channel; label: string; icon: string }[] = CHANNEL_DEFS.map(
  (d) => ({ value: d.id, label: d.label, icon: d.icon }),
);

/** Lookup display metadata by channel id. */
export function channelMeta(channel: string) {
  return (
    CHANNELS.find((c) => c.value === channel) ?? {
      value: channel as Channel,
      label: channel || "未知通道",
      icon: "?",
    }
  );
}

/** Lookup full channel definition by channel id. */
export function channelDef(channel: string): ChannelDef | undefined {
  return CHANNEL_DEFS.find((d) => d.id === channel);
}
