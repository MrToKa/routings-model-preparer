# Initial import validation — 28 October 2026

This repository imports the 20 October 2026 source bundle. It has not been deployed to the desktop as part of the repository import.

- Node.js v24.19.0 was available. Both modules' existing test suites were executed on Windows.
- The suites did not pass. Preparer failures included EPERM errors during temporary store file renames. The package suite also failed, including a concurrent stale-lock recovery assertion. Repeating with temporary directories inside the writable workspace did not produce a passing suite. These failures have not been diagnosed as application bugs versus environment restrictions.
- The changed start-preparer.ps1 passed PowerShell syntax parsing.
- No Docker image build, live Autodesk conversion or current WFC integration was verified during this import. Autodesk Viewer SDK binaries are external inputs and are not present in this repository.
- Original stage validation claims in module documentation describe earlier runs; they are not results of this import.

Publication review excluded real model files, credentials/configuration, runtime state, Autodesk account evidence and the original account-specific cost-review recorder. Test fixtures contain synthetic credential-shaped strings. Historical model names, hashes and reuse mappings remain with the repository owner's explicit approval for public publication.
