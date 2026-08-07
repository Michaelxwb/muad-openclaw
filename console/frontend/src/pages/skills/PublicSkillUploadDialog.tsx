import { useEffect, useState } from "react";
import { Modal, Select, Space, Toast, Upload } from "@douyinfe/semi-ui";
import type { FileItem } from "@douyinfe/semi-ui/lib/es/upload";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api";
import type { Platform } from "../../api";
import i18n from "../../i18n";
import { ErrorDetail, errorMessage } from "../../utils/error";
import styles from "../Skills.module.css";

export function PublicSkillUploadDialog({
  visible,
  onClose,
  onUploaded,
}: {
  visible: boolean;
  onClose: () => void;
  onUploaded: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [fileList, setFileList] = useState<FileItem[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [platformOptions, setPlatformOptions] = useState<Platform[]>([]);
  const [platformLoading, setPlatformLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    setPlatformLoading(true);
    api
      .listPlatforms()
      .then((result) => {
        if (active) setPlatformOptions(result.items);
      })
      .catch((caught) => {
        if (active) {
          setError(errorMessage(caught, "skill.loadPlatformsFailed"));
          setErrorDetail(caught instanceof ApiError ? caught.detail : undefined);
        }
      })
      .finally(() => {
        if (active) setPlatformLoading(false);
      });
    return () => {
      active = false;
    };
  }, [visible]);
  const reset = () => {
    setFile(null);
    setFileList([]);
    setPlatforms([]);
    setError("");
    setErrorDetail(undefined);
  };
  const close = () => {
    reset();
    onClose();
  };
  const submit = async () => {
    if (!file) {
      setError(t("skill.selectBundle"));
      setErrorDetail(undefined);
      return;
    }
    setBusy(true);
    setError("");
    setErrorDetail(undefined);
    try {
      const result = await api.uploadPublicSkill({
        bundle: file,
        filename: file.name,
        platforms,
      });
      Toast.success(t("skill.uploaded", { name: result.skill.name }));
      close();
      await onUploaded();
    } catch (caught) {
      setError(errorMessage(caught, "skill.uploadFailed"));
      setErrorDetail(caught instanceof ApiError ? caught.detail : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("skill.upload")}
      visible={visible}
      onCancel={close}
      confirmLoading={busy}
      onOk={() => void submit()}
    >
      <Space vertical align="start">
        {error && (
          <span className={styles.errorText}>
            {error}
            <ErrorDetail detail={errorDetail} />
          </span>
        )}
        <Upload
          aria-label={t("skill.bundleLabel")}
          accept=".tar.gz,.zip"
          action=""
          uploadTrigger="custom"
          limit={1}
          fileList={fileList}
          showUploadList={false}
          onFileChange={(files) => {
            const nextFile = files[0] ?? null;
            setFile(nextFile);
            setFileList(
              nextFile
                ? [
                    {
                      uid: `${nextFile.name}-${nextFile.lastModified}`,
                      name: nextFile.name,
                      size: String(nextFile.size),
                      status: "wait",
                      fileInstance: nextFile,
                    },
                  ]
                : [],
            );
            setError("");
          }}
          onRemove={() => {
            setFile(null);
            setFileList([]);
          }}
        >
          <span className={styles.uploadTrigger}>{t("skill.chooseBundle")}</span>
        </Upload>
        {file && <span className="mono">{file.name}</span>}
        <Select
          multiple
          placeholder={t("skill.platformDependency")}
          value={platforms}
          loading={platformLoading}
          optionList={platformOptions.map((platform) => platformOption(platform))}
          onChange={(value) => setPlatforms(Array.isArray(value) ? value.map(String) : [])}
          style={{ width: 320 }}
        />
      </Space>
    </Modal>
  );
}

function platformOption(platform: Platform) {
  return {
    value: platform.platform,
    label: `${platform.displayName} (${platform.platform})${
      platform.enabled ? "" : ` ${i18n.t("status.disabled")}`
    }`,
  };
}
