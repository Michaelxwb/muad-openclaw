import { useCallback, useEffect, useRef, useState } from "react";
import { Button, TextArea } from "@douyinfe/semi-ui";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { FeedbackBanner } from "../ConsolePage";
import { useMountedRef } from "../../hooks/useMountedRef";
import { errorMessage } from "../../utils/error";
import styles from "../../pages/Settings.module.css";

interface GuidanceForm {
  userSkill: string;
  memory: string;
  main: string;
}

const EMPTY: GuidanceForm = { userSkill: "", memory: "", main: "" };

// AgentGuidanceSettings edits the agent workspace guidance text that the runtime
// writes into each agent's AGENTS.md / BOOTSTRAP.md. Empty fields fall back to
// the runtime renderer's built-in defaults; saving re-applies every Pod without
// an image rebuild.
export function AgentGuidanceSettings() {
  const { t } = useTranslation();
  const [form, setForm] = useState<GuidanceForm>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const result = await api.getAgentGuidance();
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setForm({
        userSkill: result.userSkill,
        memory: result.memory,
        main: result.main,
      });
    } catch (caught) {
      if (mountedRef.current && requestId === requestRef.current)
        setError(errorMessage(caught, "settings.agentGuidanceLoadFailed"));
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [mountedRef]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.setAgentGuidance(form);
      if (mountedRef.current) setMessage(t("settings.agentGuidanceSaved"));
    } catch (caught) {
      if (mountedRef.current) setError(errorMessage(caught, "settings.agentGuidanceSaveFailed"));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <div>
      <FeedbackBanner error={error} message={message} />
      <GuidanceField
        label={t("settings.guidanceUserSkill")}
        value={form.userSkill}
        disabled={loading}
        onChange={(value) => setForm({ ...form, userSkill: value })}
      />
      <GuidanceField
        label={t("settings.guidanceMemory")}
        value={form.memory}
        disabled={loading}
        onChange={(value) => setForm({ ...form, memory: value })}
      />
      <GuidanceField
        label={t("settings.guidanceMain")}
        value={form.main}
        disabled={loading}
        onChange={(value) => setForm({ ...form, main: value })}
      />
      <Button theme="solid" loading={busy} disabled={loading} onClick={() => void save()}>
        {t("settings.saveAgentGuidance")}
      </Button>
    </div>
  );
}

function GuidanceField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.guidanceField}>
      <label>{label}</label>
      <TextArea
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={onChange}
        autosize={{ minRows: 4, maxRows: 14 }}
        placeholder={t("settings.guidancePlaceholder")}
      />
    </div>
  );
}
