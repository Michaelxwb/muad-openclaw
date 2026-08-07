import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Select, Space, Tooltip } from "@douyinfe/semi-ui";
import { IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import type { BasicSelectValue } from "@douyinfe/semi-ui/lib/es/select";
import { BatchToolbar } from "../../components/BatchToolbar";
import { ListToolbar } from "../../components/ConsolePage";
import { isPodStateFilter, statusOptions } from "./model";
import type { PodListState } from "./usePodList";
import styles from "../Containers.module.css";

interface Props {
  state: PodListState;
  selectedIds: string[];
  onCreate: () => void;
  onBatchUpgrade: () => void;
  onBatchDelete: (ids: string[]) => void;
}

export function ContainersToolbar(props: Props) {
  const { t } = useTranslation();
  const options = useMemo(() => statusOptions(t), [t]);
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
            {t("pod.createTitle")}
          </Button>
          <span aria-hidden="true" className={styles.divider} />
          <BatchToolbar
            selectedIds={props.selectedIds}
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
            placeholder={t("pod.searchPlaceholder")}
            value={props.state.searchDraft}
            onChange={props.state.setSearchDraft}
            onEnterPress={applySearch}
          />
          <Tooltip content={t("common.search")}>
            <Button aria-label={t("pod.searchAria")} icon={<IconSearch />} onClick={applySearch} />
          </Tooltip>
          <Select
            className={styles.statusSelect}
            value={props.state.status}
            optionList={options}
            onChange={filterStatus}
          />
          <Tooltip content={t("common.refresh")}>
            <Button
              aria-label={t("pod.refreshAria")}
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
