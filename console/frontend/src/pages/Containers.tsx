import { useState } from "react";
import { Toast } from "@douyinfe/semi-ui";
import { api } from "../api";
import type { Pod, PodAction } from "../api";
import { FeedbackBanner, PageHeader } from "../components/ConsolePage";
import { EditChannelModal } from "../components/EditChannelModal";
import { Pagination } from "../components/Pagination";
import { useMountedRef } from "../hooks/useMountedRef";
import { PodDetail } from "./PodDetail";
import { ContainersToolbar } from "./containers/ContainersToolbar";
import { CreatePodDialog } from "./containers/CreatePodDialog";
import { PodResourceDialog } from "./containers/PodResourceDialog";
import { PodTable } from "./containers/PodTable";
import { PodUpgradeDialog } from "./containers/PodUpgradeDialog";
import { usePodList } from "./containers/usePodList";
import { PodLogDialog, PodQrDialog } from "./pod-detail/PodActionDialogs";

export function Containers() {
  const state = useContainersController();
  if (state.dialogs.detailPodId) {
    return (
      <PodDetail
        podId={state.dialogs.detailPodId}
        onBack={() => state.dialogs.setDetailPodId(null)}
        onDeleted={() => void state.detailDeleted()}
      />
    );
  }
  return <PodListView state={state} />;
}

function useContainersController() {
  const dialogs = useListDialogs();
  const list = usePodList({ enabled: dialogs.detailPodId === null });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const mountedRef = useMountedRef();
  const runAction = async (podId: string, action: PodAction) => {
    try {
      await api.action(podId, action);
      if (!mountedRef.current) return;
      Toast.success(`Pod ${action} 已完成`);
      await list.refresh();
    } catch (caught) {
      if (mountedRef.current)
        Toast.error(caught instanceof Error ? caught.message : "Pod 操作失败");
    }
  };
  const reloadSkills = async () => {
    if (selectedIds.length === 0) return;
    try {
      await api.reloadSkills(selectedIds);
      Toast.success(`已触发 ${selectedIds.length} 个 Pod Skill 重载`);
      await list.refresh();
    } catch (caught) {
      Toast.error(caught instanceof Error ? caught.message : "Skill 重载失败");
    }
  };
  const detailDeleted = async () => {
    dialogs.setDetailPodId(null);
    await list.refresh();
  };
  const created = async (pod: Pod) => {
    dialogs.setCreateOpen(false);
    Toast.success(`Pod ${pod.podId} 创建成功`);
    if (list.page === 1) await list.refresh();
    else list.setPage(1);
  };
  return {
    list,
    dialogs,
    selectedIds,
    setSelectedIds,
    runAction,
    reloadSkills,
    detailDeleted,
    created,
  };
}

type ContainersState = ReturnType<typeof useContainersController>;

function PodListView({ state }: { state: ContainersState }) {
  const { list, dialogs } = state;
  return (
    <div>
      <PageHeader title="Pod 管理" description="管理运行实例、用户容量、消息通道和运行状态" />
      <FeedbackBanner error={list.error} />
      <ContainersToolbar
        state={list}
        selectedIds={state.selectedIds}
        onCreate={() => dialogs.setCreateOpen(true)}
        onReloadSkills={() => void state.reloadSkills()}
        onBatchUpgrade={() => dialogs.setUpgradeIds(state.selectedIds)}
        onBatchDelete={() => {
          state.setSelectedIds([]);
          void list.refresh();
        }}
      />
      <PodTable
        items={list.items}
        loading={list.loading}
        selectedIds={state.selectedIds}
        onSelected={state.setSelectedIds}
        onDetail={dialogs.setDetailPodId}
        onLogs={dialogs.setLogPodId}
        onQr={dialogs.setQrPodId}
        onChannels={dialogs.setEditPodId}
        onResources={dialogs.setResourcePod}
        onAction={(podId, action) => void state.runAction(podId, action)}
      />
      <PodListPagination state={state} />
      <ListDialogs state={dialogs} onCreated={state.created} onRefresh={list.refresh} />
    </div>
  );
}

function PodListPagination({ state }: { state: ContainersState }) {
  const { list } = state;
  return (
    <Pagination
      page={list.page}
      pageSize={list.pageSize}
      total={list.total}
      onPageChange={(page) => {
        list.setPage(page);
        state.setSelectedIds([]);
      }}
      onPageSizeChange={(pageSize) => {
        list.setPageSize(pageSize);
        list.setPage(1);
        state.setSelectedIds([]);
      }}
    />
  );
}

function useListDialogs() {
  const [createOpen, setCreateOpen] = useState(false);
  const [detailPodId, setDetailPodId] = useState<string | null>(null);
  const [logPodId, setLogPodId] = useState<string | null>(null);
  const [qrPodId, setQrPodId] = useState<string | null>(null);
  const [editPodId, setEditPodId] = useState<string | null>(null);
  const [resourcePod, setResourcePod] = useState<Pod | null>(null);
  const [upgradeIds, setUpgradeIds] = useState<string[]>([]);
  return {
    createOpen,
    detailPodId,
    logPodId,
    qrPodId,
    editPodId,
    resourcePod,
    upgradeIds,
    setCreateOpen,
    setDetailPodId,
    setLogPodId,
    setQrPodId,
    setEditPodId,
    setResourcePod,
    setUpgradeIds,
  };
}

type DialogState = ReturnType<typeof useListDialogs>;

function ListDialogs({
  state,
  onCreated,
  onRefresh,
}: {
  state: DialogState;
  onCreated: (pod: Pod) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  return (
    <>
      <CreatePodDialog
        visible={state.createOpen}
        onClose={() => state.setCreateOpen(false)}
        onCreated={onCreated}
      />
      <PodUpgradeDialog
        podIds={state.upgradeIds}
        onClose={() => state.setUpgradeIds([])}
        onDone={onRefresh}
      />
      <PodLogDialog
        podId={state.logPodId ?? ""}
        visible={state.logPodId !== null}
        onClose={() => state.setLogPodId(null)}
      />
      <PodQrDialog
        podId={state.qrPodId ?? ""}
        visible={state.qrPodId !== null}
        onClose={() => state.setQrPodId(null)}
      />
      <EditChannelModal
        podId={state.editPodId}
        onClose={() => state.setEditPodId(null)}
        onSaved={() => {
          state.setEditPodId(null);
          void onRefresh();
        }}
      />
      <PodResourceDialog
        pod={state.resourcePod}
        onClose={() => state.setResourcePod(null)}
        onSaved={onRefresh}
      />
    </>
  );
}
