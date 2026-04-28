from types import SimpleNamespace

from app.schemas.graph import GraphEdge, GraphNode
from app.services.graph_service import (
    _build_graph_clusters,
    _should_include_neighbor,
    _unheard_catalog_tracks,
    edge_key,
    mark_shared_nodes,
)


def test_edge_key_normalizes_artist_order() -> None:
    assert edge_key("b", "a", "collab") == ("a", "b", "collab")


def test_unheard_catalog_tracks_excludes_listened_track_titles() -> None:
    tracks = _unheard_catalog_tracks(
        ["Эпитафия", " Чтобы не забыть ", "эпитафия"],
        {"  эпитафия "},
    )

    assert tracks == [" Чтобы не забыть "]


def test_mark_shared_nodes_flags_matching_artists() -> None:
    nodes = [
        GraphNode(id="a", name="Artist A", listenCount=3, trackCount=2),
        GraphNode(id="b", name="Artist B", listenCount=1, trackCount=1),
    ]

    marked = mark_shared_nodes(nodes, {"b", "c"})

    assert marked[0].isShared is False
    assert marked[1].isShared is True


def test_catalog_collab_with_track_evidence_is_hidden_without_user_stats() -> None:
    edge = SimpleNamespace(tracks=["Epitaph"])

    assert _should_include_neighbor("catalog_collab", edge, {}, "5465911") is False


def test_catalog_collab_with_known_stats_is_visible() -> None:
    edge = SimpleNamespace(tracks=[])
    stats = {"4077045": {"knownTrackCount": 7}}

    assert _should_include_neighbor("catalog_collab", edge, stats, "4077045") is True


def test_catalog_collab_with_local_listens_is_visible() -> None:
    edge = SimpleNamespace(tracks=[])
    stats = {"4077045": {"listenCount": 3, "trackCount": 1}}

    assert _should_include_neighbor("catalog_collab", edge, stats, "4077045") is True


def test_catalog_collab_without_tracks_or_known_stats_is_hidden() -> None:
    edge = SimpleNamespace(tracks=[])

    assert _should_include_neighbor("catalog_collab", edge, {}, "5465911") is False


def test_similar_without_known_stats_is_hidden() -> None:
    edge = SimpleNamespace(tracks=[])

    assert _should_include_neighbor("similar", edge, {}, "5465911") is False


def test_similar_with_known_stats_is_visible() -> None:
    edge = SimpleNamespace(tracks=[])
    stats = {"5465911": {"knownTrackCount": 1}}

    assert _should_include_neighbor("similar", edge, stats, "5465911") is True


def test_graph_clusters_group_listened_collabs() -> None:
    nodes = [
        GraphNode(id="a", name="ATL", listenCount=8, trackCount=5),
        GraphNode(id="b", name="Horus", listenCount=4, trackCount=3),
        GraphNode(id="c", name="Lupercal", listenCount=2, trackCount=1),
    ]
    edges = [
        GraphEdge(source="a", target="b", type="collab", weight=3, tracks=["Track"]),
        GraphEdge(source="b", target="c", type="collab", weight=1, tracks=["Track 2"]),
    ]

    clusters = _build_graph_clusters(nodes, edges)

    assert len(clusters) == 1
    assert clusters[0].nodeIds == ["a", "b", "c"]
    assert clusters[0].label == "ATL / Horus / Lupercal"
    assert {node.clusterId for node in nodes} == {clusters[0].id}


def test_graph_clusters_ignore_similar_and_catalog_edges() -> None:
    nodes = [
        GraphNode(id="a", name="Artist A", listenCount=8, trackCount=5),
        GraphNode(id="b", name="Artist B", listenCount=4, trackCount=3),
        GraphNode(id="c", name="Artist C", listenCount=2, trackCount=1),
    ]
    edges = [
        GraphEdge(source="a", target="b", type="similar", weight=10, tracks=[]),
        GraphEdge(source="b", target="c", type="catalog_collab", weight=10, tracks=["Unheard"]),
    ]

    clusters = _build_graph_clusters(nodes, edges)

    assert clusters == []
    assert all(node.clusterId is None for node in nodes)


def test_graph_clusters_do_not_create_single_artist_islands() -> None:
    nodes = [
        GraphNode(id="a", name="Artist A", listenCount=8, trackCount=5),
        GraphNode(id="b", name="Artist B", listenCount=4, trackCount=3),
    ]
    edges = [GraphEdge(source="a", target="missing", type="collab", weight=3, tracks=["Track"])]

    clusters = _build_graph_clusters(nodes, edges)

    assert clusters == []
    assert all(node.clusterId is None for node in nodes)
