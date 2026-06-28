import { Channel } from "./api";

// Channel display metadata, shared by the create form and the list view.
export const CHANNELS: { value: Channel; label: string; icon: string }[] = [
  { value: "wecom", label: "企业微信", icon: "🏢" },
  { value: "wechat", label: "微信", icon: "💬" },
];

export function channelMeta(channel: string) {
  return CHANNELS.find((c) => c.value === channel) ?? CHANNELS[0];
}
