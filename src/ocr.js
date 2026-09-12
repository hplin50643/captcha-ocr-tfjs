const fs = require("fs");
const path = require("path");
const tf = require("./tf");
const { ROOT } = require("./config");
const { loadLayersModel } = require("./tfjs-io");
const { DEFAULT_PREPROCESSING, segmentRawImageFile, summarizeDigits } = require("./image-utils");

let cachedModel = null;

async function loadRecognizer(modelDir = path.join(ROOT, "model")) {
  modelDir = path.resolve(modelDir);
  if (!cachedModel || cachedModel.modelDir !== modelDir) {
    if (cachedModel) cachedModel.model.dispose();
    await tf.ready();
    cachedModel = {
      modelDir,
      model: await loadLayersModel(tf, modelDir),
      labels: JSON.parse(fs.readFileSync(path.join(modelDir, "labels.json"), "utf8")),
      preprocessing: {
        ...DEFAULT_PREPROCESSING,
        ...JSON.parse(fs.readFileSync(path.join(modelDir, "preprocessing.json"), "utf8"))
      }
    };
  }
  return cachedModel;
}

function bestPrediction(values) {
  let index = 0;
  let confidence = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] > confidence) {
      index = i;
      confidence = values[i];
    }
  }
  return { index, confidence };
}

async function solveCaptchaFile(filePath, options = {}) {
  const recognizer = await loadRecognizer(options.modelDir);
  const segmented = segmentRawImageFile(filePath, recognizer.preprocessing);
  return { file: filePath, ...(await recognizeSegments(segmented, recognizer)) };
}

async function recognizeSegments(segmented, recognizer) {
  const imageSize = recognizer.preprocessing.imageSize;
  const pixelsPerImage = imageSize * imageSize;
  const xsData = new Float32Array(segmented.segments.length * pixelsPerImage);
  segmented.segments.forEach((segment, index) => xsData.set(segment.input, index * pixelsPerImage));

  let probabilities = [];
  if (segmented.segments.length) {
    const xs = tf.tensor4d(xsData, [segmented.segments.length, imageSize, imageSize, 1]);
    let prediction;
    try {
      prediction = recognizer.model.predict(xs);
      probabilities = await prediction.array();
    } finally {
      xs.dispose();
      if (prediction) prediction.dispose();
    }
  }

  const digits = probabilities.map((probs, index) => {
    const best = bestPrediction(probs);
    return {
      index,
      label: recognizer.labels[best.index],
      confidence: best.confidence,
      bbox: segmented.segments[index].bbox,
      probabilities: Object.fromEntries(
        recognizer.labels.map((label, labelIndex) => [label, probs[labelIndex]])
      )
    };
  });

  return {
    text: digits.map((digit) => digit.label).join(""),
    ...summarizeDigits(digits, segmented.quality),
    segmentMethod: segmented.method,
    segmentationQuality: segmented.quality,
    digits
  };
}

module.exports = {
  loadRecognizer,
  recognizeSegments,
  solveCaptchaFile
};
