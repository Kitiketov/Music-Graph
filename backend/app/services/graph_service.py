from __future__ import annotations

from collections import defaultdict
from itertools import combinations
from uuid import UUID

from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Artist, ArtistEdge, Friendship, Track, TrackArtist, UserArtistStat, UserListen
from app.schemas.graph import CompareResponse, GraphCluster, GraphEdge, GraphNode, GraphResponse
from app.services.sync_service import get_latest_source_status


def mark_shared_nodes(nodes: list[GraphNode], shared_ids: set[str]) -> list[GraphNode]:
    for node in nodes:
        node.isShared = node.id in shared_ids
    return nodes


CLUSTER_COLORS = ["#1f8a70", "#cf4b3f", "#2f6fbd", "#d79b28", "#7b61ff", "#e26d3d", "#139f8f", "#8c5a3c"]


def edge_key(left: str, right: str, edge_type: str) -> tuple[str, str, str]:
    source, target = sorted([left, right])
    return source, target, edge_type


def artist_pair_key(left: str, right: str) -> tuple[str, str]:
    source, target = sorted([left, right])
    return source, target


def _normalize_track_title(title: str) -> str:
    return " ".join(title.casefold().strip().split())


def _catalog_track_title(track: object) -> str:
    if isinstance(track, dict):
        return str(track.get("title") or "")
    return str(track)


def _unheard_catalog_tracks(catalog_tracks: list[object], listened_tracks: set[str]) -> list[str]:
    listened = {_normalize_track_title(track) for track in listened_tracks if track.strip()}
    result: list[str] = []
    seen: set[str] = set()
    for track in catalog_tracks:
        title = _catalog_track_title(track)
        normalized = _normalize_track_title(title)
        if not normalized or normalized in listened or normalized in seen:
            continue
        result.append(title)
        seen.add(normalized)
    return result


def _node_from_artist(
    artist: Artist,
    stats: dict[str, dict],
    *,
    is_similar_only: bool = False,
    is_catalog_only: bool = False,
) -> GraphNode:
    item = stats.get(artist.id, {})
    return GraphNode(
        id=artist.id,
        name=artist.name,
        image=artist.image_url,
        listenCount=item.get("listenCount", 0),
        trackCount=item.get("trackCount", 0),
        knownTrackCount=item.get("knownTrackCount"),
        waveTrackCount=item.get("waveTrackCount"),
        collectionTrackCount=item.get("collectionTrackCount"),
        collectionAlbumCount=item.get("collectionAlbumCount"),
        listenedTracks=item.get("listenedTracks", []),
        isLikedArtist=item.get("isLikedArtist", False),
        isSimilarOnly=is_similar_only,
        isCatalogOnly=is_catalog_only,
    )


def _has_known_tracks(stats: dict[str, dict], artist_id: str) -> bool:
    return (stats.get(artist_id, {}).get("knownTrackCount") or 0) > 0


def _has_user_track_evidence(stats: dict[str, dict], artist_id: str) -> bool:
    item = stats.get(artist_id, {})
    return (
        (item.get("knownTrackCount") or 0) > 0
        or (item.get("listenCount") or 0) > 0
        or (item.get("trackCount") or 0) > 0
    )


def _should_include_neighbor(edge_type: str, _edge: ArtistEdge, stats: dict[str, dict], artist_id: str) -> bool:
    if edge_type == "catalog_collab":
        return _has_user_track_evidence(stats, artist_id)
    return _has_known_tracks(stats, artist_id)


def _node_cluster_score(node: GraphNode) -> tuple[int, int, int, str]:
    return (
        node.knownTrackCount or node.trackCount or node.listenCount,
        node.listenCount,
        node.trackCount,
        node.name.casefold(),
    )


