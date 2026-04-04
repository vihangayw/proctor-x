/**
 * Optional login keychain tuning for codesign. Does not use an empty password
 * (that breaks when the login keychain is password-protected).
 *
 * If your login keychain has a password, run once before build:
 *   export MAC_KEYCHAIN_PASSWORD='your-login-keychain-password'
 *
 * If the Developer ID private key lives only in the System keychain, run once:
 *   sudo security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" /Library/Keychains/System.keychain
 */
const {spawnSync} = require("child_process");
const os = require("os");
const path = require("path");

function run(args) {
    return spawnSync("/usr/bin/security", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
}

if (process.platform !== "darwin") {
    process.exit(0);
}

const loginKc = path.join(os.homedir(), "Library/Keychains/login.keychain-db");

run(["set-keychain-settings", loginKc]);

const pw = process.env.MAC_KEYCHAIN_PASSWORD;
if (typeof pw === "string" && pw.length > 0) {
    const r = run([
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        pw,
        loginKc,
    ]);
    if (r.status !== 0 && r.stderr) {
        console.warn(
            `prepare-mac-keychain-for-codesign: ${r.stderr.trim()}`
        );
    }
}

const systemKc = "/Library/Keychains/System.keychain";
const rSys = run([
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:,codesign:",
    "-s",
    "-k",
    "",
    systemKc,
]);
if (rSys.status !== 0) {
    spawnSync(
        "/usr/bin/sudo",
        [
            "-n",
            "/usr/bin/security",
            "set-key-partition-list",
            "-S",
            "apple-tool:,apple:,codesign:",
            "-s",
            "-k",
            "",
            systemKc,
        ],
        {encoding: "utf8", stdio: "ignore"}
    );
}

process.exit(0);
