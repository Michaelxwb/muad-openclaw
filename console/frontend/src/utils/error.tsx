import { useTranslation } from "react-i18next";
import { ApiError } from "../api";
import i18n from "../i18n";
import styles from "./error.module.css";

// 统一错误文案：后端本地化 message 优先，其余回退到 fallbackKey 的 i18n 文案。
// 在事件处理/catch 内调用（调用时才求值，语言切换后自然拿到新文案）。
export function errorMessage(error: unknown, fallbackKey = "errors.default"): string {
  if (error instanceof ApiError && error.message) return error.message;
  return i18n.t(fallbackKey);
}

// 后端技术细节（detail 字段）默认折叠展示，避免把 k8s/docker 报错直接糊到用户脸上。
export function ErrorDetail({ detail }: { detail?: string }) {
  const { t } = useTranslation();
  if (!detail) return null;
  return (
    <details className={styles.detail}>
      <summary>{t("errors.technicalDetail")}</summary>
      <pre>{detail}</pre>
    </details>
  );
}
