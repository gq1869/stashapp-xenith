"""Minimal stand-in for stashapi.stashapp.StashInterface — enough surface
area for backend/main.py to construct one and for tasks.py to call it,
without a live Stash server. Real query/mutation behavior is exercised by
the FakeStash test double in test_tasks.py; this class only needs to exist
so `from stashapi.stashapp import StashInterface` succeeds."""


class StashInterface:
    def __init__(self, config=None):
        self.config = config or {}

    def find_performers(self, **kwargs):
        session_cookie = self.config.get("SessionCookie") or {}
        if session_cookie.get("Value") == "RAISE_TEST_ERROR":
            raise RuntimeError("simulated Stash connection failure")
        return []

    def update_performer(self, *args, **kwargs):
        return None

    def update_performers(self, *args, **kwargs):
        return None

    def find_scenes(self, **kwargs):
        return []

    def update_scene(self, *args, **kwargs):
        return None

    def update_scenes(self, *args, **kwargs):
        return None

    def call_GQL(self, *args, **kwargs):
        return {"systemStatus": {"databasePath": "/fake/stash.sqlite"}}
