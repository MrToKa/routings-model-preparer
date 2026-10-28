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

Validation in the pinned Node 24 Linux CI container:
- 51 package image/inspection tests passed, including nested PNG/JPEG resources
  with spaces and portable verification.
- 96 provider/adapter tests passed, including exact URN signing, nested download
  directories, recursive inventory and complete package publication.
- The WFC companion passed 32 verifier regressions, 25 HTTP boundary tests and
  the server build with pinned-runtime-copy validation.

Desktop production completion is checked by rebuilding both applications and
resuming the existing operation. The regression fixtures contain synthetic data.
