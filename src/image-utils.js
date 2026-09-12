const fs = require("fs");
const path = require("path");
const { requirePackage } = require("./dependencies");
const { PNG } = requirePackage("pngjs");
const jpeg = requirePackage("jpeg-js");
const core = require("./preprocess-core");
const {
  DEFAULT_PREPROCESSING,
  binarizeDecodedImage,
  findBoundingBox,
  cropBinary,
  normalizeBinary
} = core;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

function isImageFile(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function walkImageFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && isImageFile(full)) {
        out.push(full);
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function decodeImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);
  const isPng =
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  const isJpeg = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;

  if (isPng || ext === ".png") {
    const png = PNG.sync.read(buffer);
    return {
      width: png.width,
      height: png.height,
      data: png.data,
      sourcePath: filePath
    };
  }

  if (isJpeg || ext === ".jpg" || ext === ".jpeg") {
    const decoded = jpeg.decode(buffer, { useTArray: true });
    return {
      width: decoded.width,
      height: decoded.height,
      data: decoded.data,
      sourcePath: filePath
    };
  }

  throw new Error(`Unsupported image extension: ${filePath}`);
}

function preprocessDigitFile(filePath, options = {}) {
  const image = decodeImage(filePath);
  const binary = binarizeDecodedImage(image, options);
  const bbox = findBoundingBox(binary, image.width, image.height, null, 1) || {
    x: 0,
    y: 0,
    width: image.width,
    height: image.height
  };
  const crop = cropBinary(binary, image.width, image.height, bbox);
  const input = normalizeBinary(crop, bbox.width, bbox.height, options);

  return {
    input,
    bbox,
    width: image.width,
    height: image.height,
    binary
  };
}

function segmentRawImageFile(filePath, options = {}) {
  return { filePath, ...core.segmentImageData(decodeImage(filePath), options) };
}

function readNormalizedDigit(filePath, imageSize = 32) {
  const image = decodeImage(filePath);
  if (image.width !== imageSize || image.height !== imageSize)
    throw new Error("Prepared digit must match model image size: " + filePath);
  const input = new Float32Array(imageSize * imageSize);
  for (let i = 0; i < input.length; i++) input[i] = image.data[i * 4] < 128 ? 1 : 0;
  return { input };
}

function writeBinaryPng(values, width, height, outPath) {
  ensureDir(path.dirname(outPath));
  const png = new PNG({ width, height });
  for (let i = 0, p = 0; i < values.length; i++, p += 4) {
    const foreground = values[i] > 0.5;
    const shade = foreground ? 0 : 255;
    png.data[p] = shade;
    png.data[p + 1] = shade;
    png.data[p + 2] = shade;
    png.data[p + 3] = 255;
  }
  fs.writeFileSync(outPath, PNG.sync.write(png));
}

function writeNormalizedPng(values, imageSize, outPath) {
  writeBinaryPng(values, imageSize, imageSize, outPath);
}

module.exports = {
  ...core,
  IMAGE_EXTENSIONS,
  decodeImage,
  ensureDir,
  isImageFile,
  preprocessDigitFile,
  readNormalizedDigit,
  segmentRawImageFile,
  walkImageFiles,
  writeBinaryPng,
  writeNormalizedPng
};
