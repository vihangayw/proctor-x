# ProctorX macOS Build and Notarization

This project builds a signed macOS DMG for `ProctorX` and verifies that the packaged app is accepted by Gatekeeper.

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

This generates:

```text
dist/
 ├── ProctorX-1.0.1-arm64.dmg
 └── mac-arm64/ProctorX.app
```

## 3. Verify the Application Signature

```sh
codesign -dv --verbose=4 dist/mac-arm64/ProctorX.app
```

Expected:

```text
Authority=Developer ID Application
TeamIdentifier=9YCZ8LY842
```

## 4. Verify Gatekeeper Acceptance

```sh
spctl -a -vv dist/mac-arm64/ProctorX.app
```

Expected output:

```text
accepted
source=Developer ID
```

## 5. Submit the DMG to Apple for Notarization

```sh
xcrun notarytool submit dist/ProctorX-*.dmg \
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
xcrun stapler staple dist/ProctorX-*.dmg
```

Expected:

```text
The staple and validate action worked!
```

## 7. Validate the Stapled Ticket

```sh
xcrun stapler validate dist/ProctorX-*.dmg
```

Expected:

```text
The validate action worked!
```

## 8. Final Verification

Mount the DMG:

```sh
open dist/ProctorX-*.dmg
```

Then verify the app inside:

```sh
spctl -a -vv "/Volumes/ProctorX 1.0.1-arm64/ProctorX.app"
```

Expected:

```text
accepted
source=Notarized Developer ID
```

## Notes

- The app is configured with `afterSign` notarization support in `scripts/notarize.js`.
- `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_APP_PASSWORD` are currently set to the same value.
- The mounted DMG volume name in this project is `ProctorX 1.0.1-arm64`, so the verification path should match that
  exact volume name.
