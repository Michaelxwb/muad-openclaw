import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Banner, Button, Typography } from "@douyinfe/semi-ui";
import { PageSection } from "../../components/ConsolePage";
import { ErrorDetail } from "../../utils/error";
import { ExecutionTraceDrawer } from "./ExecutionTraceDrawer";
import { SkillExecutionTable } from "./SkillExecutionTable";
import { SkillExecutionToolbar } from "./SkillExecutionToolbar";
import { usePodNames } from "../../hooks/usePodNames";
import { useSkillExecutionRecords } from "./useSkillExecutionRecords";
import type { SkillExecutionDrilldown } from "./skillExecutionTypes";
import styles from "./SkillExecutions.module.css";

interface Props {
  active: boolean;
  onOpenPod?: (podId: string) => void;
  drilldown?: SkillExecutionDrilldown | null;
  onClearDrilldown?: () => void;
}

export function SkillExecutionLogTab({ active, onOpenPod, drilldown, onClearDrilldown }: Props) {
  const { t } = useTranslation();
  const state = useSkillExecutionRecords(active, drilldown);
  const podNames = usePodNames(active);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const clearDrilldown = () => {
    state.reset();
    onClearDrilldown?.();
  };
  return (
    <PageSection>
      {drilldown && (
        <div className={styles.drilldown}>
          <Typography.Text>
            {t("audit.health.drilldownHint", {
              user: drilldown.humanUserId,
              skill: drilldown.skillName,
            })}
          </Typography.Text>
          <Button size="small" onClick={clearDrilldown}>
            {t("audit.health.clearDrilldown")}
          </Button>
        </div>
      )}
      <SkillExecutionToolbar
        value={state.draftFilters}
        onChange={state.setDraftFilters}
        onSearch={state.search}
        onApply={state.applyFilter}
        onReset={state.reset}
      />
      {state.error && (
        <div className={styles.error}>
          <Banner
            type="danger"
            description={state.error}
            fullMode={false}
            bordered
            closeIcon={null}
          />
          <ErrorDetail detail={state.errorDetail} />
          <Button aria-label={t("execution.reloadList")} onClick={() => void state.refresh()}>
            {t("execution.reloadList")}
          </Button>
        </div>
      )}
      <SkillExecutionTable
        state={state}
        podNames={podNames}
        onOpenPod={onOpenPod}
        onOpenTrace={setSelectedExecutionId}
      />
      <ExecutionTraceDrawer
        executionId={selectedExecutionId ?? ""}
        visible={selectedExecutionId !== null}
        onClose={() => setSelectedExecutionId(null)}
      />
    </PageSection>
  );
}
