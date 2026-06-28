import { FormEvent, useEffect, useState } from "react";
import { api, Channel } from "../api";
import { CHANNELS } from "../channels";
import { Select } from "./Select";
import styles from "./CreateModal.module.css";

const CHANNEL_OPTIONS = CHANNELS.map((c) => ({
  value: c.value,
  label: `${c.icon} ${c.label}`,
}));

interface Props {
  open: boolean;
  existingIds: string[];
  onClose: () => void;
  onCreated: () => void;
}

const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function CreateModal({ open, existingIds, onClose, onCreated }: Props) {
  const [form, setForm] = useState({
    userId: "",
    channel: "wecom" as Channel,
    botId: "",
    secret: "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) {
      setForm({ userId: "", channel: "wecom", botId: "", secret: "" });
      setErr("");
      setFieldErrors({});
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const needsCreds = form.channel === "wecom";

  const validate = (): boolean => {
    const fe: Record<string, string> = {};
    const uid = form.userId.trim();
    if (!uid) fe.userId = "必填";
    else if (!USER_ID_RE.test(uid)) fe.userId = "格式: 字母/数字开头，可含 ._-";
    else if (existingIds.includes(uid)) fe.userId = "用户已存在";
    // 微信免凭证（登录靠日志二维码扫码）；仅企业微信校验 botId/secret。
    if (needsCreds) {
      if (!form.botId.trim()) fe.botId = "必填";
      if (!form.secret.trim()) fe.secret = "必填";
    }
    setFieldErrors(fe);
    return Object.keys(fe).length === 0;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setErr("");
    setBusy(true);
    try {
      await api.createContainer({
        userId: form.userId.trim(),
        channel: form.channel,
        botId: form.botId.trim(),
        secret: form.secret,
      });
      onCreated();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.head}>
          <h2>创建容器</h2>
          <button className={styles.closeBtn} onClick={onClose}>
            ✕
          </button>
        </div>
        <form onSubmit={submit} className={styles.body}>
          {err && <div className="error">{err}</div>}
          <div className={styles.field}>
            <label>用户 ID</label>
            <input
              autoFocus
              value={form.userId}
              onChange={(e) => setForm({ ...form, userId: e.target.value })}
              placeholder="alice"
            />
            {fieldErrors.userId && <span className="error">{fieldErrors.userId}</span>}
          </div>
          <div className={styles.field}>
            <label>消息通道</label>
            <Select
              value={form.channel}
              options={CHANNEL_OPTIONS}
              onChange={(v) => setForm({ ...form, channel: v as Channel })}
              block
            />
          </div>
          {needsCreds ? (
            <>
              <div className={styles.field}>
                <label>Bot ID</label>
                <input
                  value={form.botId}
                  onChange={(e) => setForm({ ...form, botId: e.target.value })}
                  placeholder="aib..."
                />
                {fieldErrors.botId && <span className="error">{fieldErrors.botId}</span>}
              </div>
              <div className={styles.field}>
                <label>Secret</label>
                <input
                  type="password"
                  value={form.secret}
                  onChange={(e) => setForm({ ...form, secret: e.target.value })}
                  placeholder="企业微信 secret"
                />
                {fieldErrors.secret && <span className="error">{fieldErrors.secret}</span>}
              </div>
            </>
          ) : (
            <p className="hint">
              微信无需填凭证：创建后在列表「扫码登录」从容器日志获取二维码扫码登录。
            </p>
          )}
          <div className={styles.actions}>
            <button type="button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="submit" className={styles.submitBtn} disabled={busy}>
              {busy ? "创建中…" : "创建容器"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
