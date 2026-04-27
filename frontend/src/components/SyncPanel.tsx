import { useCallback, useEffect, useState } from "react";
import { Activity, RotateCw } from "lucide-react";
import { api } from "../api/client";
import type { SyncStatusResponse } from "../types/api";

type Props = {
  onComplete: () => void;
};

const syncStages = [
  { key: "liked_tracks", label: "Лайкнутые треки", hint: "Берем твои сохраненные треки" },
  { key: "liked_artists", label: "Любимые исполнители", hint: "Смотрим лайкнутых артистов" },
  { key: "history_fetch", label: "История", hint: "Получаем историю прослушиваний" },
  { key: "history_resolve", label: "Раскрытие истории", hint: "Догружаем полные треки из истории" },
  { key: "my_wave", label: "Моя волна", hint: "Пробуем достать треки волны" },
  { key: "familiar_base", label: "Знакомые треки", hint: "Считаем знакомые песни артистов" },
  { key: "catalog_base", label: "Коллабы", hint: "Смотрим дискографию твоих артистов" },
  { key: "similar_base", label: "Похожие", hint: "Ищем похожих артистов" },
  { key: "familiar_neighbors", label: "Соседи", hint: "Проверяем найденных артистов" },
  { key: "catalog_depth", label: "Глубина коллабов", hint: "Раскрываем граф дальше" },
  { key: "similar_depth", label: "Глубина похожих", hint: "Раскрываем похожих дальше" },
  { key: "familiar_depth", label: "Догрузка треков", hint: "Догружаем знакомые треки глубины" },
  { key: "save_db", label: "Сохранение", hint: "Пишем треки и связи в базу" },
  { key: "cached_familiar", label: "Финальная догрузка", hint: "Обновляем кэшированные связи" }
];

function currentStageKey(sync: SyncStatusResponse | null): string | null {
  if (!sync) return null;
  if (sync.status === "completed") return "done";
  if (sync.status === "failed") return "failed";
  return sync.sourceStatus._current_stage ?? null;
}

function stageState(sync: SyncStatusResponse | null, stageKey: string, activeKey: string | null) {
  if (!sync) return "idle";
  const value = sync.sourceStatus[stageKey];
  if (value?.startsWith("failed")) return "failed";
  if (value) return "done";
  if (activeKey === stageKey) return "active";
  return "idle";
}

function JumpingDots() {
  return (
    <span className="sync-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function SyncPanel({ onComplete }: Props) {
  const [sync, setSync] = useState<SyncStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sync || sync.status === "completed" || sync.status === "failed") {
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const next = await api.syncStatus(sync.job_id);
        setSync(next);
        if (next.status === "completed") {
          onComplete();
        }
      } catch (statusError) {
        setError(statusError instanceof Error ? statusError.message : "Не удалось обновить статус sync");
        setSync((current) =>
          current
            ? {
                ...current,
                status: "failed",
                progress: 100,
                error: "Не удалось обновить статус sync"
              }
            : current
        );
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

  const activeStageKey = currentStageKey(sync);
  const isRunning = sync?.status === "queued" || sync?.status === "running";

  return (
    <section className="toolbar-section sync-strip">
      <div className="sync-main">
        <div>
          <span className="toolbar-label">
            <Activity size={16} />
            Sync
            {isRunning && <JumpingDots />}
          </span>
          <p>{sync?.message ?? "История, лайки и Моя волна еще не синхронизированы"}</p>
        </div>
        <div className="sync-actions">
          {sync && (
            <div className="progress-meter" aria-label="sync progress">
              <span style={{ width: `${sync.progress}%` }} />
            </div>
          )}
          <button className="icon-button wide" disabled={busy || isRunning} onClick={startSync}>
            <RotateCw size={17} />
            {isRunning ? "Идет sync" : "Синхронизировать"}
          </button>
        </div>
      </div>

      {sync && (
        <div className="sync-stage-list" aria-label="sync stages">
          {syncStages.map((stage) => {
            const state = stageState(sync, stage.key, activeStageKey);
            return (
              <div className={`sync-stage ${state}`} key={stage.key} title={sync.sourceStatus[stage.key] ?? stage.hint}>
                <span className="sync-stage-dot" />
                <div>
                  <strong>
                    {stage.label}
                    {state === "active" && <JumpingDots />}
                  </strong>
                  <p>{sync.sourceStatus[stage.key] ?? stage.hint}</p>
                </div>
              </div>
            );
          })}
          {sync.status === "completed" && (
            <div className="sync-stage done">
              <span className="sync-stage-dot" />
              <div>
                <strong>Готово</strong>
                <p>Граф обновлен, можно исследовать связи.</p>
              </div>
            </div>
          )}
          {sync.status === "failed" && (
            <div className="sync-stage failed">
              <span className="sync-stage-dot" />
              <div>
                <strong>Ошибка</strong>
                <p>{sync.error ?? "Синхронизация остановилась"}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
