import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Descriptions, Modal, Spin, TabPane, Tabs } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type { HumanUserDetail, Pod } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { FeedbackBanner } from "../ConsolePage";
import { BasicUserForm } from "./BasicUserForm";
import { BindingCodeManager } from "./BindingCodeManager";
import { DeleteHumanUser } from "./DeleteHumanUser";
import { IdentityManager } from "./IdentityManager";
import { PlatformCredentialManager } from "./PlatformCredentialManager";
import styles from "../HumanUsersPanel.module.css";

const BASIC_FORM_ID = "human-user-basic-form";

interface Props {
  pod: Pod;
  humanUserId: string | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
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
      setError(caught instanceof Error ? caught.message : "加载用户详情失败");
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
  const state = useHumanUserDetail(props.humanUserId);
  const [basicBusy, setBasicBusy] = useState(false);
  const changed = async () => {
    await Promise.all([state.refresh(), props.onChanged()]);
  };
  return (
    <Modal
      className="standard-modal"
      title={`用户详情 ${state.detail?.humanUser.displayName ?? ""}`}
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
            保存
          </Button>
          {state.detail && (
            <DeleteHumanUser user={state.detail.humanUser} onDeleted={props.onDeleted} />
          )}
        </div>
      }
      width={760}
    >
      <FeedbackBanner error={state.error} />
      {state.loading && !state.detail ? (
        <Spin />
      ) : (
        state.detail && (
          <DetailContent
            detail={state.detail}
            channels={props.pod.channels}
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
  channels,
  onChanged,
  onBasicBusyChange,
}: {
  detail: HumanUserDetail;
  channels: string[];
  onChanged: () => Promise<void>;
  onBasicBusyChange: (busy: boolean) => void;
}) {
  return (
    <>
      <RuntimeMetadata detail={detail} />
      <Tabs type="line" defaultActiveKey="basic">
        <TabPane tab="基本信息" itemKey="basic">
          <BasicUserForm
            user={detail.humanUser}
            onSaved={onChanged}
            formId={BASIC_FORM_ID}
            onBusyChange={onBasicBusyChange}
          />
        </TabPane>
        <TabPane tab="身份标识" itemKey="identity">
          <IdentityManager
            user={detail.humanUser}
            identities={detail.identities}
            channels={channels}
            onChanged={onChanged}
          />
        </TabPane>
        <TabPane tab="绑定码" itemKey="binding-code">
          <BindingCodeManager user={detail.humanUser} channels={channels} />
        </TabPane>
        <TabPane tab="平台凭证" itemKey="platform-credential">
          <PlatformCredentialManager user={detail.humanUser} />
        </TabPane>
      </Tabs>
    </>
  );
}

function RuntimeMetadata({ detail }: { detail: HumanUserDetail }) {
  const user = detail.humanUser;
  const items = [
    { key: "用户 ID", value: user.humanUserId },
    { key: "运行 Agent", value: user.agentId },
    { key: "浏览器配置", value: user.browserProfile },
    { key: "浏览器端口", value: user.browserCdpPort },
    { key: "模型配置", value: `${user.modelConfig.provider}/${user.modelConfig.model}` },
    { key: "模型 Key", value: user.modelConfig.keyFingerprint || "已配置" },
    { key: "已绑定 IM 数", value: detail.identities.length },
  ];
  return <Descriptions className={styles.detailSummary} data={items} row size="small" column={2} />;
}
