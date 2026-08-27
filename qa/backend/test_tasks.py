"""
QA suite for backend/tasks.py and backend/main.py.

Runs the real task handlers against an in-memory FakeStash double, and
separately shells out to the real main.py as a subprocess to verify
Stash's raw plugin interface contract: stdout must be exactly one line of
valid JSON.
"""

import copy
import importlib
import json
import os
import subprocess
import sys
import types

import pytest

BACKEND_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "backend")
FAKE_STASHAPI_DIR = os.path.join(os.path.dirname(__file__), "fake_stashapi")


# ---------------------------------------------------------------------------
# In-process tests: import tasks.py directly, call handlers against a fake
# StashInterface double. Covers task correctness, not just "didn't crash".
# ---------------------------------------------------------------------------


@pytest.fixture
def tasks_module(monkeypatch, tmp_path):
    """Import backend/tasks.py fresh, with a stubbed stashapi.log and redirected SNAPSHOTS_DIR."""
    fake_stashapi = types.ModuleType("stashapi")
    fake_log = types.ModuleType("stashapi.log")
    fake_log.debug = fake_log.info = fake_log.warning = fake_log.error = (
        lambda *a, **k: None
    )
    fake_stashapi.log = fake_log

    monkeypatch.setitem(sys.modules, "stashapi", fake_stashapi)
    monkeypatch.setitem(sys.modules, "stashapi.log", fake_log)
    monkeypatch.syspath_prepend(BACKEND_DIR)

    # Cleaner teardown: let monkeypatch handle removing these so they don't leak
    monkeypatch.delitem(sys.modules, "tasks", raising=False)
    monkeypatch.delitem(sys.modules, "queries", raising=False)

    tasks = importlib.import_module("tasks")
    monkeypatch.setattr(tasks, "SNAPSHOTS_DIR", str(tmp_path / "snapshots"))

    return tasks


class FakeStash:
    """Duck-types the subset of stashapi.stashapp.StashInterface that tasks.py actually calls."""

    def __init__(self, performers=None, scenes=None, database_path="/fake/stash.sqlite"):
        self.performers = performers or []
        self.scenes = scenes or []
        self.performer_updates = []
        self.scene_updates = []
        self.database_path = database_path

    def call_GQL(self, query, variables=None):
        return {"systemStatus": {"databasePath": self.database_path}}

    def find_performers(self, filter=None, fragment=None):
        return copy.deepcopy(self.performers)

    def find_scenes(self, filter=None, fragment=None):
        return copy.deepcopy(self.scenes)

    def update_performer(self, data):
        self.performer_updates.append(data)
        for p in self.performers:
            if p["id"] == data["id"]:
                if "rating100" in data:
                    p["rating100"] = data["rating100"]
                if "custom_fields" in data:
                    cf = data["custom_fields"]
                    if "partial" in cf:
                        p.setdefault("custom_fields", {}).update(cf["partial"])
                    elif "remove" in cf:
                        for key in cf["remove"]:
                            p.get("custom_fields", {}).pop(key, None)

    def update_performers(self, data):
        self.performer_updates.append(data)
        target_ids = set(data.get("ids", []))
        for p in self.performers:
            if p["id"] in target_ids:
                if "rating100" in data:
                    p["rating100"] = data["rating100"]
                if "custom_fields" in data:
                    cf = data["custom_fields"]
                    if "partial" in cf:
                        p.setdefault("custom_fields", {}).update(cf["partial"])
                    elif "remove" in cf:
                        for key in cf["remove"]:
                            p.get("custom_fields", {}).pop(key, None)

    def update_scene(self, data):
        self.scene_updates.append(data)
        for s in self.scenes:
            if s["id"] == data["id"]:
                if "rating100" in data:
                    s["rating100"] = data["rating100"]
                if "custom_fields" in data:
                    cf = data["custom_fields"]
                    if "partial" in cf:
                        s.setdefault("custom_fields", {}).update(cf["partial"])
                    elif "remove" in cf:
                        for key in cf["remove"]:
                            s.get("custom_fields", {}).pop(key, None)

    def update_scenes(self, data):
        self.scene_updates.append(data)
        target_ids = set(data.get("ids", []))
        for s in self.scenes:
            if s["id"] in target_ids:
                if "rating100" in data:
                    s["rating100"] = data["rating100"]
                if "custom_fields" in data:
                    cf = data["custom_fields"]
                    if "partial" in cf:
                        s.setdefault("custom_fields", {}).update(cf["partial"])
                    elif "remove" in cf:
                        for key in cf["remove"]:
                            s.get("custom_fields", {}).pop(key, None)


