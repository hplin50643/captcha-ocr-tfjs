const fs = require("fs");
const path = require("path");
const D = require("../src/dataset");
const { extensionDirectory } = require("../src/config");

function syncExtension() {
  const extension = extensionDirectory();
  if (!fs.existsSync(path.join(extension, "manifest.json")))
    throw new Error(
      `Extension missing at ${extension}. Set CAPTCHA_EXTENSION_DIR to its project directory.`
    );
  const modelDir = path.join(D.ROOT, "model");
  const json = D.readJson(path.join(modelDir, "model.json"));
  const labels = D.readJson(path.join(modelDir, "labels.json"));
  const preprocessing = D.readJson(path.join(modelDir, "preprocessing.json"));
  if (JSON.stringify(labels) !== JSON.stringify(D.LABELS) || preprocessing.imageSize !== 32)
    throw new Error("Model is incompatible with the extension.");
  const required = {
    "dense_Dense1/kernel": [1024, 128],
    "dense_Dense1/bias": [128],
    "dense_Dense2/kernel": [128, 64],
    "dense_Dense2/bias": [64],
    "dense_Dense3/kernel": [64, 9],
    "dense_Dense3/bias": [9]
  };
  const weights = json.weightsManifest.flatMap((group) => group.weights);
  for (const [name, shape] of Object.entries(required)) {
    const weight = weights.find((w) => w.name === name);
    if (
      !weight ||
      weight.dtype !== "float32" ||
      JSON.stringify(weight.shape) !== JSON.stringify(shape)
    )
      throw new Error(`Unsupported extension weight: ${name}`);
  }
  fs.copyFileSync(
    path.join(D.ROOT, "src", "preprocess-core.js"),
    path.join(extension, "src", "preprocess.js")
  );
  for (const file of fs.readdirSync(modelDir).filter((f) => /\.(json|bin)$/.test(f)))
    fs.copyFileSync(path.join(modelDir, file), path.join(extension, "model", file));
  console.log(`Extension synchronized. Model SHA-256: ${D.modelFingerprint(modelDir)}`);
}
if (require.main === module) {
  try {
    syncExtension();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { syncExtension };