def _build_graph_clusters(nodes: list[GraphNode], edges: list[GraphEdge]) -> list[GraphCluster]:
    node_by_id = {node.id: node for node in nodes}
    adjacency: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    for edge in edges:
        if edge.type != "collab" or edge.source not in node_by_id or edge.target not in node_by_id:
            continue
        weight = max(int(edge.weight), 1)
        adjacency[edge.source][edge.target] += weight
        adjacency[edge.target][edge.source] += weight

    connected_ids = {node_id for node_id, neighbors in adjacency.items() if neighbors}
    if not connected_ids:
        for node in nodes:
            node.clusterId = None
        return []

    labels = {node_id: node_id for node_id in connected_ids}
    seed_rank = {
        node_id: index
        for index, node_id in enumerate(
            sorted(connected_ids, key=lambda item: (_node_cluster_score(node_by_id[item]), item), reverse=True)
        )
    }
    ordered_ids = sorted(connected_ids, key=lambda item: (_node_cluster_score(node_by_id[item]), item), reverse=True)

    for _ in range(12):
        changed = False
        for node_id in ordered_ids:
            scores: dict[str, int] = defaultdict(int)
            for neighbor_id, weight in adjacency[node_id].items():
                scores[labels[neighbor_id]] += weight
            if not scores:
                continue
            best_label = max(scores, key=lambda label: (scores[label], -seed_rank.get(label, 0), label))
            if best_label != labels[node_id]:
                labels[node_id] = best_label
                changed = True
        if not changed:
            break

    groups: dict[str, list[str]] = defaultdict(list)
    for node_id, label in labels.items():
        groups[label].append(node_id)

    clusters: list[GraphCluster] = []
    cluster_groups = [sorted(group) for group in groups.values() if len(group) > 1]
    cluster_groups.sort(
        key=lambda group: (
            sum(node_by_id[node_id].listenCount for node_id in group),
            len(group),
            max(_node_cluster_score(node_by_id[node_id]) for node_id in group),
        ),
        reverse=True,
    )

    clustered_ids: set[str] = set()
    for index, node_ids in enumerate(cluster_groups, start=1):
        cluster_id = f"island-{index}"
        ranked_nodes = sorted(
            (node_by_id[node_id] for node_id in node_ids),
            key=lambda node: (_node_cluster_score(node), node.id),
            reverse=True,
        )
        top_artists = [node.name for node in ranked_nodes[:3]]
        for node_id in node_ids:
            node_by_id[node_id].clusterId = cluster_id
            clustered_ids.add(node_id)
        clusters.append(
            GraphCluster(
                id=cluster_id,
                label=" / ".join(top_artists),
                color=CLUSTER_COLORS[(index - 1) % len(CLUSTER_COLORS)],
                nodeIds=node_ids,
                size=len(node_ids),
                totalListenCount=sum(node_by_id[node_id].listenCount for node_id in node_ids),
                totalTrackCount=sum(node_by_id[node_id].trackCount for node_id in node_ids),
                topArtists=top_artists,
            )
        )

    for node in nodes:
        if node.id not in clustered_ids:
            node.clusterId = None

    return clusters


async def _add_neighbor_nodes(
    db: AsyncSession,
    *,
    edge_type: str,
    frontier_ids: set[str],
    selected_ids: set[str],
    stats: dict[str, dict],
    neighbor_nodes: dict[str, GraphNode],
) -> set[str]:
    if not frontier_ids:
        return set()

    result = await db.execute(
        select(ArtistEdge, Artist)
        .join(
            Artist,
            Artist.id
            == case(
                (ArtistEdge.source_artist_id.in_(frontier_ids), ArtistEdge.target_artist_id),
                else_=ArtistEdge.source_artist_id,
            ),
        )
        .where(
            ArtistEdge.type == edge_type,
            (ArtistEdge.source_artist_id.in_(frontier_ids) | ArtistEdge.target_artist_id.in_(frontier_ids)),
        )
        .order_by(ArtistEdge.weight.desc())
    )

    added_ids: set[str] = set()
    existing_neighbor_ids = set(neighbor_nodes)
    for edge, artist in result.all():
        if artist.id in selected_ids or not _should_include_neighbor(edge_type, edge, stats, artist.id):
            continue

        node = neighbor_nodes.get(artist.id)
        if node:
            if edge_type == "similar":
                node.isSimilarOnly = True
            if edge_type == "catalog_collab":
                node.isCatalogOnly = True
        else:
            neighbor_nodes[artist.id] = _node_from_artist(
                artist,
                stats,
                is_similar_only=edge_type == "similar",
                is_catalog_only=edge_type == "catalog_collab",
            )
        if artist.id not in existing_neighbor_ids:
            added_ids.add(artist.id)
    return added_ids


