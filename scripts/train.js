const fs = require("fs");
const path = require("path");
const tf = require("../src/tf");
const { loadLayersModel, saveLayersModel } = require("../src/tfjs-io");
const {
  DEFAULT_PREPROCESSING,
  ensureDir,
  preprocessDigitFile,
  readNormalizedDigit,
  walkImageFiles
} = require("../src/image-utils");
const D = require("../src/dataset");

const { ROOT: PROJECT_ROOT, LABELS } = require("../src/config");
const { mulberry32, shuffleInPlace } = require("../src/random");

function parseArgs(argv) {
  const out = {
    dataDir: path.join(PROJECT_ROOT, "data", "segmented"),
    modelDir: path.join(PROJECT_ROOT, "models", "candidate"),
    reportDir: path.join(PROJECT_ROOT, "reports", "training"),
    epochs: 20,
    batchSize: 32,
    imageSize: DEFAULT_PREPROCESSING.imageSize,
    seed: 42,
    fromModel: path.join(PROJECT_ROOT, "models", "labeler-baseline"),
    learningRate: 0.0001,
    validationRatio: 0.15,
    testRatio: 0.15
  };

  for (const arg of argv.slice(2)) {
    const [rawKey, rawValue] = arg.replace(/^--/, "").split("=");
    if (!rawKey || rawValue == null) continue;
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (["epochs", "batchSize", "imageSize", "seed"].includes(key)) {
      out[key] = Number(rawValue);
    } else if (["validationRatio", "testRatio", "learningRate"].includes(key)) {
      out[key] = Number(rawValue);
    } else if (["dataDir", "modelDir", "reportDir"].includes(key)) {
      out[key] = path.resolve(PROJECT_ROOT, rawValue);
    } else if (key === "fromModel") {
      out.fromModel = rawValue === "none" ? null : path.resolve(PROJECT_ROOT, rawValue);
    }
  }

  return out;
}

function loadSplitSamples(config) {
  const manifestPath = path.join(path.dirname(config.dataDir), "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = D.readJson(manifestPath);
    // Manifest paths are relative to the dataset project, including external datasets.
    const datasetRoot = path.resolve(path.dirname(manifestPath), "..");
    const splits = { train: [], validation: [], test: [] };
    const counts = Object.fromEntries(LABELS.map((label) => [label, 0]));
    for (const source of manifest.samples) {
      if (!source.label || !source.segmentationQuality.valid) continue;
      if (!splits[source.split]) throw new Error(`Invalid split: ${source.split}`);
      for (const digit of source.digits) {
        // Evaluation includes low-confidence digits with independently confirmed truth.
        if (source.split === "train" && digit.status === "review") continue;
        const label = source.label[digit.index];
        const filePath = D.resolveInside(datasetRoot, digit.path);
        if (!fs.existsSync(filePath))
          throw new Error(
            `Missing prepared digit; import pending moves or rerun prepare-data: ${filePath}`
          );
        splits[source.split].push({
          filePath,
          label,
          labelIndex: LABELS.indexOf(label),
          normalized: true,
          sourceId: source.id
        });
        counts[label]++;
      }
    }
    const random = mulberry32(config.seed);
    for (const [name, samples] of Object.entries(splits)) {
      if (!samples.length) throw new Error(`No ${name} samples in data manifest.`);
      shuffleInPlace(samples, random);
    }
    return { splits, counts };
  }
  const random = mulberry32(config.seed);
  const splits = { train: [], validation: [], test: [] };
  const counts = {};

  for (const label of LABELS) {
    const files = walkImageFiles(path.join(config.dataDir, label));
    if (!files.length) throw new Error(`No images found for label ${label}`);
    shuffleInPlace(files, random);
    counts[label] = files.length;

    const testCount = Math.max(1, Math.round(files.length * config.testRatio));
    const validationCount = Math.max(1, Math.round(files.length * config.validationRatio));
    const labelIndex = LABELS.indexOf(label);

    files.forEach((filePath, index) => {
      const sample = { filePath, label, labelIndex };
      if (index < testCount) {
        splits.test.push(sample);
      } else if (index < testCount + validationCount) {
        splits.validation.push(sample);
      } else {
        splits.train.push(sample);
      }
    });
  }

  shuffleInPlace(splits.train, random);
  shuffleInPlace(splits.validation, random);
  shuffleInPlace(splits.test, random);

  return { splits, counts };
}

