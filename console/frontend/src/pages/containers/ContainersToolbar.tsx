import { Button, Input, Select, Space, Tooltip } from "@douyinfe/semi-ui";
import { IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import type { BasicSelectValue } from "@douyinfe/semi-ui/lib/es/select";
import { BatchToolbar } from "../../components/BatchToolbar";
import { ListToolbar } from "../../components/ConsolePage";
import { isPodStateFilter, STATUS_OPTIONS } from "./model";
import type { PodListState } from "./usePodList";
import styles from "../Containers.module.css";

interface Props {
  state: PodListState;
  selectedIds: string[];
  onCreate: () => void;
  onReloadSkills: () => void;
  onBatchUpgrade: () => void;
  onBatchDelete: (ids: string[]) => void;
}

export function ContainersToolbar(props: Props) {
  const applySearch = () => {
    props.state.setSearch(props.state.searchDraft.trim());
    props.state.setPage(1);
  };
  const filterStatus = (value: BasicSelectValue | undefined | BasicSelectValue[]) => {
    const next = String(Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));
    if (!isPodStateFilter(next)) return;
    props.state.setStatus(next);
    props.state.setPage(1);
  };
  return (
    <ListToolbar
      actions={
        <Space className={styles.actionGroup} spacing={8}>
          <Button theme="solid" onClick={props.onCreate}>
            创建 Pod
          </Button>
          <span aria-hidden="true" className={styles.divider} />
          <BatchToolbar
            selectedIds={props.selectedIds}
            onReloadSkills={props.onReloadSkills}
            onBatchUpgrade={props.onBatchUpgrade}
            onBatchDelete={props.onBatchDelete}
          />
        </Space>
      }
      filters={
        <Space className={styles.filterGroup}>
          <Input
            className={styles.searchInput}
            prefix={<IconSearch />}
            placeholder="Pod ID 或名称"
            value={props.state.searchDraft}
            onChange={props.state.setSearchDraft}
            onEnterPress={applySearch}
          />
          <Tooltip content="查询">
            <Button aria-label="查询 Pod" icon={<IconSearch />} onClick={applySearch} />
          </Tooltip>
          <Select
            className={styles.statusSelect}
            value={props.state.status}
            optionList={STATUS_OPTIONS}
            onChange={filterStatus}
          />
          <Tooltip content="刷新">
            <Button
              aria-label="刷新 Pod"
              icon={<IconRefresh />}
              loading={props.state.loading}
              onClick={() => void props.state.refresh()}
            />
          </Tooltip>
        </Space>
      }
    />
  );
}
