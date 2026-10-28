# Repository completeness check — 28 October 2026

Baseline: the local Simplified-Preparer-WFC source bundle created on 20 October 2026. This check does not prove that the bundle matches a separately modified desktop installation.

## Source coverage

The original two source modules contain 123 files. The initial import preserves 122 of them: 118 byte-for-byte and four with documented portability/documentation edits. Only preparer-source/tools/record-cost-review.mjs was deliberately excluded because it is bound to a private account. It is not imported by the application; its absence means the historical account-specific proof-generation command is unavailable.

At initial commit 33aa789, the remote tree contains 125 files, including README.md, .gitignore and VALIDATION.md added at the repository root. All 124 local import files matched the remote Git blob hashes; VALIDATION.md was added directly through GitHub. No intended upload file was missing or different.

## Checks

- All 87 JavaScript module files passed Node.js syntax checks.
- Static relative module imports resolve. Absolute imports in the Docker operations fixture correspond to its container layout, not missing host files.
- Source-only Docker build-context preparation passed: 31 preparer files and 12 package-module files, totalling 554874 bytes. This does not build a Docker image.
- A portability mistake in the imported startup defaults was found: SDK source was nested inside the generated runtime target. This follow-up changes its default to vendor/viewer/7.130.0, outside deployment/preview-runtime, and ignores the external vendor input.
- Existing Windows runtime tests have unresolved failures; see VALIDATION.md. Syntax/import coverage does not establish correct runtime behavior.

## External prerequisites and excluded bundle material

This is a source repository, not a self-contained deployment bundle. Docker image archives, real models, secrets, runtime volumes and Autodesk SDK binaries are not included. Building requires the original trusted SDK source with vendor-manifest.json (pinned SHA-256 747540a153fb18809c428d8ed177aa8a296cff1b5175ab85445e0a2ebdb36d75) and its 206 declared assets. Ordinary version 7.130.0 alone is insufficient.

The original delivery also includes a WFC integration patch, patch-review script, validation logs, release metadata and a preview image. They are not part of this standalone source import. Workspace mode requires the corresponding WFC changes; it cannot be assumed to work with an unmodified WFC checkout. A standalone closed-mode start does not require the WFC patch.

Docker build/start, live cloud conversion, model preview using the original SDK and desktop upgrade have not been validated by this completeness check.
