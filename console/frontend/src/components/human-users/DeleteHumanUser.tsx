import { useState } from "react";
import { Button, Modal, Toast } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import type { HumanUser } from "../../api";
import { FeedbackBanner } from "../ConsolePage";
import { errorMessage } from "../../utils/error";
import styles from "../HumanUsersPanel.module.css";

interface Props {
  user: HumanUser;
  onDeleted: () => void;
  compact?: boolean;
}

export function DeleteHumanUser({ user, onDeleted, compact = false }: Props) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api.deleteHumanUser(user.humanUserId);
      Toast.success(t("user.deleteStarted"));
      setVisible(false);
      onDeleted();
    } catch (caught) {
      setError(errorMessage(caught, "user.deleteUserFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        aria-label={t("user.deleteUserAria", { name: user.displayName })}
        size={compact ? "small" : "default"}
        type="danger"
        onClick={() => setVisible(true)}
      >
        {t("common.delete")}
      </Button>
      <Modal
        className="standard-modal"
        title={t("user.deleteUserTitle", { name: user.displayName })}
        visible={visible}
        onCancel={() => setVisible(false)}
        onOk={() => void remove()}
        okText={t("common.confirmDelete")}
        confirmLoading={busy}
        okButtonProps={{ type: "danger" as const }}
      >
        <FeedbackBanner error={error} />
        <div>{t("user.deleteCleansUp")}</div>
        <ul className={styles.dangerList}>
          <li>{t("user.deleteItemWorkspace")}</li>
          <li>{t("user.deleteItemBrowser")}</li>
          <li>{t("user.deleteItemSession")}</li>
          <li>{t("user.deleteItemIdentity")}</li>
        </ul>
      </Modal>
    </>
  );
}
