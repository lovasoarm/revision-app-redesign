
# Release & Signing (v10)

This document describes steps to produce signed, notarized releases for Tauri apps.

## macOS
- You need an Apple Developer account and a code signing certificate (Developer ID Application).
- On CI, add the certificate and provisioning profile as secrets and use fastlane or notarize tool to upload.

## Windows
- Obtain a code signing certificate and configure signtool in CI. Keep cert in secure secrets storage.

## GitHub Actions
- Use `tauri-action` or `github-release` to create artifacts on tags `v*.*.*`.
- Provide secrets: MAC_CERT, MAC_CERT_PASSWORD, WIN_CERT, GITHUB_TOKEN, etc.

(Placeholders in workflows must be replaced with your actual secret names and provider details.)
