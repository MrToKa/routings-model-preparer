# Nested raster resources

A production SVF inspection identified one Autodesk.CloudPlatform.Image dependency
in a subdirectory with literal ASCII spaces. Its PNG bytes were declared by the
SVF manifest; parent segments, external addresses, encoded escapes and query
strings were absent.

This change preserves the original SVF and image bytes and their relative names.
Raster resources may use bounded canonical subdirectories below output/0, with
literal ASCII spaces. Other model assets keep their existing sibling contract.
Path traversal, backslashes, encoded paths, empty segments, reserved names,
trailing spaces/dots, case collisions and file/directory conflicts remain refused.

The provider signs the exact image URN using URI-component encoding. The adapter
creates declared parent directories, checks the recursive physical inventory and
keeps checkpoints and hashes for complete relative resource paths.

The WFC verifier needs the corresponding pinned paths/profile update before
packages using these image paths can be imported. Viewer HTTP decoding already
preserves a nested path with percent-encoded spaces and resolves only a resource
listed in the verified manifest.

Validation before the execution environment became unavailable:
- 51 package image and inspection tests passed, including nested PNG/JPEG paths
  with spaces and portable package verification.
- 43 additional pure JavaScript path acceptance/rejection checks passed.
- All 12 baseline vendor runtime files matched their pinned SHA-256 inventories.

Still required: Node provider/adapter tests, WFC source/build validation and a
desktop production retry. The new provider/adapter regression tests are included.
This change is a draft until those checks complete.
