const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadSplitSamples, parseArgs } = require("../scripts/train");

test("external manifests resolve digit files against their own project", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "captcha-training-test-"));
  t.after(() => {
    assert.ok(
      path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "captcha-training-test-")
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
  const samples = ["train", "validation", "test"].map((split) => {
    const relative = `data/segmented/1/${split}.png`;
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "fixtures/42385-edge-noise.png"), filename);
    return {
      id: split,
      label: "11111",
      split,
      segmentationQuality: { valid: true },
      digits: [{ index: 0, path: relative, status: "manual" }]
    };
  });
  fs.writeFileSync(path.join(root, "data/manifest.json"), JSON.stringify({ samples }));
  const config = parseArgs(["node", "train", `--data-dir=${path.join(root, "data/segmented")}`]);
  const { splits } = loadSplitSamples(config);
  for (const split of Object.keys(splits)) {
    assert.equal(splits[split][0].filePath, path.join(root, `data/segmented/1/${split}.png`));
    assert.equal(splits[split][0].sourceId, split);
  }
  samples[0].digits[0].path = "../../outside.png";
  fs.writeFileSync(path.join(root, "data/manifest.json"), JSON.stringify({ samples }));
  assert.throws(() => loadSplitSamples(config), /stay inside/);
});
