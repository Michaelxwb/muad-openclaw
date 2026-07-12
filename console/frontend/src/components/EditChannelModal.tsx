import { useEffect, useState } from "react";
import { Modal, Toast } from "@douyinfe/semi-ui";
import { api } from "../api";
import type { ChannelConfigView, ChannelCredential } from "../api";
import { ChannelForm } from "./ChannelForm";

interface Props {
  podId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export function EditChannelModal({ podId, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [initial, setInitial] = useState<{
    channels: string[];
    channelConfigs: Record<string, ChannelConfigView>;
  } | null>(null);

  useEffect(() => {
    if (!podId) return;
    setLoading(true);
    setError("");
    api
      .getPod(podId)
      .then((data) =>
        setInitial({
          channels: data.channels,
          channelConfigs: data.channelConfigs ?? {},
        }),
      )
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [podId]);

  async function handleSubmit(v: {
    channels: string[];
    channelConfigs: Record<string, ChannelCredential>;
  }) {
    if (!podId) return;
    setBusy(true);
    setError("");
    try {
      await api.updatePodChannels(podId, v);
      Toast.success("通道配置已更新");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`编辑 ${podId ?? ""} 的消息通道`}
      visible={podId !== null}
      onCancel={onClose}
      footer={null}
      width={520}
    >
      {loading ? (
        <p className="hint">加载中…</p>
      ) : error && !initial ? (
        <p style={{ color: "var(--semi-color-danger)" }}>{error}</p>
      ) : initial ? (
        <ChannelForm
          mode="edit"
          initial={initial}
          busy={busy}
          error={error}
          onSubmit={handleSubmit}
          onCancel={onClose}
        />
      ) : null}
    </Modal>
  );
}
