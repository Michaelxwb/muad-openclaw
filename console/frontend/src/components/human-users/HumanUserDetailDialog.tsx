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
import { UserModelForm } from "./UserModelForm";

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
  const changed = async () => {
    await Promise.all([state.refresh(), props.onChanged()]);
  };
  return (
    <Modal
      title={`Human User ${state.detail?.humanUser.displayName ?? ""}`}
      visible={props.humanUserId !== null}
      onCancel={props.onClose}
      footer={<Button onClick={props.onClose}>关闭</Button>}
      width={720}
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
            onDeleted={props.onDeleted}
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
  onDeleted,
}: {
  detail: HumanUserDetail;
  channels: string[];
  onChanged: () => Promise<void>;
  onDeleted: () => void;
}) {
  return (
    <>
      <RuntimeMetadata detail={detail} />
      <Tabs type="line" defaultActiveKey="basic">
        <TabPane tab="基本信息" itemKey="basic">
          <BasicUserForm user={detail.humanUser} onSaved={onChanged} />
        </TabPane>
        <TabPane tab="模型覆写" itemKey="model">
          <UserModelForm user={detail.humanUser} onSaved={onChanged} />
        </TabPane>
        <TabPane tab="Identity" itemKey="identity">
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
      <DeleteHumanUser user={detail.humanUser} onDeleted={onDeleted} />
    </>
  );
}

function RuntimeMetadata({ detail }: { detail: HumanUserDetail }) {
  const user = detail.humanUser;
  return (
    <Descriptions
      size="small"
      row
      data={[
        { key: "Human User ID", value: user.humanUserId },
        { key: "Agent ID", value: user.agentId },
        { key: "Browser Profile", value: user.browserProfile },
        { key: "Browser CDP", value: user.browserCdpPort },
        { key: "Identity 数量", value: detail.identities.length },
      ]}
    />
  );
}
