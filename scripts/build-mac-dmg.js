const fs = require("fs");
const os = require("os");
const path = require("path");
const {execFileSync} = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const pkg = require(path.join(projectRoot, "package.json"));

function run(cmd, args, options = {}) {
    console.log(`$ ${cmd} ${args.join(" ")}`);
    return execFileSync(cmd, args, {
        stdio: "inherit",
        ...options
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function findMacAppOutput() {
    const entries = fs.readdirSync(distDir, {withFileTypes: true});

    const candidates = entries
        .filter(e => e.isDirectory() && e.name.startsWith("mac"))
        .map(e => e.name)
        .sort((a, b) => {
            if (a === "mac-arm64") return -1;
            if (b === "mac-arm64") return 1;
            if (a === "mac") return -1;
            if (b === "mac") return 1;
            return a.localeCompare(b);
        });

    for (const dirName of candidates) {
        const appPath = path.join(
            distDir,
            dirName,
            `${pkg.productName || pkg.name}.app`
        );

        if (fs.existsSync(appPath)) {
            return {dirName, appPath};
        }
    }

    throw new Error("No macOS .app found in dist/");
}

function getArchSuffix(dirName) {
    const suffix = dirName.replace(/^mac/, "");
    return suffix || "";
}

function getAppSizeMb(appPath) {
    const output = execFileSync("du", ["-sk", appPath], {encoding: "utf8"}).trim();
    const sizeKb = Number(output.split(/\s+/)[0]);

    if (!Number.isFinite(sizeKb) || sizeKb <= 0) {
        throw new Error(`Cannot determine size of ${appPath}`);
    }

    return Math.ceil(sizeKb / 1024 * 1.5 + 200);
}

function safeRm(target) {
    fs.rmSync(target, {recursive: true, force: true});
}

async function main() {

    if (process.platform !== "darwin") {
        console.log("Skipping DMG creation (macOS only).");
        return;
    }

    const {dirName, appPath} = findMacAppOutput();

    const productName = pkg.productName || pkg.name;
    const version = pkg.version;

    const archSuffix = getArchSuffix(dirName);

    const volumeName = productName;
    const dmgName = `${productName}-${version}${archSuffix}.dmg`;

    const finalDmgPath = path.join(distDir, dmgName);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proctorx-dmg-"));
    const rwDmgPath = path.join(tempRoot, `${productName}-rw.dmg`);
    const mountPoint = path.join(tempRoot, "mnt");

    const imageSizeMb = getAppSizeMb(appPath);

    let attached = false;

    fs.mkdirSync(mountPoint, {recursive: true});
    safeRm(finalDmgPath);

    console.log(`Creating DMG from ${appPath}`);
    console.log(`Image size: ${imageSizeMb} MB`);

    try {

        // Create writable disk image (HFS+ for stability)
        run("hdiutil", [
            "create",
            "-ov",
            "-size",
            `${imageSizeMb}m`,
            "-fs",
            "HFS+",
            "-volname",
            volumeName,
            rwDmgPath
        ]);

        // Mount image
        run("hdiutil", [
            "attach",
            rwDmgPath,
            "-mountpoint",
            mountPoint,
            "-nobrowse",
            "-noverify"
        ]);

        attached = true;

        // Wait for mount stabilization
        await sleep(2000);

        // Copy app
        run("ditto", [
            appPath,
            path.join(mountPoint, `${productName}.app`)
        ]);

        // Create Applications shortcut
        const applicationsLink = path.join(mountPoint, "Applications");

        if (!fs.existsSync(applicationsLink)) {
            fs.symlinkSync("/Applications", applicationsLink);
        }

        // Ensure disk writes finished
        run("sync", []);

        await sleep(1000);

        // Detach image
        run("hdiutil", ["detach", mountPoint]);

        attached = false;

        // Compress to final DMG
        run("hdiutil", [
            "convert",
            rwDmgPath,
            "-format",
            "UDZO",
            "-imagekey",
            "zlib-level=9",
            "-o",
            finalDmgPath
        ]);

        console.log(`✅ DMG created: ${finalDmgPath}`);

    } finally {

        if (attached) {
            try {
                execFileSync("hdiutil", ["detach", mountPoint, "-force"], {stdio: "inherit"});
            } catch (err) {
                console.warn(`Detach failed: ${err.message}`);
            }
        }

        safeRm(tempRoot);
    }
}

main();