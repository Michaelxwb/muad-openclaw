import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Toast } from "@douyinfe/semi-ui";
import { api } from "../api";
import type { Pod, PodAction } from "../api";
import { FeedbackBanner, PageHeader, PageSection } from "../components/ConsolePage";
import { errorMessage } from "../utils/error";
import { tablePagination } from "../components/Pagination";
import { useMountedRef } from "../hooks/useMountedRef";
import { ContainersToolbar } from "./containers/ContainersToolbar";
import { CreatePodDialog } from "./containers/CreatePodDialog";
import { PodEditDialog } from "./containers/PodEditDialog";
import { PodTable } from "./containers/PodTable";
import { PodUpgradeDialog } from "./containers/PodUpgradeDialog";
import { usePodList } from "./containers/usePodList";
import { PodLogDialog, PodQrDialog } from "./pod-detail/PodActionDialogs";

export function Containers({ onOpenPod }: { onOpenPod: (podId: string) => void }) {
  const state = useContainersController();
  return <PodListView state={state} onOpenPod={onOpenPod} />;
}

function useContainersController() {
  const { t } = useTranslation();
  const dialogs = useListDialogs();
  const list = usePodList();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const mountedRef = useMountedRef();

  // 轮询刷新后已删除的 Pod 不在 items 中：把 selectedIds 与当前 items 求交集，
  // 避免批量操作命中不存在的 Pod（如 409）或残留已删项。
  useEffect(() => {
    setSelectedIds((previous) => {
      if (previous.length === 0) return previous;
      const alive = new Set(list.items.map((pod) => pod.podId));
      const next = previous.filter((id) => alive.has(id));
      return next.length === previous.length ? previous : next;
    });
  }, [list.items]);
  const runAction = async (podId: string, action: PodAction) => {
    try {
      await api.action(podId, action);
      if (!mountedRef.current) return;
      Toast.success(t("pod.actionCompleted", { action }));
      await list.refresh();
    } catch (caught) {
      if (mountedRef.current) Toast.error(errorMessage(caught, "pod.actionFailed"));
    }
  };
  const created = async (pod: Pod) => {
    dialogs.setCreateOpen(false);
    Toast.success(t("pod.created", { podId: pod.podId }));
    if (list.page === 1) await list.refresh();
    else list.setPage(1);
  };
  return {
    list,
    dialogs,
    selectedIds,
    setSelectedIds,
    runAction,
    created,
  };
}

type ContainersState = ReturnType<typeof useContainersController>;

function PodListView({
  state,
  onOpenPod,
}: {
  state: ContainersState;
  onOpenPod: (podId: string) => void;
}) {
  const { t } = useTranslation();
  const { list, dialogs } = state;
  return (
    <div>
      <PageHeader title={t("nav.pods")} description={t("pod.managementDescription")} />
      <FeedbackBanner error={list.error} />
      <PageSection>
        <ContainersToolbar
          state={list}
          selectedIds={state.selectedIds}
          onCreate={() => dialogs.setCreateOpen(true)}
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
          pagination={podTablePagination(state)}
          onSelected={state.setSelectedIds}
          onDetail={onOpenPod}
          onLogs={dialogs.setLogPodId}
          onQr={dialogs.setQrPodId}
          onEdit={dialogs.setEditPodId}
          onAction={(podId, action) => void state.runAction(podId, action)}
        />
      </PageSection>
      <ListDialogs state={dialogs} onCreated={state.created} onRefresh={list.refresh} />
    </div>
  );
}

function podTablePagination(state: ContainersState) {
  const { list } = state;
  return tablePagination({
    page: list.page,
    pageSize: list.pageSize,
    total: list.total,
    onPageChange: (page) => {
      list.setPage(page);
      state.setSelectedIds([]);
    },
    onPageSizeChange: (pageSize) => {
      list.setPageSize(pageSize);
      list.setPage(1);
      state.setSelectedIds([]);
    },
  });
}

function useListDialogs() {
  const [createOpen, setCreateOpen] = useState(false);
  const [logPodId, setLogPodId] = useState<string | null>(null);
  const [qrPodId, setQrPodId] = useState<string | null>(null);
  const [editPodId, setEditPodId] = useState<string | null>(null);
  const [upgradeIds, setUpgradeIds] = useState<string[]>([]);
  return {
    createOpen,
    logPodId,
    qrPodId,
    editPodId,
    upgradeIds,
    setCreateOpen,
    setLogPodId,
    setQrPodId,
    setEditPodId,
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
      <PodEditDialog
        podId={state.editPodId}
        onClose={() => state.setEditPodId(null)}
        onSaved={() => {
          state.setEditPodId(null);
          void onRefresh();
        }}
      />
    </>
  );
}