def make_performers(n):
    return [
        {"id": str(i), "name": f"Performer {i}", "rating100": 50, "custom_fields": {}}
        for i in range(n)
    ]


def test_fake_stash_matches_real_interface():
    """Guards against FakeStash drifting from the real stashapp-tools client.

    This is exactly the class of bug that let `bulk_update_performers` (a name
    that never existed on stashapi.stashapp.StashInterface — the real bulk
    method is `update_performers`) go undetected: FakeStash duck-typed a
    method name invented from the GraphQL mutation name rather than the
    Python client's actual API, so the mocked tests passed while the real
    plugin crashed at runtime.

    Requires stashapp-tools, which `uv run` self-provisions from
    pyproject.toml; skips cleanly if it's somehow missing so the rest of
    the suite stays usable without it.
    """
    stashapp = pytest.importorskip("stashapi.stashapp")
    real_methods = {
        name for name in dir(stashapp.StashInterface) if not name.startswith("_")
    }
    fake_methods = {
        name
        for name in vars(FakeStash)
        if not name.startswith("_") and callable(getattr(FakeStash, name))
    }
    missing = fake_methods - real_methods
    assert not missing, (
        f"FakeStash defines methods not present on the real StashInterface: "
        f"{sorted(missing)} — these names don't exist on the actual client and "
        f"any tasks.py code calling them will fail at runtime despite passing "
        f"the mocked tests."
    )


def test_wipe_clears_custom_fields_keeps_ratings(tasks_module):
    stash = FakeStash(
        performers=[
            {
                "id": "1",
                "name": "A",
                "rating100": 42,
                "custom_fields": {"hotornot_stats": "{}", "performer_record": "[]"},
            },
        ],
        scenes=[
            {
                "id": "s1",
                "title": "Scene 1",
                "rating100": 77,
                "custom_fields": {"xenith_stats": "{}"},
            },
        ],
    )
    result = tasks_module.task_wipe(stash, {})

    assert "1 performers" in result
    assert "1 scenes" in result
    assert stash.performer_updates == [
        {
            "ids": ["1"],
            "custom_fields": {
                "remove": [
                    "xenith_stats",
                    "xenith_record",
                    "hotornot_stats",
                    "performer_record",
                ]
            },
        }
    ]
    assert stash.scene_updates == [
        {
            "ids": ["s1"],
            "custom_fields": {
                "remove": [
                    "xenith_stats",
                    "xenith_record",
                    "hotornot_stats",
                    "performer_record",
                ]
            },
        }
    ]
    assert stash.scenes[0]["rating100"] == 77


def test_wipe_scope_performers_only_leaves_scenes_untouched(tasks_module):
    stash = FakeStash(
        performers=[{"id": "1", "name": "A", "rating100": 42, "custom_fields": {}}],
        scenes=[{"id": "s1", "title": "Scene 1", "rating100": 77, "custom_fields": {}}],
    )
    result = tasks_module.task_wipe(stash, {}, scope="performers")

    assert "1 performers" in result
    assert "scenes" not in result
    assert len(stash.performer_updates) == 1
    assert stash.scene_updates == []


