# CI Notes

SQLite tests require Bun because the production store uses `bun:sqlite`.
The CI matrix MUST include a Bun job for this package; Node-only jobs can
import the JSON store path but cannot exercise SQLite behavior.