async def _listened_artist_stats(db: AsyncSession, user_id: UUID) -> dict[str, dict]:
    result = await db.execute(
        select(
            Artist.id,
            Artist.name,
            Artist.image_url,
            func.count(UserListen.id).label("listen_count"),
            func.count(func.distinct(UserListen.track_id)).label("track_count"),
            func.max(UserArtistStat.known_track_count).label("known_track_count"),
            func.max(UserArtistStat.wave_track_count).label("wave_track_count"),
            func.max(UserArtistStat.collection_track_count).label("collection_track_count"),
            func.max(UserArtistStat.collection_album_count).label("collection_album_count"),
            func.bool_or(UserArtistStat.is_liked_artist).label("is_liked_artist"),
            func.array_agg(func.distinct(Track.title)).label("listened_tracks"),
        )
        .join(TrackArtist, TrackArtist.artist_id == Artist.id)
        .join(UserListen, UserListen.track_id == TrackArtist.track_id)
        .join(Track, Track.id == UserListen.track_id)
        .outerjoin(
            UserArtistStat,
            and_(UserArtistStat.user_id == user_id, UserArtistStat.artist_id == Artist.id),
        )
        .where(UserListen.user_id == user_id)
        .group_by(Artist.id, Artist.name, Artist.image_url)
    )
    return {
        artist_id: {
            "id": artist_id,
            "name": name,
            "image": image_url,
            "listenCount": int(listen_count),
            "trackCount": int(track_count),
            "knownTrackCount": int(known_track_count) if known_track_count is not None else None,
            "waveTrackCount": int(wave_track_count) if wave_track_count is not None else None,
            "collectionTrackCount": int(collection_track_count) if collection_track_count is not None else None,
            "collectionAlbumCount": int(collection_album_count) if collection_album_count is not None else None,
            "isLikedArtist": bool(is_liked_artist),
            "listenedTracks": sorted({track for track in (listened_tracks or []) if track})[:80],
        }
        for (
            artist_id,
            name,
            image_url,
            listen_count,
            track_count,
            known_track_count,
            wave_track_count,
            collection_track_count,
            collection_album_count,
            is_liked_artist,
            listened_tracks,
        ) in result.all()
    }


async def _known_artist_stats(db: AsyncSession, user_id: UUID) -> dict[str, dict]:
    result = await db.execute(
        select(
            Artist.id,
            Artist.name,
            Artist.image_url,
            UserArtistStat.known_track_count,
            UserArtistStat.wave_track_count,
            UserArtistStat.collection_track_count,
            UserArtistStat.collection_album_count,
            UserArtistStat.is_liked_artist,
        )
        .join(UserArtistStat, UserArtistStat.artist_id == Artist.id)
        .where(UserArtistStat.user_id == user_id)
    )
    return {
        artist_id: {
            "id": artist_id,
            "name": name,
            "image": image_url,
            "listenCount": 0,
            "trackCount": 0,
            "knownTrackCount": int(known_track_count),
            "waveTrackCount": int(wave_track_count),
            "collectionTrackCount": int(collection_track_count),
            "collectionAlbumCount": int(collection_album_count),
            "isLikedArtist": bool(is_liked_artist),
            "listenedTracks": [],
        }
        for (
            artist_id,
            name,
            image_url,
            known_track_count,
            wave_track_count,
            collection_track_count,
            collection_album_count,
            is_liked_artist,
        ) in result.all()
    }


