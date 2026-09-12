const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { walkImageFiles, decodeImage, ensureDir } = require("../src/image-utils");

const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "data", "collection.json");
const ORIGIN = "https://admis.nhri.edu.tw";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((s) => s.replace(/^--/, "").split("="))
  );
  const target = Number(args.count || 100);
  const interval = Math.max(2000, Number(args["interval-ms"] || 2000));
  if (!Number.isInteger(target) || target < 1 || !Number.isFinite(interval))
    throw new Error("Invalid collection count or interval.");
  const state = fs.existsSync(STATE)
    ? JSON.parse(fs.readFileSync(STATE, "utf8"))
    : {
        version: 1,
        batchId: new Date().toISOString().replace(/[:.]/g, "-"),
        origin: ORIGIN,
        target,
        entries: [],
        attempts: 0,
        status: "collecting"
      };
  if (state.target !== target)
    throw new Error(`Existing batch target is ${state.target}; resume with that count.`);
  const save = () => {
    state.updatedAt = new Date().toISOString();
    state.remaining = Math.max(0, target - state.entries.length);
    fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(state, null, 2) + "\n");
    fs.renameSync(`${STATE}.tmp`, STATE);
  };
  ensureDir(path.join(ROOT, "data", "review", "raw"));
  const existingFiles = [
    ...walkImageFiles(path.join(ROOT, "data", "raw")),
    ...walkImageFiles(path.join(ROOT, "data", "review", "raw"))
  ];
  const known = new Set(existingFiles.map((f) => hash(fs.readFileSync(f))));
  const recorded = new Set(state.entries.map((e) => e.sha256));
  for (const file of existingFiles) {
    if (!/^capture_\d+_[a-f0-9]+\.(png|jpg)$/.test(path.basename(file))) continue;
    const sha256 = hash(fs.readFileSync(file));
    // Recover a fully written image if the process stopped before the JSON checkpoint.
    if (!recorded.has(sha256)) {
      const image = decodeImage(file);
      state.entries.push({
        sha256,
        originalFilename: path.basename(file),
        path: path.relative(ROOT, file).split(path.sep).join("/"),
        collectedAt: fs.statSync(file).mtime.toISOString(),
        width: image.width,
        height: image.height
      });
      recorded.add(sha256);
    }
  }
  if (state.entries.some((e) => !known.has(e.sha256)))
    throw new Error("A recorded source image is missing. Restore it before resuming collection.");
  if (state.entries.length >= target) {
    state.status = "complete";
    delete state.error;
    save();
    console.log(`Collection already complete: ${state.entries.length}/${target}`);
    return;
  }
  state.status = "collecting";
  delete state.error;
  save();
  const cookies = new Map([["locale", "tw"]]);
  async function request(url) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      redirect: "error",
      headers: {
        Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        Referer: `${ORIGIN}/`,
        "Cache-Control": "no-cache"
      }
    });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0];
      const equals = pair.indexOf("=");
      if (equals > 0) cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    if (!response.ok)
      throw new Error(`HTTP ${response.status}; collection stopped without retrying.`);
    return response;
  }
  try {
    await (await request(`${ORIGIN}/`)).arrayBuffer();
    let attemptsThisRun = 0;
    while (state.entries.length < target && attemptsThisRun < target * 3) {
      await pause(interval);
      attemptsThisRun++;
      state.attempts++;
      const response = await request(`${ORIGIN}/api/Login/GetCaptcha?${Date.now()}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpg = bytes[0] === 255 && bytes[1] === 216;
      if (!png && !jpg) throw new Error("Captcha response is not PNG/JPEG; collection stopped.");
      const sha256 = hash(bytes);
      if (known.has(sha256)) {
        save();
        continue;
      }
      const filename = `capture_${String(state.entries.length + 1).padStart(3, "0")}_${sha256.slice(0, 12)}.${png ? "png" : "jpg"}`;
      const relative = `data/review/raw/${filename}`;
      const destination = path.join(ROOT, relative);
      fs.writeFileSync(destination, bytes, { flag: "wx" });
      try {
        const image = decodeImage(destination);
        if (image.width < 30 || image.height < 10) throw new Error("Unexpected image dimensions.");
        state.entries.push({
          sha256,
          originalFilename: filename,
          path: relative,
          collectedAt: new Date().toISOString(),
          width: image.width,
          height: image.height
        });
      } catch (error) {
        fs.unlinkSync(destination);
        throw error;
      }
      known.add(sha256);
      save();
      if (state.entries.length % 10 === 0)
        console.log(`Collected ${state.entries.length}/${target}`);
    }
    state.status = state.entries.length === target ? "complete" : "incomplete";
    delete state.error;
    save();
    console.log(`Collection ${state.status}: ${state.entries.length}/${target}`);
  } catch (error) {
    state.status = "stopped";
    state.error = error.message;
    save();
    throw error;
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
