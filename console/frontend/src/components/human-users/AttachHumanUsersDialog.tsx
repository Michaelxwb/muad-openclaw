import { useState } from "react";
import { Checkbox, Modal, Select, Toast } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type { Pod } from "../../api";
import { FeedbackBanner } from "../ConsolePage";

interface Props {
  humanUserIds: string[];
  pods: Pod[];
  onClose: () => void;
  onAttached: () => Promise<void>;
}

// AttachHumanUsersDialog binds a list of unbound users (their Pod was deleted)
// to a target Pod. Cross-Pod attach requires explicit acknowledgement because
// the target Pod's PVC has no memory or usage records for them.
export function AttachHumanUsersDialog({ humanUserIds, pods, onClose, onAttached }: Props) {
  const [podId, setPodId] = useState("");
  const [confirmNoMemory, setConfirmNoMemory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!podId) {
      setError("请选择目标 Pod");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.attachHumanUsers(podId, { humanUserIds, confirmNoMemory });
      Toast.success("已绑定到 Pod");
      await onAttached();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "绑定失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      className="standard-modal"
      title="绑定用户到 Pod"
      visible
      onCancel={onClose}
      onOk={() => void submit()}
      okText="绑定"
      confirmLoading={busy}
    >
      <FeedbackBanner error={error} />
      <div>将 {humanUserIds.length} 个未绑定用户绑定到目标 Pod。</div>
      <div className="field-block" style={{ marginTop: 12 }}>
        <Select
          placeholder="选择目标 Pod"
          value={podId}
          optionList={pods.map((pod) => ({
            value: pod.podId,
            label: `${pod.displayName}（${pod.podId}）`,
          }))}
          onChange={(value) => setPodId(String(value ?? ""))}
          style={{ width: "100%" }}
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <Checkbox
          checked={confirmNoMemory}
          onChange={(event) => setConfirmNoMemory(Boolean(event.target.checked))}
        >
          目标 Pod 无这些用户的记忆与使用记录（跨 Pod 迁移）
        </Checkbox>
      </div>
    </Modal>
  );
}