async def artist_ids_for_user(db: AsyncSession, user_id: UUID) -> set[str]:
    stats = await _listened_artist_stats(db, user_id)
    known_stats = await _known_artist_stats(db, user_id)
    known_ids = {
        artist_id
        for artist_id, item in known_stats.items()
        if (item.get("knownTrackCount") or 0) > 0
    }
    return set(stats) | known_ids


async def are_friends(db: AsyncSession, user_id: UUID, friend_id: UUID) -> bool:
    result = await db.execute(
        select(Friendship.id).where(Friendship.user_id == user_id, Friendship.friend_id == friend_id)
    )
    return result.scalar_one_or_none() is not None


async def build_user_graph(
    db: AsyncSession,
    *,
    viewer_id: UUID,
    owner_id: UUID,
    limit: int = 100,
    min_listens: int = 1,
    depth: int = 1,
    edge_types: set[str] | None = None,
    shared_with_user_id: UUID | None = None,
) -> GraphResponse:
    if viewer_id != owner_id and not await are_friends(db, viewer_id, owner_id):
        raise PermissionError("Graph is visible only to friends")

    edge_types = edge_types or {"collab"}
    if "similar_deep" in edge_types:
        edge_types.add("similar")
        depth = max(depth, 2)
    if "catalog_collab_deep" in edge_types:
        edge_types.add("catalog_collab")
        depth = max(depth, 2)
    depth = max(1, min(depth, 3))

    stats = await _listened_artist_stats(db, owner_id)
    display_stats = {**await _known_artist_stats(db, owner_id), **stats}
    ranked = sorted(
        (item for item in stats.values() if item["listenCount"] >= min_listens),
        key=lambda item: (
            item["knownTrackCount"] or item["trackCount"] or item["listenCount"],
            item["listenCount"],
            item["trackCount"],
            item["name"].lower(),
        ),
        reverse=True,
    )
    selected = ranked[: max(limit, 1)]
    selected_ids = {item["id"] for item in selected}

    neighbor_nodes: dict[str, GraphNode] = {}
    if "similar" in edge_types and selected_ids:
        frontier_ids = selected_ids
        for _layer in range(depth):
            frontier_ids = await _add_neighbor_nodes(
                db,
                edge_type="similar",
                frontier_ids=frontier_ids,
                selected_ids=selected_ids,
                stats=display_stats,
                neighbor_nodes=neighbor_nodes,
            )
            if not frontier_ids:
                break

    if "catalog_collab" in edge_types and selected_ids:
        frontier_ids = selected_ids
        for _layer in range(depth):
            frontier_ids = await _add_neighbor_nodes(
                db,
                edge_type="catalog_collab",
                frontier_ids=frontier_ids,
                selected_ids=selected_ids,
                stats=display_stats,
                neighbor_nodes=neighbor_nodes,
            )
            if not frontier_ids:
                break

    nodes = [
        GraphNode(
            id=item["id"],
            name=item["name"],
            image=item["image"],
            listenCount=item["listenCount"],
            trackCount=item["trackCount"],
            knownTrackCount=item["knownTrackCount"],
            waveTrackCount=item["waveTrackCount"],
            collectionTrackCount=item["collectionTrackCount"],
            collectionAlbumCount=item["collectionAlbumCount"],
            listenedTracks=item["listenedTracks"],
            isLikedArtist=item.get("isLikedArtist", False),
        )
        for item in selected
    ]
    nodes.extend(neighbor_nodes.values())

    node_ids = {node.id for node in nodes}
    edges: dict[tuple[str, str, str], GraphEdge] = {}
    listened_tracks_by_pair: dict[tuple[str, str], set[str]] = defaultdict(set)

    if {"collab", "catalog_collab"} & edge_types:
        track_rows = await db.execute(
            select(UserListen.track_id, Track.title, Artist.id)
            .join(Track, Track.id == UserListen.track_id)
            .join(TrackArtist, TrackArtist.track_id == Track.id)
            .join(Artist, Artist.id == TrackArtist.artist_id)
            .where(UserListen.user_id == owner_id, Artist.id.in_(node_ids))
        )
        artists_by_track: dict[str, set[str]] = defaultdict(set)
        titles_by_track: dict[str, str] = {}
        listen_counts_by_track: dict[str, int] = defaultdict(int)
        for track_id, title, artist_id in track_rows.all():
            artists_by_track[track_id].add(artist_id)
            titles_by_track[track_id] = title
            listen_counts_by_track[track_id] += 1

        for track_id, artist_ids in artists_by_track.items():
            for left, right in combinations(sorted(artist_ids), 2):
                title = titles_by_track[track_id]
                listened_tracks_by_pair[artist_pair_key(left, right)].add(title)
                if "collab" in edge_types:
                    key = edge_key(left, right, "collab")
                    if key not in edges:
                        edges[key] = GraphEdge(source=left, target=right, type="collab", weight=0, tracks=[])
                    edges[key].weight += max(1, listen_counts_by_track[track_id] // max(len(artist_ids), 1))
                    if title not in edges[key].tracks:
                        edges[key].tracks.append(title)

    if "similar" in edge_types:
        result = await db.execute(
            select(ArtistEdge).where(
                ArtistEdge.type == "similar",
                ArtistEdge.source_artist_id.in_(node_ids),
                ArtistEdge.target_artist_id.in_(node_ids),
            )
        )
        for edge in result.scalars().all():
            key = edge_key(edge.source_artist_id, edge.target_artist_id, "similar")
            edges[key] = GraphEdge(
                source=key[0],
                target=key[1],
                type="similar",
                weight=edge.weight,
                tracks=edge.tracks or [],
            )

    if "catalog_collab" in edge_types:
        result = await db.execute(
            select(ArtistEdge).where(
                ArtistEdge.type == "catalog_collab",
                ArtistEdge.source_artist_id.in_(node_ids),
                ArtistEdge.target_artist_id.in_(node_ids),
            )
        )
        for edge in result.scalars().all():
            key = edge_key(edge.source_artist_id, edge.target_artist_id, "catalog_collab")
            unheard_tracks = _unheard_catalog_tracks(
                edge.tracks or [],
                listened_tracks_by_pair.get(artist_pair_key(edge.source_artist_id, edge.target_artist_id), set()),
            )
            if not unheard_tracks:
                continue
            edges[key] = GraphEdge(
                source=key[0],
                target=key[1],
                type="catalog_collab",
                weight=max(1, len(unheard_tracks)),
                tracks=unheard_tracks,
            )

    if shared_with_user_id:
        shared_ids = await artist_ids_for_user(db, owner_id) & await artist_ids_for_user(db, shared_with_user_id)
        mark_shared_nodes(nodes, shared_ids)

    sorted_edges = sorted(edges.values(), key=lambda item: (item.type, -item.weight))
    clusters = _build_graph_clusters(nodes, sorted_edges) if "collab" in edge_types else []

    return GraphResponse(
        nodes=nodes,
        edges=sorted_edges,
        clusters=clusters,
        sourceStatus=await get_latest_source_status(db, owner_id),
    )


async def compare_users(db: AsyncSession, *, viewer_id: UUID, friend_id: UUID) -> CompareResponse:
    if not await are_friends(db, viewer_id, friend_id):
        raise PermissionError("Comparison is visible only to friends")
    my_ids = await artist_ids_for_user(db, viewer_id)
    friend_ids = await artist_ids_for_user(db, friend_id)
    shared = sorted(my_ids & friend_ids)
    denominator = max(len(my_ids | friend_ids), 1)
    return CompareResponse(
        friendId=str(friend_id),
        sharedArtistIds=shared,
        sharedCount=len(shared),
        myArtistCount=len(my_ids),
        friendArtistCount=len(friend_ids),
        overlapPercent=round(len(shared) / denominator * 100, 2),
    )
