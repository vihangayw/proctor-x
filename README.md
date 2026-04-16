# Proctor-X macOS Build and Notarization

This project builds a signed macOS DMG for `Proctor-X` and verifies that the packaged app is accepted by Gatekeeper.

The `build` script now uses a custom DMG creation step in `scripts/build-mac-dmg.js` because
`hdiutil create -srcfolder <app>.app` was failing on this machine even though the app bundle itself was valid.

## 1. Set Apple Credentials

Run these before building:

```sh
export APPLE_ID="vyasith@gmail.com"
export APPLE_APP_SPECIFIC_PASSWORD="drhx-gqgo-wssh-eizj"
export APPLE_APP_PASSWORD="drhx-gqgo-wssh-eizj"
export APPLE_TEAM_ID="9YCZ8LY842"
```

## 2. Build the Electron Application

```sh
npm run build
```

This does two things:

- builds and notarizes `dist/mac-arm64/Proctor-X.app`
- creates `dist/Proctor-X-1.0.1-arm64.dmg` using the custom mount-and-copy DMG builder

This generates:

```text
dist/
 ├── Proctor-X-1.0.1-arm64.dmg
 └── mac-arm64/Proctor-X.app
```

## 3. Verify the Application Signature

```sh
codesign -dv --verbose=4 dist/mac-arm64/Proctor-X.app
```

Expected:

```text
Authority=Developer ID Application
TeamIdentifier=9YCZ8LY842
```

## 4. Verify Gatekeeper Acceptance

```sh
spctl -a -vv dist/mac-arm64/Proctor-X.app
```

Expected output:

```text
accepted
source=Developer ID
```

## 5. Submit the DMG to Apple for Notarization

```sh
xcrun notarytool submit dist/Proctor-X-*.dmg \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --wait
```

Expected result:

```text
status: Accepted
```

## 6. Staple the Notarization Ticket

```sh
xcrun stapler staple dist/Proctor-X-*.dmg
```

Expected:

```text
The staple and validate action worked!
```

## 7. Validate the Stapled Ticket

```sh
xcrun stapler validate dist/Proctor-X-*.dmg
```

Expected:

```text
The validate action worked!
```

## 8. Final Verification

Mount the DMG:

```sh
open dist/Proctor-X-*.dmg
```

Then verify the app inside:

```sh
spctl -a -vv "/Volumes/Proctor-X 1.0.1-arm64/Proctor-X.app"
```

Expected:

```text
accepted
source=Notarized Developer ID
```

## Notes

- The app is configured with `afterSign` notarization support in `scripts/notarize.js`.
- The DMG is created by `scripts/build-mac-dmg.js`, not by `electron-builder`'s built-in DMG target.
- `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_APP_PASSWORD` are currently set to the same value.
- The mounted DMG volume name in this project is `Proctor-X 1.0.1-arm64`, so the verification path should match that
  exact volume name.
