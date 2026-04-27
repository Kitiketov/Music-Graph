import { useEffect, useMemo, useState } from "react";
import { ListMusic, PlusCircle } from "lucide-react";
import { api } from "../api/client";
import type { Friend, PlaylistCreateResponse, PlaylistPreviewResponse, PlaylistSource } from "../types/api";

const sourceOptions: Array<{ value: PlaylistSource; label: string; hint: string }> = [
  {
    value: "known",
    label: "Знакомые",
    hint: "Треки из familiar-you: волна и коллекция по артистам"
  },
  {
    value: "liked",
    label: "Лайки",
    hint: "Треки, которые попали в синхронизацию из лайкнутых"
  },
  {
    value: "wave",
    label: "Волна",
    hint: "Моя волна и знакомые wave-треки артистов"
  },
  {
    value: "graph",
    label: "Весь граф",
    hint: "Все треки текущего графа без тестовых friend-playlist данных"
  },
  {
    value: "friend_common",
    label: "С другом",
    hint: "Треки, которые есть и у тебя, и у выбранного друга"
  }
];

const defaultTitles: Record<PlaylistSource, string> = {
  known: "Music Graph: знакомые треки",
  liked: "Music Graph: лайкнутые треки",
  wave: "Music Graph: волна",
  graph: "Music Graph: треки из графа",
  friend_common: "Music Graph: общие с другом"
};

function sourceHint(source: PlaylistSource): string {
  return sourceOptions.find((item) => item.value === source)?.hint ?? "";
}

export function PlaylistPanel({ disabled = false }: { disabled?: boolean }) {
  const [source, setSource] = useState<PlaylistSource>("known");
  const [friends, setFriends] = useState<Friend[]>([]);
  const [selectedFriendId, setSelectedFriendId] = useState<string>("");
  const [limit, setLimit] = useState(50);
  const [title, setTitle] = useState(defaultTitles.known);
  const [titleTouched, setTitleTouched] = useState(false);
  const [preview, setPreview] = useState<PlaylistPreviewResponse | null>(null);
  const [created, setCreated] = useState<PlaylistCreateResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visibleTracks = useMemo(() => preview?.tracks.slice(0, 6) ?? [], [preview]);
  const selectedFriend = friends.find((friend) => friend.friend.id === selectedFriendId);
  const needsFriend = source === "friend_common";
  const canPreview = !disabled && (!needsFriend || Boolean(selectedFriendId));

  useEffect(() => {
    if (!titleTouched) {
      setTitle(
        source === "friend_common" && selectedFriend
          ? `Music Graph: общие с ${selectedFriend.friend.display_login}`
          : defaultTitles[source]
      );
    }
  }, [selectedFriend, source, titleTouched]);

  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    void api
      .friends()
      .then((response) => {
        if (cancelled) return;
        setFriends(response.friends);
        if (!selectedFriendId && response.friends.length > 0) {
          setSelectedFriendId(response.friends[0].friend.id);
        }
      })
      .catch(() => {
        if (!cancelled) setFriends([]);
      });
    return () => {
      cancelled = true;
    };
  }, [disabled, selectedFriendId]);

  useEffect(() => {
    if (!canPreview) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    setLoadingPreview(true);
    setError(null);
    void api
      .playlistPreview({ source, limit, friend_id: needsFriend ? selectedFriendId : null })
      .then((nextPreview) => {
        if (cancelled) return;
        setPreview(nextPreview);
      })
      .catch((previewError) => {
        if (cancelled) return;
        setPreview(null);
        setError(previewError instanceof Error ? previewError.message : "Не удалось собрать preview плейлиста");
      })
      .finally(() => {
        if (!cancelled) setLoadingPreview(false);
      });

    return () => {
      cancelled = true;
    };
  }, [canPreview, limit, needsFriend, selectedFriendId, source]);

  async function createPlaylist() {
    if (!preview || preview.usableCount === 0) return;
    const confirmed = window.confirm(
      `Создать приватный плейлист "${title}" в твоём аккаунте Яндекс Музыки и добавить ${preview.usableCount} треков?`
    );
    if (!confirmed) return;

    setCreating(true);
    setError(null);
    setCreated(null);
    try {
      const response = await api.createPlaylist({
        source,
        limit,
        friend_id: needsFriend ? selectedFriendId : null,
        title,
        visibility: "private"
      });
      setCreated(response);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Не удалось создать плейлист");
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="playlist-panel">
      <div className="playlist-heading">
        <div>
          <p className="eyebrow">Экспорт</p>
          <h2>Плейлист из графа</h2>
          <p>{sourceHint(source)}</p>
        </div>
        <ListMusic size={24} />
      </div>

      <div className="playlist-controls">
        <label>
          Источник
          <select value={source} onChange={(event) => setSource(event.target.value as PlaylistSource)}>
            {sourceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {needsFriend && (
          <label>
            Друг
            <select
              value={selectedFriendId}
              onChange={(event) => {
                setTitleTouched(false);
                setSelectedFriendId(event.target.value);
              }}
            >
              {friends.length === 0 ? (
                <option value="">Нет друзей</option>
              ) : (
                friends.map((friend) => (
                  <option key={friend.id} value={friend.friend.id}>
                    {friend.friend.display_login}
                  </option>
                ))
              )}
            </select>
          </label>
        )}
        <label>
          Лимит: {limit}
          <input
            type="range"
            min="10"
            max="100"
            step="10"
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
          />
        </label>
        <label className="playlist-title-input">
          Название
          <input
            value={title}
            maxLength={120}
            onChange={(event) => {
              setTitleTouched(true);
              setTitle(event.target.value);
            }}
          />
        </label>
      </div>

      <div className="playlist-preview">
        {loadingPreview ? (
          <p className="muted small">Собираем preview плейлиста...</p>
        ) : preview && preview.tracks.length > 0 ? (
          <>
            <div className="playlist-preview-summary">
              <strong>{preview.usableCount}</strong>
              <span>треков готово из {preview.totalAvailable}</span>
              {preview.skippedWithoutAlbum > 0 && <em>{preview.skippedWithoutAlbum} без album id пропущено</em>}
            </div>
            <div className="playlist-track-list">
              {visibleTracks.map((track) => (
                <article key={track.id}>
                  {track.cover ? <img src={track.cover} alt="" /> : <span className="artist-fallback">{track.title[0]}</span>}
                  <div>
                    <strong>{track.title}</strong>
                    <span>{track.artists.join(", ")}</span>
                  </div>
                </article>
              ))}
            </div>
          </>
        ) : (
          <p className="muted small">Под этот источник пока нет треков. Запусти sync или выбери другой источник.</p>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}
      {created && (
        <p className="success-text">
          Создано: {created.addedCount} треков
          {created.url ? (
            <>
              {" "}
              <a href={created.url} target="_blank" rel="noreferrer">
                открыть в Яндекс Музыке
              </a>
            </>
          ) : null}
        </p>
      )}

      <button
        className="playlist-create-button"
        type="button"
        disabled={disabled || creating || !preview || preview.usableCount === 0 || title.trim().length === 0}
        onClick={() => void createPlaylist()}
      >
        <PlusCircle size={17} />
        {creating ? "Создаём..." : "Создать приватный плейлист"}
      </button>
    </section>
  );
}