def test_wipe_scope_scenes_only_leaves_performers_untouched(tasks_module):
    stash = FakeStash(
        performers=[{"id": "1", "name": "A", "rating100": 42, "custom_fields": {}}],
        scenes=[{"id": "s1", "title": "Scene 1", "rating100": 77, "custom_fields": {}}],
    )
    result = tasks_module.task_wipe(stash, {}, scope="scenes")

    assert "1 scenes" in result
    assert "performers" not in result
    assert len(stash.scene_updates) == 1
    assert stash.performer_updates == []


def test_wipe_skips_empty_scene_library(tasks_module):
    stash = FakeStash(performers=make_performers(2), scenes=[])
    result = tasks_module.task_wipe(stash, {})

    assert "0 scenes" in result
    assert stash.scene_updates == []


def test_reset_nulls_all_ratings(tasks_module):
    stash = FakeStash(performers=make_performers(3), scenes=[{"id": "s1", "title": "S", "rating100": 10, "custom_fields": {}}])
    tasks_module.task_reset(stash, {})

    assert all(p["rating100"] is None for p in stash.performers)
    assert stash.scenes[0]["rating100"] is None
    assert len(stash.performer_updates) == 1
    assert stash.performer_updates[0]["ids"] == ["0", "1", "2"]
    assert len(stash.scene_updates) == 1
    assert stash.scene_updates[0]["ids"] == ["s1"]


def test_reset_scope_performers_only_leaves_scenes_untouched(tasks_module):
    stash = FakeStash(
        performers=make_performers(2),
        scenes=[{"id": "s1", "title": "S", "rating100": 10, "custom_fields": {}}],
    )
    result = tasks_module.task_reset(stash, {}, scope="performers")

    assert "2 performers" in result
    assert "scenes" not in result
    assert stash.scenes[0]["rating100"] == 10
    assert stash.scene_updates == []


def test_reset_scope_scenes_only_leaves_performers_untouched(tasks_module):
    stash = FakeStash(
        performers=make_performers(2),
        scenes=[{"id": "s1", "title": "S", "rating100": 10, "custom_fields": {}}],
    )
    result = tasks_module.task_reset(stash, {}, scope="scenes")

    assert "1 scenes" in result
    assert "performers" not in result
    assert all(p["rating100"] == 50 for p in stash.performers)
    assert stash.performer_updates == []


def test_migrate_copies_legacy_keys_to_xenith_and_removes_them(tasks_module):
    stash = FakeStash(
        performers=[
            {
                "id": "1",
                "name": "A",
                "rating100": 50,
                "custom_fields": {
                    "hotornot_stats": '{"total_matches": 3}',
                    "performer_record": "[1]",
                },
            },
        ],
        scenes=[
            {
                "id": "s1",
                "title": "Scene 1",
                "rating100": 20,
                "custom_fields": {"hotornot_stats": '{"total_matches": 5}'},
            },
        ],
    )
    result = tasks_module.task_migrate(stash, {})

    assert "1 performers, 1 scenes" in result
    assert stash.performers[0]["custom_fields"] == {
        "xenith_stats": '{"total_matches": 3}',
        "xenith_record": "[1]",
    }
    assert stash.scenes[0]["custom_fields"] == {"xenith_stats": '{"total_matches": 5}'}

    # Snapshot taken before any write
    files = os.listdir(tasks_module.SNAPSHOTS_DIR)
    assert len(files) == 1
    assert files[0].endswith("Pre-Migration Xenith Snapshot.json")
    assert files[0].endswith("Xenith Snapshot.json"), (
        "must still satisfy task_snapshot_import's endswith(SNAPSHOT_SUFFIX) filter"
    )


