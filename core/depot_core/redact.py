"""Keep credentials out of anything that is published as an event.

Events are written to the session timeline on disk, so every string that
might hold a credential goes through here first. The rules are deliberately
blunt: for a URL keep only scheme, host, port and path; in free text, apply
that to every URL found, and mask the value of `key=value`, `key: value` and
`--key value` where the key names a credential, and of `Bearer …`. Ordinary
words are left alone ("session started" stays readable).
"""
from __future__ import annotations

import re
import urllib.parse

_URL = re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s'\"<>]+")
_KEYS = r"(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|authorization|session[_-]?id|cookie|private[_-]?key)"
# key=value, key: value (optionally "Authorization: Bearer value")
_SECRET_PAIR = re.compile(rf"(?i)\b({_KEYS})(\s*[=:]\s*)(?:(?:bearer|basic|token|digest)\s+)?[^\s'\"&;,]+")
# --password value, --api-key=value
_SECRET_FLAG = re.compile(rf"(?i)(--?{_KEYS})(=|\s+)[^\s'\"&;,]+")
# A bare "Bearer <credential>"
_SCHEME = re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}")


def url(value: str) -> str:
    """'https://user:pw@host:8443/p?token=x#f' → 'https://host:8443/p'."""
    try:
        parts = urllib.parse.urlsplit(value)
    except ValueError:
        return "[url]"
    host = parts.hostname or ""
    if ":" in host:  # IPv6 literal
        host = f"[{host}]"
    try:
        port = parts.port
    except ValueError:
        port = None
    netloc = f"{host}:{port}" if port else host
    return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, "", ""))


def text(value: str) -> str:
    """Redact every URL and every secret-looking `key=value` in free text."""
    value = _URL.sub(lambda m: url(m.group(0)), value)
    value = _SECRET_PAIR.sub(lambda m: f"{m.group(1)}{m.group(2)}[redacted]", value)
    value = _SECRET_FLAG.sub(lambda m: f"{m.group(1)}{m.group(2)}[redacted]", value)
    return _SCHEME.sub(lambda m: f"{m.group(1)} [redacted]", value)
