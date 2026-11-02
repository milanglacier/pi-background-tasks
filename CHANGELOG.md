# Changelog

## [0.9.1] - 2026-10-07

### Added

- `bg_task` and `/bg run` set `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` in the task environment.

## [0.9.0] - 2026-10-05

### Fixed

- Stopping a task, task expiry, and session shutdown stop the task's whole process tree, not only its shell.
- Quiet tasks expire on time. `timeoutSeconds` on `bg_task` and `/bg run --timeout <seconds>` set the limit, and `0` disables it.
- Task notifications stop after the session shuts down.

## [0.8.2] - 2026-10-01

### Changed

- Supports Pi 1.x.

## [0.8.1] - 2026-09-30

### Fixed

- Accepting a `/bg` argument completion keeps the subcommand, and Enter runs a fully typed command.

## [0.8.0] - 2026-09-30

### Breaking Changes

- The dashboard shortcut is `Ctrl+Alt+B`. Most terminals cannot send the previous `Ctrl+Shift+B`.

### Changed

- Supports Pi up to 0.120.0.

## [0.7.0] - 2026-09-21

### Changed

- The npm package is `@milanglacier/pi-background-tasks`.

## [0.6.2] - 2026-09-21

### Added

- Initial release as a standalone fork of the monopi background-tasks extension.
