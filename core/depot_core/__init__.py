"""depot-core: Depot's bridge to the six tools' Python cores.

Depot's Rust backend starts this program once and talks to it over stdin and
stdout, one JSON object per line. See core/README.md for the protocol.
"""

__version__ = "0.1.0"
