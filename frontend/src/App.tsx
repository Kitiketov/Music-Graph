import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Filter, LogOut, Search, SlidersHorizontal, Trash2 } from "lucide-react";
import { api, clearToken, getToken } from "./api/client";
import { FriendsPanel } from "./components/FriendsPanel";
import { GraphCanvas } from "./components/GraphCanvas";
import { LoginScreen } from "./components/LoginScreen";
import { PlaylistPanel } from "./components/PlaylistPanel";
import { SyncPanel } from "./components/SyncPanel";
import { LEGAL_VERSION } from "./legal";
import type { Friend, GraphOverlayMatch, GraphResponse, User } from "./types/api";

const overlayPalette = ["#cf4b3f", "#2f6fbd", "#d79b28", "#7b61ff", "#e26d3d", "#139f8f"];
const PENDING_INVITE_CODE_KEY = "music_graph_pending_invite_code";

type FriendGraphOverlay = {
  userId: string;
  label: string;
  color: string;
  graph: GraphResponse;
};

type ClusterIslandsPanelProps = {
  graph: GraphResponse | null;
  enabled: boolean;
  activeClusterId: string | null;
  onHoverCluster: (clusterId: string | null) => void;
  onSelectCluster: (clusterId: string | null) => void;
};

function overlayColorFor(userId: string): string {
  const hash = [...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return overlayPalette[hash % overlayPalette.length];
}

function readStoredInviteCode(): string | null {
  if (typeof window === "undefined") return null;

  try {
    return window.sessionStorage.getItem(PENDING_INVITE_CODE_KEY);
  } catch {
    return null;
  }
}

function storePendingInviteCode(code: string): void {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(PENDING_INVITE_CODE_KEY, code);
  } catch {
    // If sessionStorage is unavailable, keep the code in React state for this page load.
  }
}

function clearPendingInviteCode(): void {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.removeItem(PENDING_INVITE_CODE_KEY);
  } catch {
    // Nothing else to clear.
  }
}

