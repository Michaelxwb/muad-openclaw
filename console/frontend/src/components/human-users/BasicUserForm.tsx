import { useEffect, useState } from "react";
import { Button, Input, Select, TextArea, Toast } from "@douyinfe/semi-ui";
import { api } from "../../api";
import type { HumanUser, HumanUserStatus } from "../../api";
import { FeedbackBanner } from "../ConsolePage";
import styles from "../HumanUsersPanel.module.css";
import { Field, normalizeStatus, USER_STATUS_OPTIONS } from "./shared";

interface Props {
  user: HumanUser;
  onSaved: () => Promise<void>;
}

export function BasicUserForm({ user, onSaved }: Props) {
  const form = useBasicUserForm(user, onSaved);
  return (
    <div>
      <FeedbackBanner error={form.error} />
      <BasicUserFields
        displayName={form.displayName}
        notes={form.notes}
        status={form.status}
        onDisplayName={form.setDisplayName}
        onNotes={form.setNotes}
        onStatus={form.setStatus}
      />
      <Button theme="solid" loading={form.busy} onClick={() => void form.save()}>
        保存基本信息
      </Button>
    </div>
  );
}

function useBasicUserForm(user: HumanUser, onSaved: () => Promise<void>) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [notes, setNotes] = useState(user.notes);
  const [status, setStatus] = useState<Exclude<HumanUserStatus, "deleting">>(
    user.status === "deleting" ? "disabled" : user.status,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDisplayName(user.displayName);
    setNotes(user.notes);
    if (user.status !== "deleting") setStatus(user.status);
  }, [user]);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api.patchHumanUser(user.humanUserId, { displayName, notes, status });
      Toast.success("用户信息已保存");
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存用户失败");
    } finally {
      setBusy(false);
    }
  };

  return { displayName, notes, status, busy, error, setDisplayName, setNotes, setStatus, save };
}

interface FieldsProps {
  displayName: string;
  notes: string;
  status: Exclude<HumanUserStatus, "deleting">;
  onDisplayName: (value: string) => void;
  onNotes: (value: string) => void;
  onStatus: (value: Exclude<HumanUserStatus, "deleting">) => void;
}

function BasicUserFields(props: FieldsProps) {
  return (
    <div className={styles.formGrid}>
      <Field label="显示名称">
        <Input aria-label="编辑显示名称" value={props.displayName} onChange={props.onDisplayName} />
      </Field>
      <Field label="状态">
        <Select
          aria-label="用户状态"
          value={props.status}
          optionList={USER_STATUS_OPTIONS.slice(1)}
          onChange={(value) => props.onStatus(normalizeStatus(String(value)) || "pending")}
          style={{ width: "100%" }}
        />
      </Field>
      <div className={styles.full}>
        <Field label="备注">
          <TextArea
            aria-label="编辑备注"
            value={props.notes}
            onChange={props.onNotes}
            maxCount={4000}
          />
        </Field>
      </div>
    </div>
  );
}
