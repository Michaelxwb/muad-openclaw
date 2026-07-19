import { useEffect, useState } from "react";
import { TabPane, Tabs } from "@douyinfe/semi-ui";
import { PageHeader } from "../components/ConsolePage";
import { OperationAuditTab } from "./audit/OperationAuditTab";
import { SkillExecutionLogTab } from "./audit/SkillExecutionLogTab";
import styles from "./Audit.module.css";

type AuditTab = "operations" | "skill-executions";

export function Audit({ onOpenPod }: { onOpenPod?: (podId: string) => void }) {
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
      <PageHeader title="审计日志" description="分别查询平台操作记录和 Skill 执行生命周期" />
      <Tabs
        className={styles.tabs}
        activeKey={activeTab}
        keepDOM
        tabPaneMotion={false}
        type="line"
        onChange={(key) => setActiveTab(normalizeAuditTab(key))}
      >
        <TabPane itemKey="operations" tab="操作审计">
          <OperationAuditTab active={activeTab === "operations"} />
        </TabPane>
        <TabPane itemKey="skill-executions" tab="Skill 执行日志">
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
