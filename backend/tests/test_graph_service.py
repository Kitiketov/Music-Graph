from types import SimpleNamespace

from app.schemas.graph import GraphNode
from app.services.graph_service import _should_include_neighbor, _unheard_catalog_tracks, edge_key, mark_shared_nodes


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
