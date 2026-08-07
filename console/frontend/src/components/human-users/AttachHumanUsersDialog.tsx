import { useState } from "react";
import { Checkbox, Modal, Select, Toast } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import type { Pod } from "../../api";
import { FeedbackBanner } from "../ConsolePage";
import { errorMessage } from "../../utils/error";

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
  const { t } = useTranslation();
  const [podId, setPodId] = useState("");
  const [confirmNoMemory, setConfirmNoMemory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!podId) {
      setError(t("user.selectTargetPod"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.attachHumanUsers(podId, { humanUserIds, confirmNoMemory });
      Toast.success(t("user.attachedToPod"));
      await onAttached();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught, "user.attachFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      className="standard-modal"
      title={t("user.attachTitle")}
      visible
      onCancel={onClose}
      onOk={() => void submit()}
      okText={t("user.bind")}
      confirmLoading={busy}
    >
      <FeedbackBanner error={error} />
      <div>{t("user.attachConfirmCount", { count: humanUserIds.length })}</div>
      <div className="field-block" style={{ marginTop: 12 }}>
        <Select
          placeholder={t("user.selectPod")}
          value={podId}
          optionList={pods.map((pod) => ({
            value: pod.podId,
            label: t("user.podOptionLabel", { name: pod.displayName, podId: pod.podId }),
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
          {t("user.attachNoMemory")}
        </Checkbox>
      </div>
    </Modal>
  );
}
