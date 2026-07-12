import { Banner, Spin, TabPane, Tabs } from "@douyinfe/semi-ui";
import { HumanUsersPanel } from "../components/human-users/HumanUsersPanel";
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
  const detail = usePodData(podId);
  if (detail.loading && !detail.pod) return <Spin size="large" />;
  if (!detail.pod) {
    return <DetailLoadFailure error={detail.error} onBack={onBack} onRetry={detail.refresh} />;
  }
  return (
    <div className={styles.page}>
      <PodDetailHeader pod={detail.pod} onBack={onBack} onRefresh={detail.refresh} />
      {detail.error && (
        <Banner type="danger" description={detail.error} fullMode={false} bordered />
      )}
      <PodActionPanel pod={detail.pod} onChanged={detail.refresh} onDeleted={onDeleted} />
      <Tabs type="line" defaultActiveKey="users" keepDOM>
        <TabPane tab="用户" itemKey="users">
          <HumanUsersPanel pod={detail.pod} onPodChanged={detail.refresh} />
        </TabPane>
        <TabPane tab="通道" itemKey="channels">
          <ChannelTab pod={detail.pod} />
        </TabPane>
        <TabPane tab="配置" itemKey="config">
          <ConfigTab pod={detail.pod} />
        </TabPane>
        <TabPane tab="资源与并发" itemKey="resources">
          <ResourceTab resources={detail.resources} />
        </TabPane>
      </Tabs>
    </div>
  );
}
