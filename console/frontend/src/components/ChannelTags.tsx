import { Tag } from "@douyinfe/semi-ui";
import type { Pod } from "../api";
import { channelMeta } from "../channels";

type Props = {
  pod: Pod;
};

/**
 * 在容器列表的「消息通道」列渲染一组 Tag：
 *   🟢 green = 通道已连接
 *   🔴 red   = 通道已配置但未连接（probe 缺失则降级为 ⚪ grey）
 */
export function ChannelTags({ pod }: Props) {
  const chs = pod.channels.length ? pod.channels : [];
  if (!chs.length) {
    return <span style={{ color: "var(--semi-color-text-2)" }}>—</span>;
  }
  return (
    <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {chs.map((ch) => {
        const meta = channelMeta(ch);
        const status = pod.channelStatuses?.[ch];
        const color: "green" | "red" | "grey" =
          status === undefined ? "grey" : status ? "green" : "red";
        return (
          <Tag key={ch} color={color} size="small">
            {meta.icon} {meta.label}
          </Tag>
        );
      })}
    </span>
  );
}
