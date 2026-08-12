import styles from "./PodName.module.css";

interface Props {
  podId: string;
  podNames: ReadonlyMap<string, string>;
}

/** Pod 名称 + podId 一行展示；名称缺失时回退只显示 podId。 */
export function PodName({ podId, podNames }: Props) {
  const displayName = podNames.get(podId);
  if (!displayName) return <span className="mono">{podId}</span>;
  return (
    <span className={styles.podName}>
      <span>{displayName}</span>
      <span className="mono">{podId}</span>
    </span>
  );
}