def test_migrate_never_overwrites_an_existing_new_key(tasks_module):
    """A performer that already has fresh xenith_stats (e.g. played a match
    after a partial migration) must not have it clobbered by a stale
    hotornot_stats value on a re-run."""
    stash = FakeStash(
        performers=[
            {
                "id": "1",
                "name": "A",
                "rating100": 50,
                "custom_fields": {
                    "hotornot_stats": '{"total_matches": 1}',
                    "xenith_stats": '{"total_matches": 99}',
                },
            },
        ]
    )
    tasks_module.task_migrate(stash, {})

    assert stash.performers[0]["custom_fields"]["xenith_stats"] == '{"total_matches": 99}'
    assert "hotornot_stats" not in stash.performers[0]["custom_fields"]


def test_migrate_is_a_no_op_on_second_run(tasks_module):
    stash = FakeStash(
        performers=[
            {
                "id": "1",
                "name": "A",
                "rating100": 50,
                "custom_fields": {"hotornot_stats": "{}", "performer_record": "[]"},
            },
        ]
    )
    tasks_module.task_migrate(stash, {})
    result = tasks_module.task_migrate(stash, {})

    assert "0 performers, 0 scenes" in result


def test_snapshot_export_writes_valid_json_with_performers_and_scenes(tasks_module):
    stash = FakeStash(
        performers=[{"id": "1", "name": "A", "rating100": 50, "custom_fields": {}}],
        scenes=[{"id": "9", "title": "Scene 9", "rating100": 10, "custom_fields": {}}],
    )
    result = tasks_module.task_snapshot_export(stash, {})
    assert "1 performers, 1 scenes" in result

    files = os.listdir(tasks_module.SNAPSHOTS_DIR)
    assert len(files) == 1
    assert files[0].endswith("Xenith Snapshot.json")

    with open(os.path.join(tasks_module.SNAPSHOTS_DIR, files[0])) as f:
        data = json.load(f)

    assert data["performers"][0]["name"] == "A"
    assert data["scenes"][0]["title"] == "Scene 9"
    assert data["database_path"] == "/fake/stash.sqlite"


def test_snapshot_import_raises_cleanly_when_no_snapshots_dir(tasks_module):
    with pytest.raises(FileNotFoundError, match="Snapshots directory not found"):
        tasks_module.task_snapshot_import(FakeStash(), {})


def test_snapshot_import_raises_cleanly_when_dir_empty(tasks_module):
    os.makedirs(tasks_module.SNAPSHOTS_DIR)
    with pytest.raises(FileNotFoundError, match="No snapshot files found"):
        tasks_module.task_snapshot_import(FakeStash(), {})


def test_snapshot_import_skips_unmatched_names_gracefully(tasks_module):
    os.makedirs(tasks_module.SNAPSHOTS_DIR)
    snapshot = {
        "database_path": "/fake/stash.sqlite",
        "performers": [
            {"id": "old-1", "name": "Known", "rating100": 60, "custom_fields": {}},
            {
                "id": "old-2",
                "name": "Deleted Performer",
                "rating100": 20,
                "custom_fields": {},
            },
        ],
        "scenes": [{"id": "s1", "title": "S", "rating100": 5, "custom_fields": {}}],
    }
    with open(
        os.path.join(
            tasks_module.SNAPSHOTS_DIR, "[2026-01-01-000000] Xenith Snapshot.json"
        ),
        "w",
    ) as f:
        json.dump(snapshot, f)

    stash = FakeStash(
        performers=[
            {"id": "new-1", "name": "Known", "rating100": 1, "custom_fields": {}}
        ]
    )
    result = tasks_module.task_snapshot_import(stash, {})

    assert "1 performers, 1 scenes" in result
    assert "1 unknown" in result
    assert "0 ambiguous" in result
    assert len(stash.performer_updates) == 1
    assert stash.performer_updates[0]["id"] == "new-1"
    assert stash.performer_updates[0]["rating100"] == 60
    assert len(stash.scene_updates) == 1


