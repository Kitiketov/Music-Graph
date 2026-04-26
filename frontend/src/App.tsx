import { useCallback, useEffect, useState } from "react";
import { Filter, LogOut, Search, SlidersHorizontal, Trash2 } from "lucide-react";
import { api, clearToken, getToken } from "./api/client";
import { FriendsPanel } from "./components/FriendsPanel";
import { GraphCanvas } from "./components/GraphCanvas";
import { LoginScreen } from "./components/LoginScreen";
import { SyncPanel } from "./components/SyncPanel";
import { LEGAL_VERSION } from "./legal";
import type { CompareResponse, GraphResponse, User } from "./types/api";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [compare, setCompare] = useState<CompareResponse | null>(null);
  const [limit, setLimit] = useState(100);
  const [minListens, setMinListens] = useState(1);
  const [search, setSearch] = useState("");
  const [graphDepth, setGraphDepth] = useState(1);
  const [repulsionStrength, setRepulsionStrength] = useState(760);
  const [showCollabs, setShowCollabs] = useState(true);
  const [showCatalogCollabs, setShowCatalogCollabs] = useState(false);
  const [showSimilar, setShowSimilar] = useState(false);
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null);
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const loadGraph = useCallback(async () => {
    if (!user) return;
    setLoadingGraph(true);
    setError(null);
    try {
      const edgeTypes = [
        showCollabs ? "collab" : null,
        "catalog_collab",
        "similar"
      ].filter(Boolean);
      const params = new URLSearchParams({
        limit: String(limit),
        min_listens: String(minListens),
        depth: String(graphDepth),
        edge_types: edgeTypes.join(",")
      });
      let nextGraph: GraphResponse;
      if (selectedFriendId) {
        nextGraph = await api.graphUser(selectedFriendId, params);
        setCompare(await api.compare(selectedFriendId));
      } else {
        nextGraph = await api.graphMe(params);
        setCompare(null);
      }
      setGraph(nextGraph);
    } catch (graphError) {
      setError(graphError instanceof Error ? graphError.message : "Граф не загрузился");
    } finally {
      setLoadingGraph(false);
    }
  }, [
    limit,
    graphDepth,
    minListens,
    selectedFriendId,
    showCollabs,
    user
  ]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  function logout() {
    clearToken();
    setUser(null);
    setGraph(null);
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
      setCompare(null);
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

      <section className="layout">
        <aside className="left-rail">
          <FriendsPanel selectedFriendId={selectedFriendId} onSelectFriend={setSelectedFriendId} />
          <section className="side-panel source-panel">
            <h2>Источники</h2>
            {Object.keys(graph?.sourceStatus ?? {}).length === 0 ? (
              <p className="muted small">Нет данных sync</p>
            ) : (
              Object.entries(graph?.sourceStatus ?? {}).map(([key, value]) => (
                <p className="source-row" key={key}>
                  <span>{key}</span>
                  <strong>{value}</strong>
                </p>
              ))
            )}
          </section>
        </aside>

        <section className="workspace">
          <SyncPanel
            onComplete={loadGraph}
            autoStart={Boolean(graph && graph.nodes.length === 0 && !loadingGraph)}
            autoStartKey={user.id}
          />

          <section className="toolbar-section controls">
            <div className="search-box" title="Фильтрует граф по имени артиста и оставляет связанные с ним узлы">
              <Search size={17} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти артиста" />
            </div>
            <label className="slider-control" title="Сколько основных артистов брать в граф по твоей статистике">
              <SlidersHorizontal size={17} />
              <span>Top {limit}</span>
              <input
                type="range"
                min="25"
                max="5000"
                step="50"
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value))}
              />
            </label>
            <label className="number-control" title="Минимум синхронизированных прослушиваний, чтобы артист попал в основу графа">
              Min
              <input
                type="number"
                min="1"
                value={minListens}
                onChange={(event) => setMinListens(Math.max(1, Number(event.target.value)))}
              />
            </label>
            <label className="slider-control" title="Сколько слоёв связей показывать: 1 — от твоих артистов, 2 — от найденных артистов дальше, 3 — ещё глубже">
              <SlidersHorizontal size={17} />
              <span>Глубина {graphDepth}</span>
              <input
                type="range"
                min="1"
                max="3"
                step="1"
                value={graphDepth}
                onChange={(event) => setGraphDepth(Number(event.target.value))}
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
            <button
              className="icon-button wide"
              disabled={loadingGraph}
              onClick={() => void loadGraph()}
              title="Перезагрузить граф с текущими фильтрами"
            >
              Обновить граф
            </button>
          </section>

          {compare && (
            <section className="comparison-strip">
              <strong>{compare.sharedCount}</strong>
              <span>общих артистов</span>
              <strong>{compare.overlapPercent}%</strong>
              <span>пересечение графов</span>
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
          />
        </section>
      </section>
    </main>
  );
}
