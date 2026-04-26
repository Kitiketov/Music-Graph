import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, RotateCw } from "lucide-react";
import { api } from "../api/client";
import type { SyncStatusResponse } from "../types/api";

type Props = {
  onComplete: () => void;
  autoStart?: boolean;
  autoStartKey?: string | null;
};

export function SyncPanel({ onComplete, autoStart = false, autoStartKey = null }: Props) {
  const autoStartedKeyRef = useRef<string | null>(null);
  const [sync, setSync] = useState<SyncStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sync || sync.status === "completed" || sync.status === "failed") {
      return;
    }
    const timer = window.setInterval(async () => {
      const next = await api.syncStatus(sync.job_id);
      setSync(next);
      if (next.status === "completed") {
        onComplete();
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [onComplete, sync]);

  const startSync = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await api.startSync();
      setSync({
        job_id: started.job_id,
        status: "queued",
        progress: 0,
        message: "В очереди",
        sourceStatus: {}
      });
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Синхронизация не запустилась");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const key = autoStartKey ?? "default";
    if (!autoStart || busy || sync?.status === "queued" || sync?.status === "running") {
      return;
    }
    if (autoStartedKeyRef.current === key) {
      return;
    }
    autoStartedKeyRef.current = key;
    void startSync();
  }, [autoStart, autoStartKey, busy, startSync, sync?.status]);

  return (
    <section className="toolbar-section sync-strip">
      <div>
        <span className="toolbar-label">
          <Activity size={16} />
          Sync
        </span>
        <p>{sync?.message ?? "История и Моя волна ещё не синхронизированы"}</p>
      </div>
      <div className="sync-actions">
        {sync && (
          <div className="progress-meter" aria-label="sync progress">
            <span style={{ width: `${sync.progress}%` }} />
          </div>
        )}
        <button className="icon-button wide" disabled={busy} onClick={startSync}>
          <RotateCw size={17} />
          Синхронизировать
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
