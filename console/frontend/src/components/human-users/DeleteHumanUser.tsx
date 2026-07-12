import { useState } from "react";
import { Button, Modal, Toast } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type { HumanUser } from "../../api";
import { FeedbackBanner } from "../ConsolePage";
import styles from "../HumanUsersPanel.module.css";

interface Props {
  user: HumanUser;
  onDeleted: () => void;
}

export function DeleteHumanUser({ user, onDeleted }: Props) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api.deleteHumanUser(user.humanUserId);
      Toast.success("用户已进入删除流程");
      setVisible(false);
      onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除用户失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 20, paddingTop: 14, borderTop: "1px solid var(--semi-color-border)" }}>
      <Button type="danger" onClick={() => setVisible(true)}>
        删除 Human User
      </Button>
      <Modal
        title={`删除 ${user.displayName}`}
        visible={visible}
        onCancel={() => setVisible(false)}
        onOk={() => void remove()}
        okText="确认删除"
        confirmLoading={busy}
        okButtonProps={{ type: "danger" as const }}
      >
        <FeedbackBanner error={error} />
        <div>删除调和完成后将清理：</div>
        <ul className={styles.dangerList}>
          <li>用户 workspace 与 private Skill</li>
          <li>Browser Profile 与浏览器状态</li>
          <li>会话、记忆和 session-manager 凭证缓存</li>
          <li>该用户全部 IM Identity 和平台凭证</li>
        </ul>
      </Modal>
    </div>
  );
}
