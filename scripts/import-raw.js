const fs = require("fs");
const path = require("path");
const D = require("../src/dataset");
const U = require("../src/image-utils");

function importRaw({
  root = D.ROOT,
  dir = path.resolve(root, "../Captcha"),
  batch = "user-captcha-20260912",
  resolutions = {}
} = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(batch)) throw new Error("Invalid batch name.");
  const stateFile = D.resolveInside(root, `data/imports/${batch}.json`);
  const prior = D.readJson(stateFile, { version: 1, batchId: batch, entries: [] });
  const labelsPath = D.resolveInside(root, "data/raw-labels.json"),
    labels = D.readJson(labelsPath, {});
  const manifest = D.readJson(D.resolveInside(root, "data/manifest.json"), { samples: [] });
  const previous = new Map(manifest.samples.map((s) => [s.id, s]));
  const existing = new Map(
    [
      ...U.walkImageFiles(path.join(root, "data/raw")),
      ...U.walkImageFiles(path.join(root, "data/review/raw"))
    ].map((file) => [D.hash(fs.readFileSync(file)), file])
  );
  const grouped = new Map();
  for (const file of U.walkImageFiles(path.resolve(dir))) {
    const label = D.labelFromFilename(file);
    if (!label) throw new Error(`Expected a five-digit filename: ${file}`);
    const bytes = fs.readFileSync(file),
      id = D.hash(bytes);
    const image = U.decodeImage(file);
    if (image.width < 30 || image.height < 10) throw new Error(`Invalid raw image: ${file}`);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push({ file, label, bytes });
  }
  if (!grouped.size) throw new Error("No labeled source images found.");
  const actions = [];
  for (const [id, sources] of grouped) {
    const candidates = new Set(sources.map((s) => s.label));
    const resolution = resolutions[id];
    if (resolution && (!/^[1-9]{5}$/.test(resolution.label) || !resolution.reason))
      throw new Error(`Invalid independent resolution: ${id}`);
    if (
      candidates.size > 1 &&
      (!resolution || !/^[1-9]{5}$/.test(resolution.label) || !resolution.reason)
    )
      throw new Error(
        `Conflicting filenames for identical bytes: ${sources.map((s) => path.basename(s.file)).join(", ")}; an independent resolution is required.`
      );
    const label = resolution?.label || sources[0].label;
    const oldLabel = labels[id]?.label || previous.get(id)?.label;
    if (oldLabel && label !== oldLabel)
      throw new Error(`Conflicts with existing truth for ${id}. Resolve raw-labels explicitly.`);
    const source = sources.find((s) => s.label === label) || sources[0];
    const target =
      existing.get(id) ||
      D.resolveInside(
        root,
        `data/review/raw/${batch}_${id.slice(0, 12)}${path.extname(source.file).toLowerCase()}`
      );
    actions.push({ id, sources, source, label, target, resolution });
  }
  let added = 0;
  for (const a of actions) {
    if (!existing.has(a.id)) {
      U.ensureDir(path.dirname(a.target));
      fs.writeFileSync(a.target, a.source.bytes, { flag: "wx" });
      added++;
    }
    if (!labels[a.id] && !previous.get(a.id)?.label)
      labels[a.id] = {
        label: a.label,
        source: "user-review",
        reviewedAt: new Date().toISOString(),
        originalFilename: path.basename(a.source.file),
        batchId: batch
      };
    const entry = {
      sha256: a.id,
      label: a.label,
      originalFilename: path.basename(a.source.file),
      path: D.relative(root, a.target),
      sourceFiles: a.sources.map((s) => D.relative(root, s.file)),
      importedAt: new Date().toISOString(),
      ...(a.resolution ? { resolution: a.resolution } : {})
    };
    if (!prior.entries.some((e) => e.sha256 === a.id)) prior.entries.push(entry);
  }
  prior.status = "complete";
  prior.updatedAt = new Date().toISOString();
  D.writeJson(labelsPath, labels);
  D.writeJson(stateFile, prior);
  const result = {
    files: [...grouped.values()].flat().length,
    unique: grouped.size,
    added,
    duplicates: [...grouped.values()].flat().length - added,
    batchId: batch
  };
  console.log(JSON.stringify(result));
  return result;
}
if (require.main === module) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => a.replace(/^--/, "").split("="))
  );
  try {
    importRaw({
      dir: args.dir && path.resolve(D.ROOT, args.dir),
      batch: args.batch,
      resolutions: args.resolutions ? D.readJson(path.resolve(D.ROOT, args.resolutions)) : {}
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { importRaw };