function tensorFromSamples(tfInstance, samples, preprocessing) {
  const imageSize = preprocessing.imageSize;
  const pixelsPerImage = imageSize * imageSize;
  const xsData = new Float32Array(samples.length * pixelsPerImage);
  const labelIndexes = new Int32Array(samples.length);

  samples.forEach((sample, index) => {
    const processed = sample.normalized
      ? readNormalizedDigit(sample.filePath, imageSize)
      : preprocessDigitFile(sample.filePath, preprocessing);
    xsData.set(processed.input, index * pixelsPerImage);
    labelIndexes[index] = sample.labelIndex;
  });

  const xs = tfInstance.tensor4d(xsData, [samples.length, imageSize, imageSize, 1]);
  const labels = tfInstance.tensor1d(labelIndexes, "int32");
  const ys = tfInstance.oneHot(labels, LABELS.length);
  labels.dispose();

  return { xs, ys, labelIndexes: Array.from(labelIndexes) };
}

function createModel(tfInstance, imageSize, seed = 42, learningRate = 0.001) {
  const model = tfInstance.sequential();
  model.add(tfInstance.layers.flatten({ inputShape: [imageSize, imageSize, 1] }));
  model.add(
    tfInstance.layers.dense({
      name: "dense_Dense1",
      units: 128,
      activation: "relu",
      kernelInitializer: tfInstance.initializers.glorotNormal({ seed })
    })
  );
  model.add(tfInstance.layers.dropout({ rate: 0.25, seed: seed + 1 }));
  model.add(
    tfInstance.layers.dense({
      name: "dense_Dense2",
      units: 64,
      activation: "relu",
      kernelInitializer: tfInstance.initializers.glorotNormal({ seed: seed + 2 })
    })
  );
  model.add(
    tfInstance.layers.dense({
      name: "dense_Dense3",
      units: LABELS.length,
      activation: "softmax",
      kernelInitializer: tfInstance.initializers.glorotNormal({ seed: seed + 3 })
    })
  );

  model.compile({
    optimizer: tfInstance.train.adam(learningRate),
    loss: "categoricalCrossentropy",
    metrics: ["accuracy"]
  });

  return model;
}

function computeConfusionMatrix(actual, predicted) {
  const matrix = Array.from({ length: LABELS.length }, () =>
    Array.from({ length: LABELS.length }, () => 0)
  );
  for (let i = 0; i < actual.length; i++) {
    matrix[actual[i]][predicted[i]] += 1;
  }
  return matrix;
}

