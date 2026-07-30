import { useEffect, useState } from "react";
import { Modal, Select, Space, Toast, Upload } from "@douyinfe/semi-ui";
import type { FileItem } from "@douyinfe/semi-ui/lib/es/upload";
import { api } from "../../api";
import type { Platform } from "../../api";
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
  const [file, setFile] = useState<File | null>(null);
  const [fileList, setFileList] = useState<FileItem[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [platformOptions, setPlatformOptions] = useState<Platform[]>([]);
  const [platformLoading, setPlatformLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
        if (active) setError(caught instanceof Error ? caught.message : "加载平台失败");
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
  };
  const close = () => {
    reset();
    onClose();
  };
  const submit = async () => {
    if (!file) {
      setError("请选择 .tar.gz 或 .zip Skill 包");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api.uploadPublicSkill({
        bundle: file,
        filename: file.name,
        platforms,
      });
      Toast.success(`Public Skill 已上传：${result.skill.name}`);
      close();
      await onUploaded();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "上传失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="上传 Public Skill"
      visible={visible}
      onCancel={close}
      confirmLoading={busy}
      onOk={() => void submit()}
    >
      <Space vertical align="start">
        {error && <span className={styles.errorText}>{error}</span>}
        <Upload
          aria-label="Public Skill 包"
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
          <span className={styles.uploadTrigger}>选择 .tar.gz / .zip 包</span>
        </Upload>
        {file && <span className="mono">{file.name}</span>}
        <Select
          multiple
          placeholder="业务平台依赖（可选）"
          value={platforms}
          loading={platformLoading}
          optionList={platformOptions.map(platformOption)}
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
    label: `${platform.displayName} (${platform.platform})${platform.enabled ? "" : " 停用"}`,
  };
}
