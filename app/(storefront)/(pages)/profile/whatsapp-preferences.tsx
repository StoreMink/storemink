"use client";

// The shopper's WhatsApp choices — the account-page half of the consent the
// checkout collects (docs/whatsapp-commerce-plan.md §10). Renders nothing on
// a store that cannot message on WhatsApp, or for an account with no mobile
// number, exactly as the checkout shows no box then: a switch for a channel
// that cannot deliver would record a consent nobody can honour.

import { useEffect, useState, useTransition } from "react";
import { MessageCircle } from "lucide-react";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
import {
  getMyWhatsAppPreferences,
  setMyWhatsAppPreferences,
  type MyWhatsAppPreferences,
} from "@/app/actions/customer-whatsapp-actions";
import styles from "./profile.module.css";

export default function WhatsAppPreferences() {
  const [prefs, setPrefs] = useState<MyWhatsAppPreferences | null>(null);
  const [updates, setUpdates] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let cancelled = false;
    void getMyWhatsAppPreferences().then((p) => {
      if (cancelled) return;
      setPrefs(p);
      setUpdates(p.updates);
      setMarketing(p.marketing);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A flicked switch that was never saved is lost on reload; the shared
  // guard says so first. Computed before the early return so the hook order
  // is stable whether or not the card renders.
  const dirty =
    Boolean(prefs?.available) &&
    (updates !== prefs?.updates || marketing !== prefs?.marketing);
  useUnsavedChangesWarning(dirty);

  if (!prefs?.available) return null;

  const save = () => {
    setStatus(null);
    start(async () => {
      const r = await setMyWhatsAppPreferences({ updates, marketing });
      if (!r.ok) {
        setStatus({ type: "error", message: r.error ?? "Couldn't save." });
        return;
      }
      setPrefs({ ...prefs, updates, marketing });
      setStatus({ type: "success", message: "Saved." });
    });
  };

  return (
    <div className={`${styles.card} ${styles.slotWhatsApp}`}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>
          <MessageCircle size={18} strokeWidth={1.75} aria-hidden="true" />{" "}
          WhatsApp
        </h2>
        <p className={styles.cardSubtitle}>
          Messages from this store to {prefs.phoneLabel}.
        </p>
      </div>

      {status && (
        <div className={`${styles.statusMessage} ${styles[status.type]}`}>
          {status.message}
        </div>
      )}

      <label className={styles.checkRow}>
        <input
          type="checkbox"
          checked={updates}
          onChange={(e) => setUpdates(e.target.checked)}
          disabled={pending}
        />
        <span>{prefs.copy.updates}</span>
      </label>
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          checked={marketing}
          onChange={(e) => setMarketing(e.target.checked)}
          disabled={pending}
        />
        <span>{prefs.copy.marketing}</span>
      </label>

      <div className={styles.formActions}>
        <button
          type="button"
          className={styles.submitBtn}
          onClick={save}
          disabled={pending || !dirty}
        >
          {pending ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}
