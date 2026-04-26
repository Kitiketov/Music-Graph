from types import SimpleNamespace

from app.services.yandex_music_service import (
    ArtistSnapshot,
    TrackSnapshot,
    _artist_familiar_from_info,
    _catalog_collabs_from_tracks,
    _history_track_refs,
    _tracks_from_history,
    _tracks_from_likes,
    fetch_listening_snapshot,
)


async def test_mock_snapshot_has_tracks_and_similar(monkeypatch) -> None:
    monkeypatch.setattr("app.services.yandex_music_service.settings.mock_yandex", True)

    snapshot = await fetch_listening_snapshot("mock-token")

    assert snapshot.tracks
    assert snapshot.similar_artists
    assert snapshot.artist_familiar
    assert snapshot.source_status["history"] == "mock"
    assert snapshot.similar_source_ids
    assert snapshot.catalog_source_ids


def test_tracks_from_likes_fetches_full_track_data() -> None:
    short_track = SimpleNamespace(id="42", timestamp="2026-04-26T12:00:00+00:00", track=None)
    full_track = SimpleNamespace(
        id="42",
        title="Liked Song",
        artists=[SimpleNamespace(id="7", name="Liked Artist", cover=None, image_url=None, og_image=None)],
        cover_uri=None,
        duration_ms=123000,
    )
    likes = SimpleNamespace(tracks=[short_track], fetch_tracks=lambda: [full_track])

    tracks = _tracks_from_likes(likes)

    assert len(tracks) == 1
    assert tracks[0].source == "liked_tracks"
    assert tracks[0].title == "Liked Song"
    assert tracks[0].artists[0].name == "Liked Artist"


def test_tracks_from_history_resolves_history_refs_through_client_tracks() -> None:
    history = SimpleNamespace(
        history_tabs=[
            SimpleNamespace(
                items=[
                    SimpleNamespace(
                        tracks=[
                            SimpleNamespace(id="1", timestamp="2026-04-26T12:00:00+00:00"),
                            SimpleNamespace(track_id="2", played_at="2026-04-26T12:03:00+00:00"),
                            SimpleNamespace(data={"item_id": {"track_id": "3", "album_id": "30"}}),
                        ]
                    )
                ]
            )
        ]
    )
    full_tracks = [
        SimpleNamespace(
            id="1",
            title="History One",
            artists=[SimpleNamespace(id="a1", name="Artist One", cover=None, image_url=None, og_image=None)],
            cover_uri=None,
            duration_ms=1000,
        ),
        SimpleNamespace(
            id="2",
            title="History Two",
            artists=[SimpleNamespace(id="a2", name="Artist Two", cover=None, image_url=None, og_image=None)],
            cover_uri=None,
            duration_ms=2000,
        ),
        SimpleNamespace(
            id="3",
            title="History Three",
            artists=[SimpleNamespace(id="a3", name="Artist Three", cover=None, image_url=None, og_image=None)],
            cover_uri=None,
            duration_ms=3000,
        ),
    ]
    requested_ids: list[str] = []

    def tracks(track_ids: list[str]) -> list[SimpleNamespace]:
        requested_ids.extend(track_ids)
        return full_tracks

    resolved, ref_count, missing_count, failure_count = _tracks_from_history(SimpleNamespace(tracks=tracks), history)

    assert _history_track_refs(history)[0][0] == "1"
    assert requested_ids == ["1", "2", "3"]
    assert ref_count == 3
    assert missing_count == 0
    assert failure_count == 0
    assert [track.title for track in resolved] == ["History One", "History Two", "History Three"]
    assert all(track.source == "history" for track in resolved)


def test_artist_familiar_from_info_sums_wave_and_collection() -> None:
    familiar = _artist_familiar_from_info(
        "5774696",
        {
            "wave": {"trackCount": 83},
            "collection": {"trackCount": 12, "albumCount": 0},
        },
    )

    assert familiar is not None
    assert familiar.known_track_count == 95
    assert familiar.wave_track_count == 83
    assert familiar.collection_track_count == 12


def test_catalog_collabs_from_tracks_counts_featured_artists() -> None:
    source = ArtistSnapshot("1", "Source")
    featured = ArtistSnapshot("2", "Featured")
    other = ArtistSnapshot("3", "Other")
    tracks = [
        TrackSnapshot("t1", "Song One", [source, featured], source="artist_catalog"),
        TrackSnapshot("t2", "Song Two", [source, featured, other], source="artist_catalog"),
        TrackSnapshot("t3", "Not Source Song", [featured, other], source="artist_catalog"),
    ]

    collabs = _catalog_collabs_from_tracks("1", tracks)

    assert [(item.artist.id, item.weight) for item in collabs] == [("2", 2), ("3", 1)]
    assert collabs[0].tracks == ["Song One", "Song Two"]