def test_snapshot_import_picks_most_recent_by_filename_sort(tasks_module):
    os.makedirs(tasks_module.SNAPSHOTS_DIR)
    old = {
        "database_path": "/fake/stash.sqlite",
        "performers": [{"id": "x", "name": "Old", "rating100": 1, "custom_fields": {}}],
        "scenes": [],
    }
    new = {
        "database_path": "/fake/stash.sqlite",
        "performers": [
            {"id": "x", "name": "New", "rating100": 99, "custom_fields": {}}
        ],
        "scenes": [],
    }

    with open(
        os.path.join(
            tasks_module.SNAPSHOTS_DIR, "[2026-01-01-000000] Xenith Snapshot.json"
        ),
        "w",
    ) as f:
        json.dump(old, f)
    with open(
        os.path.join(
            tasks_module.SNAPSHOTS_DIR, "[2026-06-01-000000] Xenith Snapshot.json"
        ),
        "w",
    ) as f:
        json.dump(new, f)

    stash = FakeStash(
        performers=[
            {"id": "new-id", "name": "New", "rating100": 1, "custom_fields": {}}
        ]
    )
    tasks_module.task_snapshot_import(stash, {})

    assert stash.performer_updates[0]["rating100"] == 99, (
        "should import from the lexicographically-latest snapshot file"
    )


def test_snapshot_import_refuses_scenes_from_a_different_database(tasks_module):
    """Scenes have no natural key stable across databases (unlike
    performers, remapped by name), so a snapshot from a different/unverified
    database must not write scene ratings onto whatever scene holds that ID
    locally. Performers still import normally via name remap."""
    os.makedirs(tasks_module.SNAPSHOTS_DIR)
    snapshot = {
        "database_path": "/other/stash.sqlite",
        "performers": [
            {"id": "old-1", "name": "Known", "rating100": 60, "custom_fields": {}}
        ],
        "scenes": [{"id": "s1", "title": "S", "rating100": 5, "custom_fields": {}}],
    }
    with open(
        os.path.join(
            tasks_module.SNAPSHOTS_DIR, "[2026-01-01-000000] Xenith Snapshot.json"
        ),
        "w",
    ) as f:
        json.dump(snapshot, f)

    stash = FakeStash(
        performers=[
            {"id": "new-1", "name": "Known", "rating100": 1, "custom_fields": {}}
        ],
        database_path="/fake/stash.sqlite",
    )
    result = tasks_module.task_snapshot_import(stash, {})

    assert "1 performers, 0 scenes" in result
    assert len(stash.performer_updates) == 1, "performers still import via name remap"
    assert len(stash.scene_updates) == 0, "scenes must not import from a different database"


def test_snapshot_import_matches_performers_by_id_when_same_database(tasks_module):
    """Same-database import: match performers by ID first (a stable natural
    key within one database), so a renamed performer still gets their
    snapshot data, and a same-named duplicate doesn't ambiguity-skip a
    performer whose ID we already know."""
    os.makedirs(tasks_module.SNAPSHOTS_DIR)
    snapshot = {
        "database_path": "/fake/stash.sqlite",
        "performers": [
            {"id": "a", "name": "Old Name", "rating100": 60, "custom_fields": {}},
            {"id": "b", "name": "Dup", "rating100": 40, "custom_fields": {}},
        ],
        "scenes": [],
    }
    with open(
        os.path.join(
            tasks_module.SNAPSHOTS_DIR, "[2026-01-01-000000] Xenith Snapshot.json"
        ),
        "w",
    ) as f:
        json.dump(snapshot, f)

    stash = FakeStash(
        performers=[
            {"id": "a", "name": "New Name", "rating100": 1, "custom_fields": {}},
            {"id": "b", "name": "Dup", "rating100": 1, "custom_fields": {}},
            {"id": "c", "name": "Dup", "rating100": 1, "custom_fields": {}},
        ],
        database_path="/fake/stash.sqlite",
    )
    result = tasks_module.task_snapshot_import(stash, {})

    assert "2 performers" in result
    assert "0 unknown" in result
    assert "0 ambiguous" in result, "id b is known, so name ambiguity doesn't apply to it"
    updates = {u["id"]: u["rating100"] for u in stash.performer_updates}
    assert updates == {"a": 60, "b": 40}


