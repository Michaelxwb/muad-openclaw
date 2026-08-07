import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TabPane, Tabs } from "@douyinfe/semi-ui";
import { PageHeader } from "../components/ConsolePage";
import { OperationAuditTab } from "./audit/OperationAuditTab";
import { SkillExecutionLogTab } from "./audit/SkillExecutionLogTab";
import styles from "./Audit.module.css";

type AuditTab = "operations" | "skill-executions";

export function Audit({ onOpenPod }: { onOpenPod?: (podId: string) => void }) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<AuditTab>(readAuditTab);
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
          <SkillExecutionLogTab active={activeTab === "skill-executions"} onOpenPod={onOpenPod} />
        </TabPane>
      </Tabs>
    </div>
  );
}

function readAuditTab(): AuditTab {
  return normalizeAuditTab(new URLSearchParams(window.location.search).get("tab"));
}

function normalizeAuditTab(value: string | null): AuditTab {
  return value === "skill-executions" ? "skill-executions" : "operations";
}

function writeAuditTab(tab: AuditTab) {
  const url = new URL(window.location.href);
  if (url.searchParams.get("tab") === tab) return;
  url.searchParams.set("tab", tab);
  window.history.replaceState(window.history.state, "", url);
}
