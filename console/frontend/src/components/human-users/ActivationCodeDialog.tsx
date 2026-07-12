import { useState } from "react";
import { Button, Modal, Toast } from "@douyinfe/semi-ui";
import { IconCopy } from "@douyinfe/semi-icons";
import type { HumanUserActivation } from "../../api";
import { FeedbackBanner } from "../ConsolePage";
import styles from "../HumanUsersPanel.module.css";

interface Props {
  activation: HumanUserActivation | null;
  onClose: () => void;
}

export function ActivationCodeDialog({ activation, onClose }: Props) {
  const [error, setError] = useState("");
  const copy = async () => {
    if (!activation) return;
    try {
      if (!navigator.clipboard) throw new Error("浏览器不支持剪贴板");
      await navigator.clipboard.writeText(activation.code);
      Toast.success("绑定码已复制");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "复制失败");
    }
  };
  return (
    <Modal
      title="一次性绑定码"
      visible={activation !== null}
      onCancel={onClose}
      onOk={onClose}
      okText="我已保存"
      cancelButtonProps={{ style: { display: "none" } }}
    >
      <FeedbackBanner error={error} />
      <p>
        明文绑定码仅在此处显示一次，有效期至{" "}
        {activation ? new Date(activation.expiresAt).toLocaleString() : ""}。
      </p>
      <div className={styles.codeBox}>
        <span className={styles.code}>{activation?.code}</span>
        <Button aria-label="复制绑定码" icon={<IconCopy />} onClick={() => void copy()} />
      </div>
    </Modal>
  );
}
