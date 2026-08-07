import { useTranslation } from "react-i18next";
import { Banner, Spin, TabPane, Tabs } from "@douyinfe/semi-ui";
import { HumanUsersPanel } from "../components/human-users/HumanUsersPanel";
import { ErrorDetail } from "../utils/error";
import styles from "./PodDetail.module.css";
import { PodActionPanel } from "./pod-detail/PodActionPanel";
import { DetailLoadFailure, PodDetailHeader } from "./pod-detail/PodDetailHeader";
import { ChannelTab, ConfigTab, ResourceTab } from "./pod-detail/PodDetailTabs";
import { usePodData } from "./pod-detail/usePodData";

interface Props {
  podId: string;
  onBack: () => void;
  onDeleted: () => void;
}

export function PodDetail({ podId, onBack, onDeleted }: Props) {
  const { t } = useTranslation();
  const detail = usePodData(podId);
  if (detail.loading && !detail.pod) return <Spin size="large" />;
  if (!detail.pod) {
    return (
      <DetailLoadFailure
        error={detail.error}
        detail={detail.errorDetail}
        onBack={onBack}
        onRetry={detail.refresh}
      />
    );
  }
  return (
    <div className={styles.page}>
      <PodDetailHeader pod={detail.pod} onBack={onBack} onRefresh={detail.refresh} />
      {detail.error && (
        <div>
          <Banner type="danger" description={detail.error} fullMode={false} bordered />
          <ErrorDetail detail={detail.errorDetail} />
        </div>
      )}
      <PodActionPanel pod={detail.pod} onChanged={detail.refresh} onDeleted={onDeleted} />
      <Tabs type="line" defaultActiveKey="users" keepDOM>
        <TabPane tab={t("pod.tabUsers")} itemKey="users">
          <HumanUsersPanel pod={detail.pod} onPodChanged={detail.refresh} />
        </TabPane>
        <TabPane tab={t("pod.tabChannels")} itemKey="channels">
          <ChannelTab pod={detail.pod} />
        </TabPane>
        <TabPane tab={t("pod.tabConfig")} itemKey="config">
          <ConfigTab pod={detail.pod} />
        </TabPane>
        <TabPane tab={t("pod.tabResources")} itemKey="resources">
          <ResourceTab resources={detail.resources} />
        </TabPane>
      </Tabs>
    </div>
  );
}
