const fs = require("fs");
const path = require("path");
const {notarize} = require("@electron/notarize");

/**
 * electron-builder `afterSign` hook: notarize the signed .app with `notarytool`, then staple.
 * (@electron/notarize uses notarytool by default and runs `xcrun stapler staple` after success.)
 *
 * Required env (app-specific password, not your Apple ID login password):
 *   APPLE_ID              — Apple ID email
 *   APPLE_APP_PASSWORD    — App-specific password (https://appleid.apple.com → Sign-In and Security)
 *   APPLE_TEAM_ID         — Team ID from developer.apple.com
 *
 * Optional fallback for the password env name:
 *   APPLE_APP_SPECIFIC_PASSWORD
 */
exports.default = async function afterSign(context) {
    const {electronPlatformName, appOutDir, packager} = context || {};

    if (electronPlatformName !== "darwin") {
        return;
    }
    if (!appOutDir || !packager?.appInfo?.productFilename) {
        return;
    }

    const appleId = process.env.APPLE_ID;
    const appleIdPassword =
        process.env.APPLE_APP_PASSWORD || process.env.APPLE_APP_SPECIFIC_PASSWORD;
    const teamId = process.env.APPLE_TEAM_ID;

    if (!appleId || !appleIdPassword || !teamId) {
        console.log(
            "[notarize] Skipping: set APPLE_ID, APPLE_APP_PASSWORD, and APPLE_TEAM_ID to enable notarization."
        );
        return;
    }

    const appName = packager.appInfo.productFilename;
    const appPath = path.join(appOutDir, `${appName}.app`);

    if (!fs.existsSync(appPath)) {
        console.warn(`[notarize] App bundle not found: ${appPath}`);
        return;
    }

    console.log(`[notarize] Submitting ${appPath} (notarytool)…`);

    await notarize({
        tool: "notarytool",
        appPath,
        appleId,
        appleIdPassword,
        teamId,
    });

    console.log("[notarize] Notarization complete; ticket stapled to the app bundle.");
};
