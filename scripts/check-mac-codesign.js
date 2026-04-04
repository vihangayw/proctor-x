const {execSync, execFileSync} = require("child_process");
const path = require("path");
const os = require("os");

function findValidIdentities() {
    try {
        const out = execSync("security find-identity -p codesigning -v", {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return out;
    } catch (err) {
        if (typeof err?.stdout === "string") return err.stdout;
        if (typeof err?.stderr === "string") return err.stderr;
        return String(err);
    }
}

/** @returns {Array<{ hash: string, name: string }>} */
function parseIdentities(out) {
    const identities = [];
    for (const line of out.split("\n")) {
        const m = line.match(/^\s*\d+\)\s+([0-9A-F]+)\s+"(.+)"\s*$/);
        if (m) identities.push({hash: m[1], name: m[2]});
    }
    return identities;
}

function findDuplicateHashes(identities) {
    const byHash = new Map();
    for (const id of identities) {
        if (!byHash.has(id.hash)) byHash.set(id.hash, []);
        byHash.get(id.hash).push(id.name);
    }
    const dups = [];
    for (const [hash, names] of byHash) {
        if (names.length > 1) dups.push({hash, names});
    }
    return dups;
}

function developerIdCertInKeychain(commonName, keychainPath) {
    try {
        execFileSync(
            "/usr/bin/security",
            ["find-certificate", "-c", commonName, keychainPath],
            {stdio: "ignore"}
        );
        return true;
    } catch {
        return false;
    }
}

const out = findValidIdentities();
const match = out.match(/(\d+)\s+valid identities found/i);
const count = match ? Number(match[1]) : 0;

const hasProvidedP12 = Boolean(process.env.CSC_LINK);

if (!count && !hasProvidedP12) {
    console.error(
        [
            "macOS code signing identities not found in Keychain.",
            "",
            "To produce a DMG users can open normally, you must sign with a Developer ID Application certificate.",
            "",
            "Next steps:",
            "1) Create/download a 'Developer ID Application' certificate from Apple Developer account.",
            "2) Import the .p12 into Keychain (so the private key is available).",
            "3) Re-run: npm run build",
            "",
            "Optional (for electron-builder): provide env vars:",
            "  - CSC_NAME (identity common name) OR CSC_LINK (base64-encoded .p12)",
            "  - CSC_KEY_PASSWORD (if your .p12 has a password)",
            "",
            "If you are using CSC_LINK, this check will pass automatically.",
        ].join("\n")
    );
    process.exit(1);
}

const identities = parseIdentities(out);
const dups = findDuplicateHashes(identities);
const loginKc = path.join(os.homedir(), "Library/Keychains/login.keychain-db");
const systemKc = "/Library/Keychains/System.keychain";

for (const id of identities) {
    if (!id.name.startsWith("Developer ID Application:")) continue;
    const inLogin = developerIdCertInKeychain(id.name, loginKc);
    const inSystem = developerIdCertInKeychain(id.name, systemKc);
    if (inLogin && inSystem) {
        console.error(
            [
                "The same Developer ID Application certificate appears in both the login and System keychains.",
                "That often breaks codesign with errSecInternalComponent / an incomplete certificate chain.",
                "",
                "Fix: open Keychain Access, search for your Developer ID Application certificate, and remove the duplicate from one keychain",
                "(keep the copy that contains your private key — usually login).",
                "",
                "Or remove the duplicate from the System keychain (requires sudo), e.g.:",
                `  sudo security delete-certificate -c "${id.name}" ${systemKc}`,
            ].join("\n")
        );
        process.exit(1);
    }
}

if (dups.length > 0) {
    console.error(
        [
            "Duplicate code signing identities detected (same certificate hash listed more than once):",
            ...dups.map((d) => `  ${d.hash}: ${d.names.join(" / ")}`),
            "",
            "Remove the extra copy from Keychain Access (login vs System), then retry the build.",
        ].join("\n")
    );
    process.exit(1);
}

if (count) {
    console.log(`Found ${count} valid code signing identity(ies). Proceeding with build.`);
} else {
    console.log("No Keychain identities found, but CSC_LINK is set; proceeding with build.");
}
