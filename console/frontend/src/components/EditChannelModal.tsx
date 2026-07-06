import { useEffect, useState } from "react";
import { Modal, Toast } from "@douyinfe/semi-ui";
import { api, ChannelCredential } from "../api";
import { ChannelForm } from "./ChannelForm";

interface Props {
  userId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export function EditChannelModal({ userId, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [initial, setInitial] = useState<{
    channels: string[];
    channelConfigs: Record<
      string,
      { botId?: string; secretConfigured: boolean; lastUpdated?: string }
    >;
  } | null>(null);

  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    setError("");
    api
      .getContainer(userId)
      .then((data) =>
        setInitial({
          channels: data.channels || [],
          channelConfigs: data.channelConfigs as Record<
            string,
            { botId?: string; secretConfigured: boolean; lastUpdated?: string }
          >,
        }),
      )
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [userId]);

  async function handleSubmit(v: {
    channels: string[];
    channelConfigs: Record<string, ChannelCredential>;
  }) {
    if (!userId) return;
    setBusy(true);
    setError("");
    try {
      await api.updateChannels(userId, v);
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
      title={`编辑 ${userId ?? ""} 的消息通道`}
      visible={userId !== null}
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
