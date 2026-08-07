import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Banner, Button } from "@douyinfe/semi-ui";
import { PageSection } from "../../components/ConsolePage";
import { ErrorDetail } from "../../utils/error";
import { SkillExecutionDetailModal } from "./SkillExecutionDetailModal";
import { SkillExecutionTable } from "./SkillExecutionTable";
import { SkillExecutionToolbar } from "./SkillExecutionToolbar";
import { useSkillExecutionRecords } from "./useSkillExecutionRecords";
import styles from "./SkillExecutions.module.css";

interface Props {
  active: boolean;
  onOpenPod?: (podId: string) => void;
}

export function SkillExecutionLogTab({ active, onOpenPod }: Props) {
  const { t } = useTranslation();
  const state = useSkillExecutionRecords(active);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  return (
    <>
      <PageSection>
        <SkillExecutionToolbar
          value={state.draftFilters}
          busy={state.loading}
          onChange={state.setDraftFilters}
          onSearch={state.search}
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
        <SkillExecutionTable state={state} onOpenPod={onOpenPod} onView={setSelectedExecutionId} />
      </PageSection>
      <SkillExecutionDetailModal
        executionId={selectedExecutionId}
        onClose={() => setSelectedExecutionId(null)}
      />
    </>
  );
}