def test_snapshot_import_refuses_scenes_when_database_path_missing(tasks_module):
    """An older snapshot without a database_path field is unverifiable — treat
    it the same as a mismatch (refuse) rather than assuming it's safe."""
    os.makedirs(tasks_module.SNAPSHOTS_DIR)
    snapshot = {
        "performers": [],
        "scenes": [{"id": "s1", "title": "S", "rating100": 5, "custom_fields": {}}],
    }
    with open(
        os.path.join(
            tasks_module.SNAPSHOTS_DIR, "[2026-01-01-000000] Xenith Snapshot.json"
        ),
        "w",
    ) as f:
        json.dump(snapshot, f)

    stash = FakeStash()
    result = tasks_module.task_snapshot_import(stash, {})

    assert "0 scenes" in result
    assert len(stash.scene_updates) == 0


def test_snapshot_import_does_not_clobber_rating_when_snapshot_has_none(tasks_module):
    """A snapshot entry that never had a rating (key absent or None)
    must not overwrite a rating the target library already has."""
    os.makedirs(tasks_module.SNAPSHOTS_DIR)
    snapshot = {
        "database_path": "/fake/stash.sqlite",
        "performers": [{"id": "old-1", "name": "Known", "custom_fields": {}}],
        "scenes": [{"id": "s1", "title": "S", "rating100": None, "custom_fields": {}}],
    }
    with open(
        os.path.join(
            tasks_module.SNAPSHOTS_DIR, "[2026-01-01-000000] Xenith Snapshot.json"
        ),
        "w",
    ) as f:
        json.dump(snapshot, f)

    stash = FakeStash(
        performers=[
            {"id": "new-1", "name": "Known", "rating100": 77, "custom_fields": {}}
        ],
        scenes=[{"id": "s1", "title": "S", "rating100": 42, "custom_fields": {}}],
    )
    tasks_module.task_snapshot_import(stash, {})

    assert "rating100" not in stash.performer_updates[0], (
        "rating100 key should be omitted entirely, not sent as None"
    )
    assert "rating100" not in stash.scene_updates[0]
    assert stash.performers[0]["rating100"] == 77, "existing rating untouched"


def test_snapshot_import_skips_ambiguous_duplicate_names(tasks_module):
    """Two current performers sharing a name must not have snapshot data
    guessed onto either of them; report the skip distinctly from 'unknown'."""
    os.makedirs(tasks_module.SNAPSHOTS_DIR)
    snapshot = {
        "database_path": "/fake/stash.sqlite",
        "performers": [
            {"id": "old-1", "name": "Dup", "rating100": 60, "custom_fields": {}},
            {"id": "old-2", "name": "Unique", "rating100": 30, "custom_fields": {}},
            {"id": "old-3", "name": "Renamed Away", "rating100": 10, "custom_fields": {}},
        ],
        "scenes": [],
    }
    with open(
        os.path.join(
            tasks_module.SNAPSHOTS_DIR, "[2026-01-01-000000] Xenith Snapshot.json"
        ),
        "w",
    ) as f:
        json.dump(snapshot, f)

    stash = FakeStash(
        performers=[
            {"id": "a", "name": "Dup", "rating100": 1, "custom_fields": {}},
            {"id": "b", "name": "Dup", "rating100": 1, "custom_fields": {}},
            {"id": "c", "name": "Unique", "rating100": 1, "custom_fields": {}},
        ]
    )
    result = tasks_module.task_snapshot_import(stash, {})

    assert "1 performers" in result
    assert "1 unknown" in result, "Renamed Away has no match in the current library"
    assert "1 ambiguous" in result, "Dup matches two current performers"
    assert len(stash.performer_updates) == 1
    assert stash.performer_updates[0]["id"] == "c"


