import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Descriptions, Modal, Spin, TabPane, Tabs } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import type { HumanUserDetail, Pod } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { FeedbackBanner } from "../ConsolePage";
import { errorMessage } from "../../utils/error";
import { BasicUserForm } from "./BasicUserForm";
import { BindingCodeManager } from "./BindingCodeManager";
import { IdentityManager } from "./IdentityManager";
import { HumanUserSkillsTab } from "./HumanUserSkillsTab";
import { PlatformCredentialManager } from "./PlatformCredentialManager";
import styles from "../HumanUsersPanel.module.css";

const BASIC_FORM_ID = "human-user-basic-form";
const DETAIL_DIALOG_WIDTH = 1120;

interface Props {
  pod: Pod;
  humanUserId: string | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

function useHumanUserDetail(humanUserId: string | null) {
  const [detail, setDetail] = useState<HumanUserDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!humanUserId) return;
    const requestId = ++requestRef.current;
    if (mountedRef.current) {
      setLoading(true);
      setError("");
    }
    try {
      const result = await api.getHumanUser(humanUserId);
      if (mountedRef.current && requestId === requestRef.current) setDetail(result);
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(errorMessage(caught, "user.loadDetailFailed"));
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [humanUserId, mountedRef]);

  useEffect(() => {
    setDetail(null);
    if (humanUserId) void refresh();
  }, [humanUserId, refresh]);

  return { detail, loading, error, refresh };
}

export function HumanUserDetailDialog(props: Props) {
  const { t } = useTranslation();
  const state = useHumanUserDetail(props.humanUserId);
  const [basicBusy, setBasicBusy] = useState(false);
  const changed = async () => {
    await Promise.all([state.refresh(), props.onChanged()]);
  };
  return (
    <Modal
      className={`standard-modal ${styles.detailDialog}`}
      title={t("user.detailTitle", { name: state.detail?.humanUser.displayName ?? "" })}
      visible={props.humanUserId !== null}
      onCancel={props.onClose}
      footer={
        <div className={styles.detailFooter}>
          <Button
            theme="solid"
            htmlType="submit"
            form={BASIC_FORM_ID}
            loading={basicBusy}
            disabled={!state.detail || state.loading}
          >
            {t("common.save")}
          </Button>
        </div>
      }
      width={DETAIL_DIALOG_WIDTH}
    >
      <FeedbackBanner error={state.error} />
      {state.loading && !state.detail ? (
        <Spin />
      ) : (
        state.detail && (
          <DetailContent
            detail={state.detail}
            pod={props.pod}
            onChanged={changed}
            onBasicBusyChange={setBasicBusy}
          />
        )
      )}
    </Modal>
  );
}

function DetailContent({
  detail,
  pod,
  onChanged,
  onBasicBusyChange,
}: {
  detail: HumanUserDetail;
  pod: Pod;
  onChanged: () => Promise<void>;
  onBasicBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <RuntimeMetadata detail={detail} />
      <Tabs type="line" defaultActiveKey="basic" tabPaneMotion={false}>
        <TabPane tab={t("user.tabBasic")} itemKey="basic">
          <BasicUserForm
            user={detail.humanUser}
            onSaved={onChanged}
            formId={BASIC_FORM_ID}
            onBusyChange={onBasicBusyChange}
          />
        </TabPane>
        <TabPane tab={t("user.identity")} itemKey="identity">
          <IdentityManager
            user={detail.humanUser}
            identities={detail.identities}
            channels={pod.channels}
            onChanged={onChanged}
          />
        </TabPane>
        <TabPane tab={t("user.tabBindingCodes")} itemKey="binding-code">
          <BindingCodeManager
            user={detail.humanUser}
            channels={pod.channels}
            identities={detail.identities}
            channelDefaultAccountIds={pod.channelDefaultAccountIds}
          />
        </TabPane>
        <TabPane tab={t("user.platformCredentials")} itemKey="platform-credential">
          <PlatformCredentialManager user={detail.humanUser} />
        </TabPane>
        <TabPane tab="Skill" itemKey="skills">
          <HumanUserSkillsTab user={detail.humanUser} onChanged={onChanged} />
        </TabPane>
      </Tabs>
    </>
  );
}

function RuntimeMetadata({ detail }: { detail: HumanUserDetail }) {
  const { t } = useTranslation();
  const user = detail.humanUser;
  const items = [
    { key: t("user.id"), value: user.humanUserId },
    { key: t("user.runningAgent"), value: user.agentId },
    { key: t("user.browserConfig"), value: user.browserProfile },
    { key: t("user.browserPort"), value: user.browserCdpPort },
    { key: t("user.boundIdentityCount"), value: detail.identities.length },
  ];
  return <Descriptions className={styles.detailSummary} data={items} row size="small" column={5} />;
}
