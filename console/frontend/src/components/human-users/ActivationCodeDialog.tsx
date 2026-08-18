import { useState } from "react";
import { Button, Modal, Toast } from "@douyinfe/semi-ui";
import { IconCopy } from "@douyinfe/semi-icons";
import { useTranslation } from "react-i18next";
import type { HumanUserActivation } from "../../api";
import { FeedbackBanner } from "../ConsolePage";
import { errorMessage } from "../../utils/error";
import { copyText } from "../../utils/clipboard";
import styles from "../HumanUsersPanel.module.css";

interface Props {
  activation: HumanUserActivation | null;
  onClose: () => void;
}

export function ActivationCodeDialog({ activation, onClose }: Props) {
  const { t } = useTranslation();
  const [error, setError] = useState("");
  const copy = async () => {
    if (!activation) return;
    try {
      await copyText(activation.code);
      Toast.success(t("user.codeCopied"));
    } catch (caught) {
      setError(errorMessage(caught, "user.copyFailed"));
    }
  };
  return (
    <Modal
      className="standard-modal"
      title={t("user.activationTitle")}
      visible={activation !== null}
      onCancel={onClose}
      onOk={onClose}
      okText={t("user.activationSaved")}
      cancelButtonProps={{ style: { display: "none" } }}
    >
      <FeedbackBanner error={error} />
      <p>
        {t("user.activationHint", {
          date: activation ? new Date(activation.expiresAt).toLocaleString() : "",
        })}
      </p>
      <div className={styles.codeBox}>
        <span className={styles.code}>{activation?.code}</span>
        <Button aria-label={t("user.copyCode")} icon={<IconCopy />} onClick={() => void copy()} />
      </div>
    </Modal>
  );
}