# ---------------------------------------------------------------------------
# handle_log_operation: batched match-log flush (src/stash-log.js), not a
# task — no `stash`/`scope`, invoked directly by main.py for
# runPluginOperation calls rather than through TASKS.
# ---------------------------------------------------------------------------


def test_handle_log_operation_dispatches_by_level(tasks_module, monkeypatch):
    # _LOG_LEVELS captures the log functions by reference at import time, so
    # patching stashapi.log.debug/info/warning afterward wouldn't be seen —
    # patch the dict entries directly instead.
    calls = {"debug": [], "info": [], "warning": []}
    monkeypatch.setitem(tasks_module._LOG_LEVELS, "debug", lambda line: calls["debug"].append(line))
    monkeypatch.setitem(tasks_module._LOG_LEVELS, "info", lambda line: calls["info"].append(line))
    monkeypatch.setitem(tasks_module._LOG_LEVELS, "warning", lambda line: calls["warning"].append(line))

    result = tasks_module.handle_log_operation({"level": "info", "lines": ["a", "b"]})

    assert result == {"logged": 2}
    assert calls == {"debug": [], "info": ["a", "b"], "warning": []}


def test_handle_log_operation_defaults_to_debug_for_unknown_level(tasks_module, monkeypatch):
    # Unlike the dict-dispatched levels above, the fallback in
    # handle_log_operation reads log.debug directly (a fresh attribute
    # lookup on every call, not a value _LOG_LEVELS captured at import
    # time) — so this patches the attribute itself, not the dict.
    calls = []
    monkeypatch.setattr(tasks_module.log, "debug", lambda line: calls.append(line))

    tasks_module.handle_log_operation({"level": "not_a_real_level", "lines": ["x"]})

    assert calls == ["x"]


def test_handle_log_operation_with_no_lines_logs_nothing(tasks_module):
    assert tasks_module.handle_log_operation({}) == {"logged": 0}


# ---------------------------------------------------------------------------
# Subprocess tests: verify Stash's raw plugin interface contract
# ---------------------------------------------------------------------------


def run_main(task_name, stdin_payload, tmp_path=None, scope=None):
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([FAKE_STASHAPI_DIR, BACKEND_DIR])

    # Inject env var to safely test snapshot tasks without hitting the real directory
    if tmp_path:
        env["XENITH_SNAPSHOTS_DIR"] = str(tmp_path / "snapshots")

    cwd = str(tmp_path) if tmp_path else BACKEND_DIR
    args = [sys.executable, os.path.join(BACKEND_DIR, "main.py"), task_name]
    if scope is not None:
        args.append(scope)
    proc = subprocess.run(
        args,
        input=stdin_payload,
        capture_output=True,
        text=True,
        env=env,
        cwd=cwd,
        timeout=15,
    )
    return proc


def test_unknown_task_emits_clean_json_error(tmp_path):
    proc = run_main(
        "not_a_real_task", json.dumps({"server_connection": {}}), tmp_path=tmp_path
    )
    stdout_lines = [line for line in proc.stdout.strip().splitlines() if line.strip()]

    assert len(stdout_lines) == 1, (
        f"expected exactly one stdout line, got: {proc.stdout!r}"
    )
    assert json.loads(stdout_lines[0]) == {"error": "Unknown task: not_a_real_task"}


def test_malformed_stdin_json_does_not_crash_or_pollute_stdout(tmp_path):
    proc = run_main("wipe", "{not valid json", tmp_path=tmp_path)
    stdout_lines = [line for line in proc.stdout.strip().splitlines() if line.strip()]

    assert len(stdout_lines) == 1
    payload = json.loads(stdout_lines[0])
    assert "output" in payload
    assert "0 performers" in payload["output"]


