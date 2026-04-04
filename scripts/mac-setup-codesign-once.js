#!/usr/bin/env node
/**
 * Run ONCE on this Mac if `npm run build` fails with:
 *   unable to build chain to self-signed root / errSecInternalComponent
 *
 * Uses sudo to:
 * 1) Import Apple Root CA G2 + Developer ID G2 into the System keychain (chain resolution for codesign)
 * 2) Allow codesign to use private keys stored in the System keychain
 *
 * Requires: npm run build (or ensure-apple-intermediate-certs) first so .cer files exist in the cache.
 */
const fs = require("fs");
const path = require("path");
const {spawnSync} = require("child_process");
const os = require("os");

const SYSTEM_KC = "/Library/Keychains/System.keychain";
const CACHE = path.join(os.homedir(), "Library/Caches/electron-screen-share");
const CERTS = ["AppleRootCA-G2.cer", "DeveloperIDG2CA.cer"];

function sudoSecurity(args) {
    const r = spawnSync("/usr/bin/sudo", ["/usr/bin/security", ...args], {
        stdio: "inherit",
    });
    return r.status === 0;
}

if (process.platform !== "darwin") {
    process.exit(0);
}

let missing = false;
for (const f of CERTS) {
    const p = path.join(CACHE, f);
    if (!fs.existsSync(p) || fs.statSync(p).size < 100) {
        console.error(`Missing or empty: ${p}`);
        missing = true;
    }
}
if (missing) {
    console.error("Run first: node scripts/ensure-apple-intermediate-certs.js");
    process.exit(1);
}

console.log("Importing Apple CA certificates into the System keychain (sudo)…");
for (const f of CERTS) {
    const cerPath = path.join(CACHE, f);
    if (
        !sudoSecurity(["import", cerPath, "-k", SYSTEM_KC, "-T", "/usr/bin/codesign"])
    ) {
        process.exit(1);
    }
}

console.log("Updating System keychain partition list for codesign (sudo)…");
if (
    !sudoSecurity([
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        "",
        SYSTEM_KC,
    ])
) {
    process.exit(1);
}

console.log("Done. Try: npm run build");
