from types import SimpleNamespace

import pytest

from app.services.yandex_music_service import (
    ArtistSnapshot,
    TrackSnapshot,
    YandexMusicUnavailableError,
    _artist_familiar_from_info,
    _catalog_collabs_from_tracks,
    _ensure_yandex_music_available,
    _familiar_tracks_from_payload,
    _fetch_artist_familiar_with_tracks,
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


def test_yandex_availability_fails_when_service_unavailable() -> None:
    class Request:
        def get(self, url: str):
            assert url == "https://api.music.yandex.ru/account/status"
            return {"result": {"account": {"region": 10000, "serviceAvailable": False}}}

    client = SimpleNamespace(base_url="https://api.music.yandex.ru", _request=Request())

    with pytest.raises(YandexMusicUnavailableError, match="region=10000"):
        _ensure_yandex_music_available(client)


def test_yandex_availability_detects_legal_451() -> None:
    class Request:
        def get(self, url: str):
            raise RuntimeError("Unavailable For Legal Reasons (451)")

    client = SimpleNamespace(base_url="https://api.music.yandex.ru", _request=Request())

    with pytest.raises(YandexMusicUnavailableError, match="451"):
        _ensure_yandex_music_available(client)


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


def test_artist_familiar_from_full_payload_counts_embedded_tracks() -> None:
    familiar = _artist_familiar_from_info(
        "7715095",
        {
            "wave": {
                "tracks": [
                    {
                        "id": "122154355",
                        "title": "Tsunami",
                        "artists": [{"id": "161010", "name": "NYUSHA"}, {"id": "7715095", "name": "AUM RAA"}],
                    }
                ]
            },
            "collection": {
                "tracks": [
                    {
                        "id": "126102126",
                        "title": "KARATE",
                        "artists": [{"id": "5688391", "name": "SQWOZ BAB"}, {"id": "7715095", "name": "AUM RAA"}],
                    }
                ],
                "albums": [{"id": "album-1"}],
            },
        },
    )

    assert familiar is not None
    assert familiar.known_track_count == 2
    assert familiar.wave_track_count == 1
    assert familiar.collection_track_count == 1
    assert familiar.collection_album_count == 1


def test_familiar_tracks_from_payload_keeps_sources_separate() -> None:
    tracks = _familiar_tracks_from_payload(
        {
            "wave": {
                "tracks": [
                    {
                        "id": "122154355",
                        "title": "Tsunami",
                        "artists": [{"id": "161010", "name": "NYUSHA"}, {"id": "7715095", "name": "AUM RAA"}],
                    }
                ]
            },
            "collection": {
                "tracks": [
                    {
                        "id": "126102126",
                        "title": "KARATE",
                        "artists": [{"id": "5688391", "name": "SQWOZ BAB"}, {"id": "7715095", "name": "AUM RAA"}],
                    }
                ]
            },
        }
    )

    assert [(track.id, track.source) for track in tracks] == [
        ("122154355", "familiar_wave"),
        ("126102126", "familiar_collection"),
    ]
    assert [artist.name for artist in tracks[0].artists] == ["NYUSHA", "AUM RAA"]


def test_fetch_artist_familiar_uses_full_familiar_endpoint() -> None:
    requested_urls: list[str] = []

    class Request:
        def get(self, url: str):
            requested_urls.append(url)
            return {
                "wave": {
                    "trackCount": 1,
                    "tracks": [
                        {
                            "id": "122154355",
                            "title": "Tsunami",
                            "artists": [{"id": "161010", "name": "NYUSHA"}, {"id": "7715095", "name": "AUM RAA"}],
                        }
                    ],
                },
                "collection": {"trackCount": 0, "albumCount": 0},
            }

    result = _fetch_artist_familiar_with_tracks(
        SimpleNamespace(base_url="https://api.music.yandex.ru", _request=Request()),
        "7715095",
    )

    assert result is not None
    assert "/artists/7715095/familiar-you?" in requested_urls[0]
    assert "/info" not in requested_urls[0]
    assert result.familiar.known_track_count == 1
    assert result.tracks[0].title == "Tsunami"


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
    assert [track["title"] for track in collabs[0].tracks] == ["Song One", "Song Two"]
    assert [track["id"] for track in collabs[0].tracks] == ["t1", "t2"]
    assert collabs[0].tracks[0]["artists"] == [
        {"id": "1", "name": "Source"},
        {"id": "2", "name": "Featured"},
    ]