def test_unknown_scope_emits_clean_json_error(tmp_path):
    proc = run_main(
        "wipe",
        json.dumps({"server_connection": {}}),
        tmp_path=tmp_path,
        scope="not_a_real_scope",
    )
    stdout_lines = [line for line in proc.stdout.strip().splitlines() if line.strip()]

    assert len(stdout_lines) == 1, (
        f"expected exactly one stdout line, got: {proc.stdout!r}"
    )
    assert json.loads(stdout_lines[0]) == {"error": "Unknown scope: not_a_real_scope"}


@pytest.mark.parametrize("scope", ["all", "performers", "scenes"])
def test_wipe_accepts_every_scope_via_subprocess(scope, tmp_path):
    proc = run_main(
        "wipe", json.dumps({"server_connection": {}}), tmp_path=tmp_path, scope=scope
    )
    stdout_lines = [line for line in proc.stdout.strip().splitlines() if line.strip()]

    assert len(stdout_lines) == 1
    payload = json.loads(stdout_lines[0])
    assert "output" in payload


def test_task_exception_is_caught_and_reported_as_clean_json_error(tmp_path):
    payload = json.dumps({"server_connection": {"SessionCookie": "RAISE_TEST_ERROR"}})
    proc = run_main("reset", payload, tmp_path=tmp_path)
    stdout_lines = [line for line in proc.stdout.strip().splitlines() if line.strip()]

    assert len(stdout_lines) == 1, (
        f"stdout must be exactly one JSON line even on failure, got: {proc.stdout!r}"
    )
    payload = json.loads(stdout_lines[0])
    assert "error" in payload
    assert "simulated Stash connection failure" in payload["error"]
    assert "Traceback" not in proc.stdout, (
        "a raw Python traceback on stdout would break Stash's raw interface"
    )


@pytest.mark.parametrize(
    "task_name", ["wipe", "reset", "snapshot_export", "snapshot_import", "migrate"]
)
def test_every_task_stdout_is_exactly_one_json_line(task_name, tmp_path):
    proc = run_main(task_name, json.dumps({"server_connection": {}}), tmp_path=tmp_path)
    stdout_lines = [line for line in proc.stdout.strip().splitlines() if line.strip()]

    assert len(stdout_lines) == 1, (
        f"task '{task_name}' produced {len(stdout_lines)} stdout lines "
        f"(expected 1) — check for a stray print() somewhere in the call chain.\n"
        f"stdout was: {proc.stdout!r}"
    )

    payload = json.loads(stdout_lines[0])
    assert set(payload.keys()) <= {"output", "error"}
    assert len(payload) == 1


def test_log_operation_stdout_is_exactly_one_json_line_and_lines_land_on_stderr(tmp_path):
    # runPluginOperation calls exec with no argv, so sys.argv[1] is absent —
    # unlike every other subprocess test above, task_name is not passed here.
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([FAKE_STASHAPI_DIR, BACKEND_DIR])
    env["XENITH_SNAPSHOTS_DIR"] = str(tmp_path / "snapshots")
    payload = json.dumps(
        {"args": {"mode": "log", "level": "debug", "lines": ["match: A (10 -> 12) def. B (8 -> 6)", "skip: C (5 -> 5) vs D (5 -> 5)"]}}
    )
    proc = subprocess.run(
        [sys.executable, os.path.join(BACKEND_DIR, "main.py")],
        input=payload,
        capture_output=True,
        text=True,
        env=env,
        cwd=str(tmp_path),
        timeout=15,
    )

    stdout_lines = [line for line in proc.stdout.strip().splitlines() if line.strip()]
    assert len(stdout_lines) == 1, f"expected exactly one stdout line, got: {proc.stdout!r}"
    assert json.loads(stdout_lines[0]) == {"output": {"logged": 2}}
    assert "match: A (10 -> 12) def. B (8 -> 6)" in proc.stderr
    assert "skip: C (5 -> 5) vs D (5 -> 5)" in proc.stderr
