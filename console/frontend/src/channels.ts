import i18n from "./i18n";
import { Channel } from "./api";

// --- Channel definition registry ---
// Add new channels by appending to CHANNEL_DEFS — no code changes needed elsewhere.
// label / placeholder / help / hint 存 i18n key（或英文原文），展示处经 i18n.t() 解析。

export interface CredentialField {
  key: string;
  label: string; // i18n key（如 channel.field.botToken）或英文原文
  type: "text" | "password" | "checkbox";
  required: boolean;
  placeholder: string; // i18n key 或英文原文
  help?: string; // i18n key
}

export interface ChannelDef {
  id: Channel;
  label: string; // i18n key（channel.wecom / channel.wechat）或英文原文（Mattermost）
  icon: string;
  credentialFields: CredentialField[];
  hint?: string; // i18n key，展示在无凭证通道（如微信扫码登录）
}

export const CHANNEL_DEFS: ChannelDef[] = [
  {
    id: "wecom",
    label: "channel.wecom",
    icon: "🏢",
    credentialFields: [
      { key: "botId", label: "Bot ID", type: "text", required: true, placeholder: "aib…" },
      {
        key: "secret",
        label: "Secret",
        type: "password",
        required: true,
        placeholder: "channel.placeholder.secret",
      },
    ],
  },
  {
    id: "wechat",
    label: "channel.wechat",
    icon: "💬",
    credentialFields: [],
    hint: "channel.hint.wechat",
  },
  {
    id: "mattermost",
    label: "Mattermost",
    icon: "M",
    credentialFields: [
      {
        key: "baseUrl",
        label: "Mattermost URL",
        type: "text",
        required: true,
        placeholder: "channel.placeholder.mattermostUrl",
      },
      {
        key: "botToken",
        label: "channel.field.botToken",
        type: "password",
        required: true,
        placeholder: "channel.placeholder.botToken",
      },
      {
        key: "allowPrivateNetwork",
        label: "channel.field.allowPrivateNetwork",
        type: "checkbox",
        required: false,
        placeholder: "",
        help: "channel.help.allowPrivateNetwork",
      },
    ],
  },
];

// --- Legacy helpers — kept for migration compatibility ---

/** Legacy channel option list for dropdowns and filters. */
export const CHANNELS: { value: Channel; label: string; icon: string }[] = CHANNEL_DEFS.map(
  (d) => ({ value: d.id, label: d.label, icon: d.icon }),
);

/** Lookup display metadata by channel id（label 已解析为展示字符串）。 */
export function channelMeta(channel: string) {
  const found = CHANNELS.find((c) => c.value === channel);
  if (found) {
    return { value: found.value, label: i18n.t(found.label), icon: found.icon };
  }
  return { value: channel as Channel, label: channel || i18n.t("channel.unknown"), icon: "?" };
}

/** Lookup full channel definition by channel id. */
export function channelDef(channel: string): ChannelDef | undefined {
  return CHANNEL_DEFS.find((d) => d.id === channel);
}
