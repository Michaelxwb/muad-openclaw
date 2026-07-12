import type { ReactNode } from "react";
import { Banner, Descriptions, Space, Typography } from "@douyinfe/semi-ui";
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

export function FeedbackBanner({ error, message }: { error?: string; message?: string }) {
  if (!error && !message) return null;
  return (
    <Banner
      className={styles.feedback}
      type={error ? "danger" : "success"}
      description={error || message}
      fullMode={false}
      bordered
    />
  );
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
    <Descriptions
      className={styles.metrics}
      data={items.map((item) => ({ key: item.label, value: item.value }))}
      row
      size="small"
      column={columns}
    />
  );
}
