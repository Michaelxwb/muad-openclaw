import { useEffect, useRef } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Card, Descriptions, Space, Toast, Typography } from "@douyinfe/semi-ui";
import styles from "./ConsolePage.module.css";

const { Title, Text } = Typography;

interface PageHeaderProps {
  title: string;
  description?: string;
  extra?: ReactNode;
}

export function PageHeader({ title, description, extra }: PageHeaderProps) {
  return (
    <header className={styles.pageHeader}>
      <div className={styles.pageHeading}>
        <Title heading={4}>{title}</Title>
        {description && <Text type="tertiary">{description}</Text>}
      </div>
      {extra && <Space>{extra}</Space>}
    </header>
  );
}

export function SectionHeader({ title, extra }: { title: string; extra?: ReactNode }) {
  return (
    <div className={styles.sectionHeader}>
      <Title heading={5}>{title}</Title>
      {extra}
    </div>
  );
}

export function PageSection({
  title,
  extra,
  children,
}: {
  title?: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className={styles.pageSection} bordered shadows="hover">
      {(title || extra) && (
        <div className={styles.pageSectionHeader}>
          {title && <strong>{title}</strong>}
          {extra}
        </div>
      )}
      {children}
    </Card>
  );
}

export function ListToolbar({ actions, filters }: { actions?: ReactNode; filters?: ReactNode }) {
  if (!actions && !filters) return null;
  return (
    <div className={styles.listToolbar}>
      <div className={styles.listToolbarActions}>{actions}</div>
      <div className={styles.listToolbarFilters}>{filters}</div>
    </div>
  );
}

export function FeedbackBanner({ error, message }: { error?: string; message?: string }) {
  const lastKeyRef = useRef("");
  useEffect(() => {
    const content = error || message || "";
    if (content === "") {
      lastKeyRef.current = "";
      return;
    }
    const key = `${error ? "error" : "success"}:${content}`;
    if (lastKeyRef.current === key) return;
    lastKeyRef.current = key;
    if (error) {
      Toast.error(content);
    } else {
      Toast.success(content);
    }
  }, [error, message]);
  return null;
}

export function setRepeatableError(setError: Dispatch<SetStateAction<string>>, message: string) {
  setError("");
  window.setTimeout(() => setError(message), 0);
}

export interface MetricItem {
  label: string;
  value: ReactNode;
}

export function MetricDescriptions({
  items,
  columns = 3,
}: {
  items: MetricItem[];
  columns?: number;
}) {
  return (
    <Card className={styles.metrics} bordered>
      <Descriptions
        data={items.map((item) => ({ key: item.label, value: item.value }))}
        row
        size="small"
        column={columns}
      />
    </Card>
  );
}
