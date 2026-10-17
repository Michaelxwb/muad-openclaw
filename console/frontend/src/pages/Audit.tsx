import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TabPane, Tabs } from "@douyinfe/semi-ui";
import type { SkillHealthItem } from "../api";
import { PageHeader } from "../components/ConsolePage";
import { OperationAuditTab } from "./audit/OperationAuditTab";
import { SkillExecutionLogTab } from "./audit/SkillExecutionLogTab";
import { SkillHealthTab } from "./audit/SkillHealthTab";
import type { SkillExecutionDrilldown } from "./audit/skillExecutionTypes";
import styles from "./Audit.module.css";

type AuditTab = "operations" | "skill-executions" | "skill-health";

export function Audit({ onOpenPod }: { onOpenPod?: (podId: string) => void }) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<AuditTab>(readAuditTab);
  const [drilldown, setDrilldown] = useState<SkillExecutionDrilldown | null>(null);
  const openHealthDrilldown = useCallback((item: SkillHealthItem) => {
    setDrilldown({ skillName: item.skillName, humanUserId: item.humanUserId });
    setActiveTab("skill-executions");
  }, []);
  useEffect(() => {
    writeAuditTab(activeTab);
  }, [activeTab]);
  useEffect(() => {
    const restoreTab = () => setActiveTab(readAuditTab());
    window.addEventListener("popstate", restoreTab);
    return () => window.removeEventListener("popstate", restoreTab);
  }, []);
  return (
    <div>
      <PageHeader title={t("nav.audit")} description={t("audit.pageDescription")} />
      <Tabs
        className={styles.tabs}
        activeKey={activeTab}
        keepDOM
        tabPaneMotion={false}
        type="line"
        onChange={(key) => setActiveTab(normalizeAuditTab(key))}
      >
        <TabPane itemKey="operations" tab={t("audit.operationsTab")}>
          <OperationAuditTab active={activeTab === "operations"} />
        </TabPane>
        <TabPane itemKey="skill-executions" tab={t("audit.skillExecutionsTab")}>
          <SkillExecutionLogTab
            active={activeTab === "skill-executions"}
            onOpenPod={onOpenPod}
            drilldown={drilldown}
            onClearDrilldown={() => setDrilldown(null)}
          />
        </TabPane>
        <TabPane itemKey="skill-health" tab={t("audit.skillHealthTab")}>
          <SkillHealthTab active={activeTab === "skill-health"} onDrilldown={openHealthDrilldown} />
        </TabPane>
      </Tabs>
    </div>
  );
}

function readAuditTab(): AuditTab {
  return normalizeAuditTab(new URLSearchParams(window.location.search).get("tab"));
}

function normalizeAuditTab(value: string | null): AuditTab {
  if (value === "skill-executions") return "skill-executions";
  if (value === "skill-health") return "skill-health";
  return "operations";
}

function writeAuditTab(tab: AuditTab) {
  const url = new URL(window.location.href);
  if (url.searchParams.get("tab") === tab) return;
  url.searchParams.set("tab", tab);
  window.history.replaceState(window.history.state, "", url);
}
