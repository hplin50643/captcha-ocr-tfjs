/* Shared by Node.js and the browser extension. Edit this source, then run sync:extension. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AdmisCaptchaPreprocess = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
"use strict";
const DEFAULT_PREPROCESSING = {
  imageSize: 32,
  padding: 4,
  adaptiveBlockSize: 21,
  adaptiveC: 7,
  minComponentArea: 3,
  segmentCount: 5
};

function rgbaToGray(image) {
  const { width, height, data } = image;
  const gray = new Uint8ClampedArray(width * height);

  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const alpha = data[p + 3] == null ? 255 : data[p + 3];
    const invAlpha = 255 - alpha;
    const r = (data[p] * alpha + 255 * invAlpha) / 255;
    const g = (data[p + 1] * alpha + 255 * invAlpha) / 255;
    const b = (data[p + 2] * alpha + 255 * invAlpha) / 255;
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }

  return gray;
}

function normalizeBlockSize(blockSize) {
  const value = Math.max(3, Math.round(blockSize));
  return value % 2 === 0 ? value + 1 : value;
}

function adaptiveThreshold(gray, width, height, options = {}) {
  const blockSize = normalizeBlockSize(
    options.adaptiveBlockSize ?? DEFAULT_PREPROCESSING.adaptiveBlockSize
  );
  const c = options.adaptiveC ?? DEFAULT_PREPROCESSING.adaptiveC;
  const radius = Math.floor(blockSize / 2);
  const integralWidth = width + 1;
  const integral = new Float64Array((width + 1) * (height + 1));

  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    for (let x = 1; x <= width; x++) {
      rowSum += gray[(y - 1) * width + (x - 1)];
      integral[y * integralWidth + x] =
        integral[(y - 1) * integralWidth + x] + rowSum;
    }
  }

  const binary = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const a = y0 * integralWidth + x0;
      const b = y0 * integralWidth + (x1 + 1);
      const cIdx = (y1 + 1) * integralWidth + x0;
      const d = (y1 + 1) * integralWidth + (x1 + 1);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const mean = (integral[d] - integral[b] - integral[cIdx] + integral[a]) / area;
      const idx = y * width + x;
      binary[idx] = gray[idx] < mean - c ? 1 : 0;
    }
  }

  return binary;
}

function removeSmallComponents(binary, width, height, minArea = 3) {
  if (minArea <= 1) return binary;

  const visited = new Uint8Array(binary.length);
  const cleaned = new Uint8Array(binary.length);
  const queue = [];
  const component = [];
  const neighbors = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1]
  ];

  for (let start = 0; start < binary.length; start++) {
    if (!binary[start] || visited[start]) continue;

    queue.length = 0;
    component.length = 0;
    queue.push(start);
    visited[start] = 1;

    for (let head = 0; head < queue.length; head++) {
      const idx = queue[head];
      component.push(idx);
      const x = idx % width;
      const y = Math.floor(idx / width);

      for (const [dx, dy] of neighbors) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (binary[next] && !visited[next]) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }

    if (component.length >= minArea) {
      for (const idx of component) cleaned[idx] = 1;
    }
  }

  return cleaned;
}

function binarizeDecodedImage(image, options = {}) {
  const gray = rgbaToGray(image);
  const binary = adaptiveThreshold(gray, image.width, image.height, options);
  return removeSmallComponents(
    binary,
    image.width,
    image.height,
    options.minComponentArea ?? DEFAULT_PREPROCESSING.minComponentArea
  );
}

function findBoundingBox(binary, width, height, bounds = null, margin = 0) {
  const xStart = bounds ? Math.max(0, bounds.x) : 0;
  const yStart = bounds ? Math.max(0, bounds.y) : 0;
  const xEnd = bounds ? Math.min(width, bounds.x + bounds.width) : width;
  const yEnd = bounds ? Math.min(height, bounds.y + bounds.height) : height;

  let minX = width;
  let minY = yStart;
  let maxX = -1;
  let maxY = yEnd - 1;

  const rowHasInk = (y) => {
    for (let x = xStart; x < xEnd; x++) if (binary[y * width + x]) return true;
    return false;
  };
  // Scan both ends of the full character column, including disconnected strokes.
  while (minY <= maxY && !rowHasInk(minY)) minY++;
  while (maxY >= minY && !rowHasInk(maxY)) maxY--;
  if (minY > maxY) return null;

  for (let y = minY; y <= maxY; y++) {
    for (let x = xStart; x < xEnd; x++) {
      if (!binary[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }

  if (maxX < minX || maxY < minY) return null;

  minX = Math.max(0, minX - margin);
  minY = Math.max(0, minY - margin);
  maxX = Math.min(width - 1, maxX + margin);
  maxY = Math.min(height - 1, maxY + margin);

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

function cropBinary(binary, width, height, bbox) {
  const out = new Uint8Array(bbox.width * bbox.height);
  for (let y = 0; y < bbox.height; y++) {
    const srcStart = (bbox.y + y) * width + bbox.x;
    const dstStart = y * bbox.width;
    for (let x = 0; x < bbox.width; x++) {
      out[dstStart + x] = binary[srcStart + x] ? 1 : 0;
    }
  }
  return out;
}

function normalizeBinary(crop, cropWidth, cropHeight, options = {}) {
  const imageSize = options.imageSize ?? DEFAULT_PREPROCESSING.imageSize;
  const padding = options.padding ?? DEFAULT_PREPROCESSING.padding;
  const maxContent = Math.max(1, imageSize - padding * 2);
  const output = new Float32Array(imageSize * imageSize);

  if (cropWidth <= 0 || cropHeight <= 0) return output;

  const scale = Math.min(maxContent / cropWidth, maxContent / cropHeight);
  const resizedWidth = Math.max(1, Math.round(cropWidth * scale));
  const resizedHeight = Math.max(1, Math.round(cropHeight * scale));
  const offsetX = Math.floor((imageSize - resizedWidth) / 2);
  const offsetY = Math.floor((imageSize - resizedHeight) / 2);

  for (let y = 0; y < resizedHeight; y++) {
    const srcY = Math.min(cropHeight - 1, Math.floor(((y + 0.5) * cropHeight) / resizedHeight));
    for (let x = 0; x < resizedWidth; x++) {
      const srcX = Math.min(cropWidth - 1, Math.floor(((x + 0.5) * cropWidth) / resizedWidth));
      const value = crop[srcY * cropWidth + srcX] ? 1 : 0;
      output[(offsetY + y) * imageSize + (offsetX + x)] = value;
    }
  }

  return output;
}


function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

function connectedComponents(binary, width, height) {
  const seen = new Uint8Array(binary.length);
  const components = [];
  for (let start = 0; start < binary.length; start++) {
    if (!binary[start] || seen[start]) continue;
    const pixels = [start]; seen[start] = 1;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    for (let head = 0; head < pixels.length; head++) {
      const p = pixels[head], x = p % width, y = Math.floor(p / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, next = ny * width + nx;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && binary[next] && !seen[next]) {
          seen[next] = 1; pixels.push(next);
        }
      }
    }
    components.push({ pixels, area: pixels.length, x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
  }
  return components;
}

function cleanRelativeNoise(binary, width, height, count) {
  const components = connectedComponents(binary, width, height);
  const reference = [...components].sort((a, b) => b.area - a.area).slice(0, count);
  const referenceHeight = median(reference.map((c) => c.height));
  const referenceArea = median(reference.map((c) => c.area));
  const cleaned = new Uint8Array(binary);
  const removed = [];
  const retainedFragments = [];
  const isSmall = (c) => c.height < referenceHeight * 0.4 && c.area < referenceArea * 0.3;
  const anchors = components.filter((c) => !isSmall(c) && c.height >= referenceHeight * 0.55 && c.area >= referenceArea * 0.3);
  for (const c of components) {
    // Require BOTH short height and small area: a narrow but tall '1' is retained.
    if (isSmall(c)) {
      const anchor = anchors.find((a) => {
        const overlap = Math.min(c.x + c.width, a.x + a.width) - Math.max(c.x, a.x);
        const verticalGap = Math.max(0, c.y - (a.y + a.height), a.y - (c.y + c.height));
        const combinedHeight = Math.max(c.y + c.height, a.y + a.height) - Math.min(c.y, a.y);
        return overlap >= Math.min(c.width, a.width) * 0.5 &&
          c.width >= a.width * 0.3 && c.area >= Math.max(3, a.area * 0.1) &&
          verticalGap <= Math.max(2, referenceHeight * 0.15) && combinedHeight <= referenceHeight * 1.4;
      });
      // A clipped glyph can have a detached foot or cap. Keep its pixels without
      // painting a bridge; unrelated edge artifacts have no aligned tall anchor.
      if (anchor) {
        retainedFragments.push({ x: c.x, y: c.y, width: c.width, height: c.height, area: c.area });
        continue;
      }
      for (const p of c.pixels) cleaned[p] = 0;
      removed.push({ x: c.x, y: c.y, width: c.width, height: c.height, area: c.area });
    }
  }
  return { binary: cleaned, removed, retainedFragments };
}

function segmentImageData(image, options = {}) {
  const preprocessing = { ...DEFAULT_PREPROCESSING, ...options };
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || image.data.length !== width * height * 4) {
    throw new Error("Invalid RGBA image.");
  }
  const count = preprocessing.segmentCount;
  const cleaned = cleanRelativeNoise(binarizeDecodedImage(image, preprocessing), width, height, count);
  const binary = cleaned.binary;
  const projection = new Int32Array(width);
  for (let p = 0; p < binary.length; p++) if (binary[p]) projection[p % width]++;
  const groups = [];
  for (let x = 0; x < width;) {
    if (!projection[x]) { x++; continue; }
    const x0 = x; while (x < width && projection[x]) x++;
    groups.push({ x0, x1: x - 1 });
  }
  const merged = [];
  for (const g of groups) {
    const previous = merged[merged.length - 1];
    if (previous && g.x0 - previous.x1 <= 2) previous.x1 = g.x1;
    else merged.push({ ...g });
  }
  let splitCount = 0;
  // Split only a demonstrably wide region with a deep internal valley.
  while (merged.length < count && merged.length > 0) {
    const typicalWidth = median(merged.map((g) => g.x1 - g.x0 + 1));
    const index = merged.findIndex((g) => g.x1 - g.x0 + 1 > Math.max(12, typicalWidth * 1.6));
    if (index < 0) break;
    const g = merged[index], span = g.x1 - g.x0 + 1;
    const side = Math.max(4, Math.floor(span * 0.25));
    let cut = -1, score = Infinity;
    const peak = Math.max(...projection.subarray(g.x0, g.x1 + 1));
    for (let x = g.x0 + side; x <= g.x1 - side; x++) {
      const value = projection[x - 1] + projection[x] + projection[x + 1];
      if (value < score) { score = value; cut = x; }
    }
    if (cut < 0 || score > peak * 0.75) break;
    merged.splice(index, 1, { x0: g.x0, x1: cut }, { x0: cut + 1, x1: g.x1 });
    splitCount++;
  }
  const bboxes = merged.map((g) => findBoundingBox(binary, width, height, { x: g.x0, y: 0, width: g.x1 - g.x0 + 1, height }, 1)).filter(Boolean);
  const segments = bboxes.map((bbox, index) => {
    const crop = cropBinary(binary, width, height, bbox);
    return { index, bbox, crop, cropWidth: bbox.width, cropHeight: bbox.height, input: normalizeBinary(crop, bbox.width, bbox.height, preprocessing) };
  });
  const reasons = [];
  if (segments.length !== count) reasons.push("digit-count");
  const typicalHeight = median(bboxes.map((b) => b.height));
  const areas = segments.map((s) => s.crop.reduce((sum, p) => sum + p, 0));
  const typicalArea = median(areas);
  bboxes.forEach((b, i) => {
    if (b.height < Math.max(6, height * 0.25, typicalHeight * 0.45) || areas[i] < Math.max(4, typicalArea * 0.05)) reasons.push("small-fragment");
    if (b.width > b.height * 1.65) reasons.push("wide-segment");
  });
  return {
    width, height, binary, segments, method: splitCount ? "projection-valley" : "projection",
    quality: { valid: reasons.length === 0, reasons: [...new Set(reasons)], expectedCount: count, actualCount: segments.length, removedNoise: cleaned.removed, retainedFragments: cleaned.retainedFragments, splitCount }
  };
}

function summarizeDigits(digits, quality, threshold = 0.99) {
  const confidences = digits.map((d) => d.confidence);
  const confidence = digits.length ? confidences.reduce((a, b) => a + b, 0) / digits.length : 0;
  const minConfidence = digits.length ? Math.min(...confidences) : 0;
  return { confidence, minConfidence, needsReview: !quality.valid || digits.length !== quality.expectedCount || !Number.isFinite(minConfidence) || minConfidence < threshold };
}

return {DEFAULT_PREPROCESSING, rgbaToGray, adaptiveThreshold, removeSmallComponents, binarizeDecodedImage, findBoundingBox, cropBinary, normalizeBinary, connectedComponents, cleanRelativeNoise, segmentImageData, summarizeDigits};
});