function readInviteCodeFromUrl(): string | null {
  if (typeof window === "undefined") return null;

  const match = window.location.pathname.match(/^\/invite\/([^/?#]+)/);
  if (!match) return null;

  const code = decodeURIComponent(match[1]);
  storePendingInviteCode(code);
  window.history.replaceState({}, "", "/");
  return code;
}

function normalizeArtistName(name: string): string {
  return name
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeTrackTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function commonTrackTitles(leftTracks: string[] = [], rightTracks: string[] = []): string[] {
  const rightNormalized = new Set(rightTracks.map(normalizeTrackTitle).filter(Boolean));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const track of leftTracks) {
    const normalized = normalizeTrackTitle(track);
    if (!normalized || !rightNormalized.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(track);
  }
  return result;
}

const dashboardGuide = [
  {
    title: "Размер пузырька",
    text: "Показывает, сколько знакомых треков артиста нашел Яндекс. Если данных нет, берем локальные прослушивания."
  },
  {
    title: "Зеленые связи",
    text: "Это реальные коллабы из твоих лайков, истории, Моей волны и знакомых треков артиста."
  },
  {
    title: "Синие связи",
    text: "Дискография: найденные коллабы, которые можно включить чекбоксом, чтобы искать новые переходы."
  },
  {
    title: "Друзья",
    text: "Приглашение открывает сравнение графов: общие артисты подсвечиваются, а процент показывает пересечение вкусов."
  }
];

function graphNodeScore(node: GraphResponse["nodes"][number]) {
  if (typeof node.knownTrackCount === "number" && node.knownTrackCount > 0) {
    return node.knownTrackCount;
  }
  return node.trackCount || node.listenCount || 0;
}

function graphNodeScoreLabel(node: GraphResponse["nodes"][number]) {
  const score = graphNodeScore(node);
  const parts = [`${score} знакомых`];
  if (typeof node.waveTrackCount === "number" && node.waveTrackCount > 0) {
    parts.push(`${node.waveTrackCount} из волны`);
  }
  if (typeof node.collectionTrackCount === "number" && node.collectionTrackCount > 0) {
    parts.push(`${node.collectionTrackCount} в коллекции`);
  }
  if (node.trackCount > 0 && node.trackCount !== score) {
    parts.push(`${node.trackCount} в графе`);
  }
  return parts.join(", ");
}

function ClusterIslandsPanel({
  graph,
  enabled,
  activeClusterId,
  onHoverCluster,
  onSelectCluster
}: ClusterIslandsPanelProps) {
  const clusters = useMemo(() => {
    return [...(graph?.clusters ?? [])]
      .sort(
        (left, right) =>
          right.totalListenCount - left.totalListenCount ||
          right.size - left.size ||
          left.label.localeCompare(right.label, "ru")
      )
      .slice(0, 10);
  }, [graph]);

  if (clusters.length === 0) return null;

  return (
    <section className={`cluster-islands-panel ${enabled ? "" : "is-disabled"}`}>
      <div className="stats-heading">
        <div>
          <p className="eyebrow">Музыкальные острова(beta)</p>
          <h2>Группы по прослушанным коллабам</h2>
        </div>
        <span className="cluster-islands-note">
          {enabled ? "Наведи на остров, чтобы подсветить артистов" : "Включи чекбокс «Острова» и «Мои коллабы»"}
        </span>
      </div>
      <div className="cluster-islands-list">
        {clusters.map((cluster) => (
          <button
            className={`cluster-island-card ${activeClusterId === cluster.id ? "active" : ""}`}
            disabled={!enabled}
            key={cluster.id}
            onClick={() => onSelectCluster(activeClusterId === cluster.id ? null : cluster.id)}
            onMouseEnter={() => onHoverCluster(cluster.id)}
            onMouseLeave={() => onHoverCluster(null)}
            style={{ "--cluster-color": cluster.color } as CSSProperties}
            type="button"
          >
            <i />
            <strong>{cluster.label}</strong>
            <span>{cluster.size} артистов, {cluster.totalListenCount} прослушиваний</span>
            <em>{cluster.topArtists.join(", ")}</em>
          </button>
        ))}
      </div>
    </section>
  );
}

function GraphStatsPanel({ graph }: { graph: GraphResponse | null }) {
  const stats = useMemo(() => {
    if (!graph) return null;
    const topArtists = [...graph.nodes]
      .filter((node) => graphNodeScore(node) > 0)
      .sort((left, right) => graphNodeScore(right) - graphNodeScore(left) || left.name.localeCompare(right.name))
      .slice(0, 10);
    const maxScore = Math.max(...topArtists.map(graphNodeScore), 1);
    const collabEdges = graph.edges.filter((edge) => edge.type === "collab").length;
    const catalogEdges = graph.edges.filter((edge) => edge.type === "catalog_collab").length;
    const similarEdges = graph.edges.filter((edge) => edge.type === "similar").length;
    const likedArtists = graph.nodes.filter((node) => node.isLikedArtist).length;

    return {
      topArtists,
      maxScore,
      collabEdges,
      catalogEdges,
      similarEdges,
      likedArtists
    };
  }, [graph]);

  if (!graph || !stats || stats.topArtists.length === 0) {
    return null;
  }

  return (
    <section className="graph-stats-panel">
      <div className="stats-heading">
        <div>
          <p className="eyebrow">Статистика</p>
          <h2>Топ-10 артистов по знакомым трекам</h2>
        </div>
        <div className="stats-summary">
          <span>
            <strong>{graph.nodes.length}</strong>
            артистов
          </span>
          <span>
            <strong>{graph.edges.length}</strong>
            связей
          </span>
          <span>
            <strong>{stats.likedArtists}</strong>
            лайкнутых
          </span>
        </div>
      </div>

      <div className="stats-grid">
        <div className="top-artists-list">
          {stats.topArtists.map((artist, index) => {
            const score = graphNodeScore(artist);
            return (
              <article className="top-artist-row" key={artist.id}>
                <span className="top-artist-rank">{index + 1}</span>
                {artist.image ? <img src={artist.image} alt="" /> : <span className="artist-fallback">{artist.name[0]}</span>}
                <div>
                  <strong>{artist.name}</strong>
                  <p>{graphNodeScoreLabel(artist)}</p>
                  <span className="top-artist-bar">
                    <i style={{ width: `${Math.max(8, (score / stats.maxScore) * 100)}%` }} />
                  </span>
                </div>
              </article>
            );
          })}
        </div>

        <div className="connection-breakdown">
          <article>
            <strong>{stats.collabEdges}</strong>
            <span>зеленых коллабов, которые ты слышал</span>
          </article>
          <article>
            <strong>{stats.catalogEdges}</strong>
            <span>коллабов из дискографии для исследования</span>
          </article>
          <article>
            <strong>{stats.similarEdges}</strong>
            <span>похожих связей от Яндекса</span>
          </article>
        </div>
      </div>
    </section>
  );
}

function SharedArtistsPanel({
  graph,
  overlayMatches
}: {
  graph: GraphResponse | null;
  overlayMatches: Record<string, GraphOverlayMatch[]>;
}) {
  const rows = useMemo(() => {
    if (!graph) return [];
    return graph.nodes
      .map((artist) => {
        const matches = overlayMatches[artist.id] ?? [];
        if (matches.length === 0) return null;
        const commonTracks = [...new Set(matches.flatMap((match) => match.commonTracks))];
        const friendScore = matches.reduce((sum, match) => sum + match.friendScore, 0);
        const myScore = graphNodeScore(artist);
        return {
          artist,
          matches,
          commonTracks,
          myScore,
          friendScore,
          totalScore: myScore + friendScore
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .sort(
        (left, right) =>
          right.totalScore - left.totalScore ||
          right.commonTracks.length - left.commonTracks.length ||
          left.artist.name.localeCompare(right.artist.name)
      )
      .slice(0, 12);
  }, [graph, overlayMatches]);

  if (!graph || rows.length === 0) return null;

  return (
    <section className="shared-artists-panel">
      <div className="stats-heading">
        <div>
          <p className="eyebrow">Пересечения</p>
          <h2>Самые пересеченные артисты по количеству знакомых песен</h2>
        </div>
        <div className="stats-summary">
          <span>
            <strong>{rows.length}</strong>
            в топе
          </span>
          <span>
            <strong>{rows.reduce((sum, row) => sum + row.commonTracks.length, 0)}</strong>
            общих треков
          </span>
        </div>
      </div>

      <div className="shared-artists-list">
        {rows.map((row, index) => (
          <article className="shared-artist-row" key={row.artist.id}>
            <span className="top-artist-rank">{index + 1}</span>
            {row.artist.image ? (
              <img src={row.artist.image} alt="" />
            ) : (
              <span className="artist-fallback">{row.artist.name[0]}</span>
            )}
            <div className="shared-artist-main">
              <div className="shared-artist-title">
                <strong>{row.artist.name}</strong>
                <span>{row.totalScore} знакомых вместе</span>
              </div>
              <p>
                у тебя {row.myScore}, у добавленных пользователей {row.friendScore}
              </p>
              <div className="shared-friend-dots">
                {row.matches.map((match) => (
                  <span style={{ "--overlay-color": match.color } as CSSProperties} key={match.userId}>
                    <i />
                    {match.label}
                  </span>
                ))}
              </div>
              {row.commonTracks.length > 0 ? (
                <div className="common-track-chips">
                  {row.commonTracks.slice(0, 5).map((track) => (
                    <span key={track}>{track}</span>
                  ))}
                  {row.commonTracks.length > 5 && <span>+{row.commonTracks.length - 5}</span>}
                </div>
              ) : (
                <em className="common-track-empty">Общие треки в синхронизированных данных пока не найдены</em>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [friendOverlays, setFriendOverlays] = useState<FriendGraphOverlay[]>([]);
  const friendOverlaysRef = useRef<FriendGraphOverlay[]>([]);
  const graphRequestSeqRef = useRef(0);
  const overlayRefreshSeqRef = useRef(0);
  const [loadingOverlayIds, setLoadingOverlayIds] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(100);
  const [minListens, setMinListens] = useState(1);
  const [draftLimit, setDraftLimit] = useState(100);
  const [draftMinListens, setDraftMinListens] = useState(1);
  const [search, setSearch] = useState("");
  const [graphDepth, setGraphDepth] = useState(1);
  const [draftGraphDepth, setDraftGraphDepth] = useState(1);
  const [repulsionStrength, setRepulsionStrength] = useState(760);
  const [showCollabs, setShowCollabs] = useState(true);
  const [showCatalogCollabs, setShowCatalogCollabs] = useState(false);
  const [showSimilar, setShowSimilar] = useState(false);
  const [showIslands, setShowIslands] = useState(false);
  const [hoveredClusterId, setHoveredClusterId] = useState<string | null>(null);
  const [activeClusterId, setActiveClusterId] = useState<string | null>(null);
  const [highlightIntersections, setHighlightIntersections] = useState(false);
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingInviteCode, setPendingInviteCode] = useState<string | null>(() => {
    return readInviteCodeFromUrl() ?? readStoredInviteCode();
  });

  useEffect(() => {
    if (!getToken()) return;
    api
      .me()
      .then((response) => {
        if (
          response.user.terms_version !== LEGAL_VERSION ||
          response.user.privacy_version !== LEGAL_VERSION
        ) {
          clearToken();
          return;
        }
        setUser(response.user);
      })
      .catch(() => clearToken());
  }, []);

  useEffect(() => {
    friendOverlaysRef.current = friendOverlays;
  }, [friendOverlays]);

  const graphParamsString = useMemo(() => {
    const edgeTypes = ["collab", "catalog_collab", "similar"];
    return new URLSearchParams({
      limit: String(limit),
      min_listens: String(minListens),
      depth: String(graphDepth),
      edge_types: edgeTypes.join(",")
    }).toString();
  }, [graphDepth, limit, minListens]);

  const commitLimit = useCallback((nextValue: number) => {
    const normalized = Math.max(25, Math.min(5000, Math.round(nextValue / 50) * 50));
    setDraftLimit(normalized);
    setLimit(normalized);
  }, []);

  const commitMinListens = useCallback((nextValue: number) => {
    const normalized = Math.max(1, Number.isFinite(nextValue) ? Math.floor(nextValue) : 1);
    setDraftMinListens(normalized);
    setMinListens(normalized);
  }, []);

  const commitGraphDepth = useCallback((nextValue: number) => {
    const normalized = Math.max(1, Math.min(3, Math.round(nextValue)));
    setDraftGraphDepth(normalized);
    setGraphDepth(normalized);
  }, []);

  const commitGraphControls = useCallback(() => {
    commitLimit(draftLimit);
    commitMinListens(draftMinListens);
    commitGraphDepth(draftGraphDepth);
  }, [commitGraphDepth, commitLimit, commitMinListens, draftGraphDepth, draftLimit, draftMinListens]);

  const loadGraph = useCallback(async () => {
    if (!user) return;
    const requestSeq = graphRequestSeqRef.current + 1;
    graphRequestSeqRef.current = requestSeq;
    setLoadingGraph(true);
    setError(null);
    try {
      const nextGraph = await api.graphMe(new URLSearchParams(graphParamsString));
      if (graphRequestSeqRef.current !== requestSeq) return;
      setGraph(nextGraph);
    } catch (graphError) {
      if (graphRequestSeqRef.current !== requestSeq) return;
      setError(graphError instanceof Error ? graphError.message : "Граф не загрузился");
    } finally {
      if (graphRequestSeqRef.current === requestSeq) {
        setLoadingGraph(false);
      }
    }
  }, [graphParamsString, user]);

  const handleRefreshGraph = useCallback(() => {
    const controlsChanged =
      draftLimit !== limit ||
      draftMinListens !== minListens ||
      draftGraphDepth !== graphDepth;

    commitGraphControls();
    if (!controlsChanged) {
      void loadGraph();
    }
  }, [
    commitGraphControls,
    draftGraphDepth,
    draftLimit,
    draftMinListens,
    graphDepth,
    limit,
    loadGraph,
    minListens
  ]);

  useEffect(() => {
    if (!user) return;

    const timer = window.setTimeout(() => {
      void loadGraph();
    }, 320);

    return () => window.clearTimeout(timer);
  }, [loadGraph, user]);

  const islandsAvailable = showCollabs && (graph?.clusters?.length ?? 0) > 0;
  const islandsEnabled = showIslands && islandsAvailable;

  useEffect(() => {
    if (islandsAvailable) return;
    setShowIslands(false);
    setHoveredClusterId(null);
    setActiveClusterId(null);
  }, [islandsAvailable]);

  const setOverlayLoading = useCallback((friendId: string, isLoading: boolean) => {
    setLoadingOverlayIds((current) => {
      const next = new Set(current);
      if (isLoading) {
        next.add(friendId);
      } else {
        next.delete(friendId);
      }
      return next;
    });
  }, []);

  const toggleFriendOverlay = useCallback(
    async (friend: Friend) => {
      const friendId = friend.friend.id;
      if (friendOverlaysRef.current.some((overlay) => overlay.userId === friendId)) {
        setFriendOverlays((current) => current.filter((overlay) => overlay.userId !== friendId));
        return;
      }

      setOverlayLoading(friendId, true);
      setError(null);
      try {
        const friendGraph = await api.graphUser(friendId, new URLSearchParams(graphParamsString));
        const overlay: FriendGraphOverlay = {
          userId: friendId,
          label: friend.friend.display_login,
          color: overlayColorFor(friendId),
          graph: friendGraph
        };
        setFriendOverlays((current) =>
          current.some((item) => item.userId === friendId) ? current : [...current, overlay]
        );
      } catch (overlayError) {
        setError(
          overlayError instanceof Error
            ? overlayError.message
            : "Не получилось добавить друга на визуализацию"
        );
      } finally {
        setOverlayLoading(friendId, false);
      }
    },
    [graphParamsString, setOverlayLoading]
  );

  const handleFriendRemoved = useCallback((friendId: string) => {
    setFriendOverlays((current) => current.filter((overlay) => overlay.userId !== friendId));
    setLoadingOverlayIds((current) => {
      const next = new Set(current);
      next.delete(friendId);
      return next;
    });
  }, []);

  const handleInviteAccepted = useCallback(() => {
    clearPendingInviteCode();
    setPendingInviteCode(null);
  }, []);

  useEffect(() => {
    if (!user || friendOverlaysRef.current.length === 0) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const requestSeq = overlayRefreshSeqRef.current + 1;
      overlayRefreshSeqRef.current = requestSeq;
      const overlaysToRefresh = friendOverlaysRef.current.map(({ userId, label, color }) => ({
        userId,
        label,
        color
      }));

      overlaysToRefresh.forEach((overlay) => setOverlayLoading(overlay.userId, true));
      void Promise.all(
        overlaysToRefresh.map(async (overlay) => ({
          ...overlay,
          graph: await api.graphUser(overlay.userId, new URLSearchParams(graphParamsString))
        }))
      )
        .then((nextOverlays) => {
          if (cancelled || overlayRefreshSeqRef.current !== requestSeq) return;
          setFriendOverlays((current) =>
            nextOverlays.filter((overlay) => current.some((item) => item.userId === overlay.userId))
          );
        })
        .catch((overlayError) => {
          if (cancelled || overlayRefreshSeqRef.current !== requestSeq) return;
          setError(
            overlayError instanceof Error
              ? overlayError.message
              : "Не получилось обновить пересечения друзей"
          );
        })
        .finally(() => {
          if (overlayRefreshSeqRef.current !== requestSeq) return;
          overlaysToRefresh.forEach((overlay) => setOverlayLoading(overlay.userId, false));
        });
    }, 320);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [graphParamsString, setOverlayLoading, user]);

  useEffect(() => {
    if (friendOverlays.length === 0) {
      setHighlightIntersections(false);
    }
  }, [friendOverlays.length]);

  const overlayFriendIds = useMemo(
    () => friendOverlays.map((overlay) => overlay.userId),
    [friendOverlays]
  );

  const loadingOverlayIdList = useMemo(
    () => [...loadingOverlayIds],
    [loadingOverlayIds]
  );

  const overlayStats = useMemo(() => {
    if (!graph) return [];
    return friendOverlays.map((overlay) => {
      const friendIds = new Set(overlay.graph.nodes.map((node) => node.id));
      const friendNames = new Set(
        overlay.graph.nodes.map((node) => normalizeArtistName(node.name)).filter(Boolean)
      );
      const sharedCount = graph.nodes.filter((node) => {
        const normalizedName = normalizeArtistName(node.name);
        return friendIds.has(node.id) || (normalizedName && friendNames.has(normalizedName));
      }).length;
      const overlapPercent = graph.nodes.length > 0 ? Math.round((sharedCount / graph.nodes.length) * 1000) / 10 : 0;
      return {
        userId: overlay.userId,
        label: overlay.label,
        color: overlay.color,
        sharedCount,
        overlapPercent,
        friendArtistCount: friendIds.size
      };
    });
  }, [friendOverlays, graph]);

  const overlayMatches = useMemo<Record<string, GraphOverlayMatch[]>>(() => {
    if (!graph || friendOverlays.length === 0) return {};

    const matches: Record<string, GraphOverlayMatch[]> = {};
    for (const overlay of friendOverlays) {
      const friendIds = new Set(overlay.graph.nodes.map((node) => node.id));
      const friendNodesById = new Map(overlay.graph.nodes.map((node) => [node.id, node]));
      const friendNodesByName = new Map(
        overlay.graph.nodes.map((node) => [normalizeArtistName(node.name), node])
      );
      const friendNames = new Set(
        overlay.graph.nodes.map((node) => normalizeArtistName(node.name)).filter(Boolean)
      );
      for (const artist of graph.nodes) {
        const artistName = normalizeArtistName(artist.name);
        if (!friendIds.has(artist.id) && (!artistName || !friendNames.has(artistName))) continue;
        const friendNode = friendNodesById.get(artist.id) ?? friendNodesByName.get(artistName);
        matches[artist.id] = [
          ...(matches[artist.id] ?? []),
          {
            userId: overlay.userId,
            label: overlay.label,
            color: overlay.color,
            myScore: graphNodeScore(artist),
            friendScore: friendNode ? graphNodeScore(friendNode) : 0,
            commonTracks: commonTrackTitles(artist.listenedTracks, friendNode?.listenedTracks ?? [])
          }
        ];
      }
    }
    return matches;
  }, [friendOverlays, graph]);

  function logout() {
    clearToken();
    setUser(null);
    setGraph(null);
    setFriendOverlays([]);
  }

  async function deleteAccount() {
    const confirmed = window.confirm(
      "Удалить аккаунт Music Graph и сохраненные данные: токены Яндекса, историю, статистику, граф, друзей и приглашения? Это действие нельзя отменить."
    );
    if (!confirmed) return;

    try {
      await api.deleteMe();
      clearToken();
      setUser(null);
      setGraph(null);
      setFriendOverlays([]);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Не удалось удалить данные");
    }
  }

  if (!user) {
    return <LoginScreen onLogin={setUser} />;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Music Graph</p>
          <h1>{user.display_login}</h1>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button danger"
            onClick={() => void deleteAccount()}
            aria-label="delete account data"
            title="Удалить аккаунт Music Graph и все сохраненные данные"
          >
            <Trash2 size={18} />
          </button>
          <button className="icon-button" onClick={logout} aria-label="logout" title="Выйти только на этом устройстве">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <section className="dashboard-guide" aria-label="Как читать Music Graph">
        <div>
          <p className="eyebrow">Как читать граф</p>
          <h2>Это карта твоих артистов, коллабов и похожих музыкальных островов</h2>
        </div>
        <div className="dashboard-guide-grid">
          {dashboardGuide.map((item) => (
            <article key={item.title}>
              <strong>{item.title}</strong>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="layout">
        <aside className="left-rail">
          <FriendsPanel
            initialInviteCode={pendingInviteCode}
            onInviteAccepted={handleInviteAccepted}
            overlayFriendIds={overlayFriendIds}
            loadingOverlayIds={loadingOverlayIdList}
            onToggleOverlayFriend={(friend) => void toggleFriendOverlay(friend)}
            onFriendRemoved={handleFriendRemoved}
          />
        </aside>

        <section className="workspace">
          <SyncPanel
            onComplete={loadGraph}
          />

          <section className="toolbar-section controls">
            <div className="search-box" title="Фильтрует граф по имени артиста и оставляет связанные с ним узлы">
              <Search size={17} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти артиста" />
            </div>
            <label className="slider-control" title="Сколько основных артистов брать в граф по твоей статистике">
              <SlidersHorizontal size={17} />
              <span>Top {draftLimit}</span>
              <input
                type="range"
                min="25"
                max="5000"
                step="50"
                value={draftLimit}
                onBlur={(event) => commitLimit(Number(event.currentTarget.value))}
                onChange={(event) => setDraftLimit(Number(event.target.value))}
                onKeyUp={(event) => commitLimit(Number(event.currentTarget.value))}
                onPointerCancel={(event) => commitLimit(Number(event.currentTarget.value))}
                onPointerUp={(event) => commitLimit(Number(event.currentTarget.value))}
              />
            </label>
            <label className="number-control" title="Минимум синхронизированных прослушиваний, чтобы артист попал в основу графа">
              Min
              <input
                type="number"
                min="1"
                value={draftMinListens}
                onBlur={(event) => commitMinListens(Number(event.currentTarget.value))}
                onChange={(event) => setDraftMinListens(Math.max(1, Number(event.target.value)))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitMinListens(Number(event.currentTarget.value));
                  }
                }}
              />
            </label>
            <label className="slider-control" title="Сколько слоёв связей показывать: 1 — от твоих артистов, 2 — от найденных артистов дальше, 3 — ещё глубже">
              <SlidersHorizontal size={17} />
              <span>Глубина {draftGraphDepth}</span>
              <input
                type="range"
                min="1"
                max="3"
                step="1"
                value={draftGraphDepth}
                onBlur={(event) => commitGraphDepth(Number(event.currentTarget.value))}
                onChange={(event) => setDraftGraphDepth(Number(event.target.value))}
                onKeyUp={(event) => commitGraphDepth(Number(event.currentTarget.value))}
                onPointerCancel={(event) => commitGraphDepth(Number(event.currentTarget.value))}
                onPointerUp={(event) => commitGraphDepth(Number(event.currentTarget.value))}
              />
            </label>
            <label className="slider-control force-control" title="Сила отталкивания пузырей: больше значение — артисты сильнее разъезжаются, меньше — граф плотнее">
              <SlidersHorizontal size={17} />
              <span>Отталкивание {repulsionStrength}</span>
              <input
                type="range"
                min="120"
                max="2200"
                step="20"
                value={repulsionStrength}
                onChange={(event) => setRepulsionStrength(Number(event.target.value))}
              />
            </label>
            <label className="toggle-chip" title="Коллабы из твоих лайков, истории и волны: артисты на одном прослушанном треке">
              <input
                type="checkbox"
                checked={showCollabs}
                onChange={(event) => setShowCollabs(event.target.checked)}
              />
              <Filter size={15} />
              Мои коллабы
            </label>
            <label className="toggle-chip" title="Показывает синие связи из дискографии: найденные коллабы, которые не совпадают с уже прослушанными треками">
              <input
                type="checkbox"
                checked={showCatalogCollabs}
                onChange={(event) => setShowCatalogCollabs(event.target.checked)}
              />
              Дискография
            </label>
            <label className="toggle-chip" title="Похожие артисты Яндекса. Показываются только артисты, у которых знакомых треков больше 0">
              <input
                type="checkbox"
                checked={showSimilar}
                onChange={(event) => setShowSimilar(event.target.checked)}
              />
              Похожие
            </label>
            <label
              className="toggle-chip islands-toggle"
              title={
                islandsAvailable
                  ? "Подсветить музыкальные острова: группы артистов, связанных твоими прослушанными коллабами"
                  : "Острова появятся, когда в графе есть прослушанные коллабы"
              }
            >
              <input
                type="checkbox"
                checked={islandsEnabled}
                disabled={!islandsAvailable}
                onChange={(event) => setShowIslands(event.target.checked)}
              />
              Острова(beta)
            </label>
            <label
              className="toggle-chip intersection-toggle"
              title={
                friendOverlays.length === 0
                  ? "Сначала добавь друга кнопкой + в панели друзей"
                  : "Приглушить все не-общие вершины и оставить яркими пересечения с добавленными пользователями"
              }
            >
              <input
                type="checkbox"
                checked={highlightIntersections}
                disabled={friendOverlays.length === 0}
                onChange={(event) => setHighlightIntersections(event.target.checked)}
              />
              Пересечения
            </label>
            <button
              className="icon-button wide"
              disabled={loadingGraph}
              onClick={handleRefreshGraph}
              title="Перезагрузить граф с текущими фильтрами"
            >
              Обновить граф
            </button>
          </section>
          {overlayStats.length > 0 && (
            <section className="comparison-strip overlay-strip">
              <span>Пересечения на графе</span>
              {overlayStats.map((item) => (
                <button
                  className="overlay-stat-chip"
                  key={item.userId}
                  onClick={() =>
                    setFriendOverlays((current) =>
                      current.filter((overlay) => overlay.userId !== item.userId)
                    )
                  }
                  style={{ "--overlay-color": item.color } as CSSProperties}
                  title="Убрать пользователя с визуализации"
                  type="button"
                >
                  <i />
                  <strong>{item.sharedCount}</strong>
                  <span>{item.label}, {item.overlapPercent}%</span>
                </button>
              ))}
            </section>
          )}

          {error && <p className="error-text">{error}</p>}
          <GraphCanvas
            graph={graph}
            search={search}
            repulsionStrength={repulsionStrength}
            showCollabEdges={showCollabs}
            showCatalogCollabEdges={showCatalogCollabs}
            showSimilarEdges={showSimilar}
            overlayMatches={overlayMatches}
            highlightIntersections={highlightIntersections}
            showIslands={islandsEnabled}
            hoveredClusterId={hoveredClusterId}
            activeClusterId={activeClusterId}
            onHoverCluster={setHoveredClusterId}
            onSelectCluster={setActiveClusterId}
          />
          <ClusterIslandsPanel
            activeClusterId={activeClusterId}
            enabled={islandsEnabled}
            graph={graph}
            onHoverCluster={setHoveredClusterId}
            onSelectCluster={setActiveClusterId}
          />
          <SharedArtistsPanel graph={graph} overlayMatches={overlayMatches} />
          <GraphStatsPanel graph={graph} />
          <PlaylistPanel disabled={!graph || graph.nodes.length === 0} />
        </section>
      </section>

      <footer className="app-footer">
        <strong>Music Graph</strong>
        <span>Неофициальный эксперимент поверх Яндекс Музыки: данные хранятся локально в этом проекте и удаляются кнопкой с корзиной вверху.</span>
        <span>Плейлисты создаются только после твоего подтверждения и приватными по умолчанию.</span>
      </footer>
    </main>
  );
}
