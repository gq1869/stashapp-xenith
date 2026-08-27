"""Minimal stand-in for stashapi.log — mirrors the real module's contract:
all output goes to stderr, never stdout, so it can never corrupt the raw
plugin interface's JSON stdout line."""

import sys


def _emit(level, msg):
    print(f"[{level}] {msg}", file=sys.stderr)


def debug(msg):
    _emit("DEBUG", msg)


def info(msg):
    _emit("INFO", msg)


def warning(msg):
    _emit("WARNING", msg)


def error(msg):
    _emit("ERROR", msg)


def progress(msg):
    _emit("PROGRESS", msg)
