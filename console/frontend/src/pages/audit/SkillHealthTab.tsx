import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Banner, Button, Space } from "@douyinfe/semi-ui";
import type { SkillHealthItem, SkillHealthWindow } from "../../api";
import { PageSection } from "../../components/ConsolePage";
import { ErrorDetail } from "../../utils/error";
import { SkillHealthTable } from "./SkillHealthTable";
import { useSkillHealth } from "./useSkillHealth";
import styles from "../Audit.module.css";

const WINDOW_KEYS: Record<SkillHealthWindow, string> = {
  "24h": "audit.health.window24h",
  "7d": "audit.health.window7d",
  "30d": "audit.health.window30d",
};

const WINDOWS: SkillHealthWindow[] = ["24h", "7d", "30d"];

interface Props {
  active: boolean;
  onDrilldown: (item: SkillHealthItem) => void;
}

export function SkillHealthTab({ active, onDrilldown }: Props) {
  const { t } = useTranslation();
  const [window, setWindow] = useState<SkillHealthWindow>("7d");
  const state = useSkillHealth(active, window);
  return (
    <PageSection>
      <div className={styles.healthToolbar}>
        <Space spacing={8}>
          <span>{t("audit.health.windowLabel")}</span>
          {WINDOWS.map((value) => (
            <Button
              key={value}
              size="small"
              aria-pressed={window === value}
              theme={window === value ? "solid" : "light"}
              type={window === value ? "primary" : "tertiary"}
              onClick={() => setWindow(value)}
            >
              {t(WINDOW_KEYS[value])}
            </Button>
          ))}
        </Space>
      </div>
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
          <Button onClick={() => void state.refresh()}>{t("audit.health.retry")}</Button>
        </div>
      )}
      <SkillHealthTable items={state.items} loading={state.loading} onDrilldown={onDrilldown} />
    </PageSection>
  );
}