function matrixToCsv(matrix) {
  const lines = [];
  lines.push(["actual\\predicted", ...LABELS].join(","));
  matrix.forEach((row, index) => {
    lines.push([LABELS[index], ...row].join(","));
  });
  return `${lines.join("\n")}\n`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function writeTrainingReport(outPath, metrics, matrix) {
  const maxCell = Math.max(1, ...matrix.flat());
  const rows = matrix
    .map((row, rowIndex) => {
      const cells = row
        .map((value, colIndex) => {
          const intensity = value / maxCell;
          const color =
            rowIndex === colIndex
              ? `rgba(40, 150, 95, ${0.18 + intensity * 0.65})`
              : `rgba(190, 65, 65, ${0.08 + intensity * 0.55})`;
          return `<td style="background:${color}">${value}</td>`;
        })
        .join("");
      return `<tr><th>${LABELS[rowIndex]}</th>${cells}</tr>`;
    })
    .join("\n");

  const counts = Object.entries(metrics.classCounts)
    .map(([label, count]) => `<li>${escapeHtml(label)}: ${count}</li>`)
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Digit model training report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #1f2933; }
    table { border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #ccd2da; padding: 8px 12px; text-align: center; }
    th { background: #f3f5f7; }
    .metrics { display: flex; gap: 16px; flex-wrap: wrap; margin: 16px 0; }
    .metric { border: 1px solid #d6dbe1; border-radius: 6px; padding: 10px 12px; min-width: 150px; }
    .metric b { display: block; font-size: 22px; margin-top: 4px; }
  </style>
</head>
<body>
  <h1>Digit model training report</h1>
  <p>Generated at ${escapeHtml(metrics.generatedAt)}</p>
  <div class="metrics">
    <div class="metric">Test accuracy<b>${(metrics.testAccuracy * 100).toFixed(2)}%</b></div>
    <div class="metric">Validation accuracy<b>${(metrics.finalValidationAccuracy * 100).toFixed(2)}%</b></div>
    <div class="metric">Train samples<b>${metrics.splitSizes.train}</b></div>
    <div class="metric">Test samples<b>${metrics.splitSizes.test}</b></div>
  </div>
  <h2>Confusion matrix</h2>
  <table>
    <thead><tr><th>Actual / Predicted</th>${LABELS.map((label) => `<th>${label}</th>`).join("")}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <h2>Class counts</h2>
  <ul>${counts}</ul>
</body>
</html>
`;

  fs.writeFileSync(outPath, html);
}

async function main() {
  const config = parseArgs(process.argv);
  if (config.imageSize !== 32)
    throw new Error("Prepared dataset and extension require image-size=32.");
  if (!Number.isInteger(config.epochs) || config.epochs < 1 || config.epochs > 20)
    throw new Error("epochs must be between 1 and 20.");
  if (!Number.isFinite(config.learningRate) || config.learningRate <= 0)
    throw new Error("learning-rate must be positive.");
  if (config.fromModel && config.modelDir === config.fromModel)
    throw new Error("Candidate output must not overwrite its starting model.");
  const preprocessing = {
    ...DEFAULT_PREPROCESSING,
    imageSize: config.imageSize
  };

  await tf.ready();
  console.log(`TensorFlow.js ${tf.version.tfjs}, backend=${tf.getBackend()}`);

  const { splits, counts } = loadSplitSamples(config);
  console.log(
    `Samples: train=${splits.train.length}, validation=${splits.validation.length}, test=${splits.test.length}`
  );

  const train = tensorFromSamples(tf, splits.train, preprocessing);
  const validation = tensorFromSamples(tf, splits.validation, preprocessing);
  const test = tensorFromSamples(tf, splits.test, preprocessing);

  const model = createModel(tf, preprocessing.imageSize, config.seed, config.learningRate);
  let startingModel = null;
  if (config.fromModel) {
    if (
      JSON.stringify(D.readJson(path.join(config.fromModel, "labels.json"))) !==
      JSON.stringify(LABELS)
    )
      throw new Error("Starting model labels differ.");
    const source = await loadLayersModel(tf, config.fromModel);
    model.setWeights(source.getWeights());
    source.dispose();
    startingModel = {
      path: D.relative(PROJECT_ROOT, config.fromModel),
      sha256: D.modelFingerprint(config.fromModel)
    };
    console.log(`Fine-tuning ${startingModel.path}; learning-rate=${config.learningRate}`);
  }
  model.summary();

  let bestValidationLoss = Infinity,
    bestEpoch = 0,
    bestWeights = null;
  const history = await model.fit(train.xs, train.ys, {
    epochs: config.epochs,
    batchSize: config.batchSize,
    validationData: [validation.xs, validation.ys],
    shuffle: false,
    callbacks: {
      onEpochEnd: async (epoch, logs) => {
        if (logs.val_loss < bestValidationLoss) {
          if (bestWeights) bestWeights.forEach((weight) => weight.dispose());
          bestWeights = model.getWeights().map((weight) => weight.clone());
          bestValidationLoss = logs.val_loss;
          bestEpoch = epoch + 1;
        }
        const acc = logs.acc ?? logs.accuracy ?? 0;
        const valAcc = logs.val_acc ?? logs.val_accuracy ?? 0;
        console.log(
          `epoch ${String(epoch + 1).padStart(2, "0")}/${config.epochs} ` +
            `loss=${logs.loss.toFixed(4)} acc=${acc.toFixed(4)} ` +
            `val_loss=${logs.val_loss.toFixed(4)} val_acc=${valAcc.toFixed(4)}`
        );
      }
    }
  });

  if (!bestWeights) throw new Error("Training did not produce a finite validation loss.");
  model.setWeights(bestWeights);
  bestWeights.forEach((weight) => weight.dispose());
  const evalResult = model.evaluate(test.xs, test.ys);
  const testLoss = (await evalResult[0].data())[0];
  const testAccuracy = (await evalResult[1].data())[0];
  evalResult.forEach((tensor) => tensor.dispose());

  const predictionTensor = tf.tidy(() => model.predict(test.xs).argMax(-1));
  const predicted = Array.from(await predictionTensor.data());
  predictionTensor.dispose();

  const matrix = computeConfusionMatrix(test.labelIndexes, predicted);
  const last = history.history;
  const finalValidationAccuracy = (last.val_acc || last.val_accuracy || [0])[bestEpoch - 1] ?? 0;
  const finalTrainAccuracy = (last.acc || last.accuracy || [0]).slice(-1)[0] ?? 0;

  const modelDir = config.modelDir;
  const trainingDir = config.reportDir;
  ensureDir(modelDir);
  ensureDir(trainingDir);

  await saveLayersModel(tf, model, modelDir);
  fs.writeFileSync(path.join(modelDir, "labels.json"), JSON.stringify(LABELS, null, 2));
  fs.writeFileSync(
    path.join(modelDir, "preprocessing.json"),
    JSON.stringify(preprocessing, null, 2)
  );

  const metrics = {
    generatedAt: new Date().toISOString(),
    tfjsVersion: tf.version.tfjs,
    backend: tf.getBackend(),
    labels: LABELS,
    classCounts: counts,
    splitSizes: {
      train: splits.train.length,
      validation: splits.validation.length,
      test: splits.test.length
    },
    epochs: config.epochs,
    batchSize: config.batchSize,
    selectedEpoch: bestEpoch,
    selectedValidationLoss: bestValidationLoss,
    seed: config.seed,
    learningRate: config.learningRate,
    startingModel,
    history: history.history,
    splitPolicy:
      "frozen source-image splits; each collection batch=60/20/20 seed=42; user imports=train",
    sourceIds: Object.fromEntries(
      Object.entries(splits).map(([name, items]) => [
        name,
        [...new Set(items.map((s) => s.sourceId).filter(Boolean))]
      ])
    ),
    finalTrainAccuracy,
    finalValidationAccuracy,
    testLoss,
    testAccuracy,
    confusionMatrix: matrix
  };

  fs.writeFileSync(path.join(trainingDir, "metrics.json"), JSON.stringify(metrics, null, 2));
  fs.writeFileSync(path.join(trainingDir, "confusion-matrix.csv"), matrixToCsv(matrix));
  writeTrainingReport(path.join(trainingDir, "training-report.html"), metrics, matrix);

  train.xs.dispose();
  train.ys.dispose();
  validation.xs.dispose();
  validation.ys.dispose();
  test.xs.dispose();
  test.ys.dispose();
  model.dispose();

  console.log(`Test accuracy: ${(testAccuracy * 100).toFixed(2)}%`);
  console.log(`Model written to ${modelDir}`);
  console.log(`Confusion matrix written to ${path.join(trainingDir, "confusion-matrix.csv")}`);
}

if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

module.exports = { loadSplitSamples, createModel, tensorFromSamples, parseArgs };
