/**
 * Ensures Apple's Developer ID G2 intermediate CA is in the login keychain.
 * Without it, codesign often fails with:
 *   Warning: unable to build chain to self-signed root for signer "Developer ID Application: ..."
 *   errSecInternalComponent
 *
 * Leaf certs issued after the G2 migration chain through:
 *   Developer ID Application -> Developer ID Certification Authority (OU=G2) -> Apple Root CA - G2
 *
 * @see https://www.apple.com/certificateauthority/
 */
const {spawnSync} = require("child_process");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const CERTS = [
    {
        url: "https://www.apple.com/certificateauthority/AppleRootCA-G2.cer",
        file: "AppleRootCA-G2.cer",
        label: "Apple Root CA - G2",
    },
    {
        url: "https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer",
        file: "DeveloperIDG2CA.cer",
        label: "Developer ID Certification Authority (G2)",
    },
];

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https
            .get(url, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    const loc = res.headers.location;
                    file.close();
                    try {
                        fs.unlinkSync(dest);
                    } catch {
                        /* ignore */
                    }
                    if (!loc) {
                        reject(new Error(`Redirect without location from ${url}`));
                        return;
                    }
                    const next = loc.startsWith("http") ? loc : new URL(loc, url).href;
                    resolve(download(next, dest));
                    return;
                }
                if (res.statusCode !== 200) {
                    file.close();
                    try {
                        fs.unlinkSync(dest);
                    } catch {
                        /* ignore */
                    }
                    reject(new Error(`GET ${url} -> ${res.statusCode}`));
                    return;
                }
                res.pipe(file);
                file.on("finish", () => file.close(() => resolve()));
            })
            .on("error", (err) => {
                file.close();
                try {
                    fs.unlinkSync(dest);
                } catch {
                    /* ignore */
                }
                reject(err);
            });
    });
}

function importAppleCer(loginKeychain, cerPath) {
    const r = spawnSync(
        "/usr/bin/security",
        ["import", cerPath, "-k", loginKeychain, "-T", "/usr/bin/codesign"],
        {encoding: "utf8"}
    );
    if (r.status === 0) {
        return "imported";
    }
    const msg = `${r.stderr || ""}${r.stdout || ""}`;
    if (
        /already in keychain/i.test(msg) ||
        /already exists in the keychain/i.test(msg) ||
        /The certificate is already present/i.test(msg) ||
        /duplicate/i.test(msg)
    ) {
        return "present";
    }
    throw new Error(msg.trim() || `security import exited with ${r.status}`);
}

async function main() {
    if (process.platform !== "darwin") {
        return;
    }

    const loginKc = path.join(
        os.homedir(),
        "Library/Keychains/login.keychain-db"
    );
    const cacheDir = path.join(
        os.homedir(),
        "Library/Caches/electron-screen-share"
    );
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, {recursive: true});
    }

    let anyImported = false;
    for (const {url, file, label} of CERTS) {
        const cacheFile = path.join(cacheDir, file);
        if (!fs.existsSync(cacheFile) || fs.statSync(cacheFile).size < 100) {
            await download(url, cacheFile);
        }
        const result = importAppleCer(loginKc, cacheFile);
        if (result === "imported") {
            anyImported = true;
            console.log(`Installed "${label}" into the login keychain.`);
        }
    }
    if (anyImported) {
        console.log(
            "Apple code-signing trust chain is ready (root + Developer ID G2 intermediate)."
        );
    }
}

main().catch((e) => {
    console.error(
        [
            "Failed to ensure Developer ID G2 intermediate certificate.",
            "Download Apple Root CA - G2 and Developer ID - G2 from https://www.apple.com/certificateauthority/",
            "Then import each .cer with:",
            "  security import <file>.cer -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign",
            "",
            String(e?.message || e),
        ].join("\n")
    );
    process.exit(1);
});
