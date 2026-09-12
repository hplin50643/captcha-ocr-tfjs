const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const D = require("../src/dataset");
const { importRaw } = require("../scripts/import-raw");
const { collectHard, qualifies } = require("../scripts/collect-hard");
const { prepare } = require("../scripts/prepare-data");

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "captcha-expansion-test-"));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.ok(
      resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + "captcha-expansion-test-")
    );
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

test("hard selection uses strict minimum confidence and rejects unavailable predictions", () => {
  const result = { digits: [{ confidence: 0.999 }, { confidence: 0.989 }], minConfidence: 0.989 };
  assert.equal(qualifies(result), true);
  assert.equal(qualifies({ ...result, minConfidence: 0.99 }), false);
  assert.equal(qualifies({ ...result, minConfidence: NaN }), false);
  assert.equal(qualifies({ ...result, digits: [], minConfidence: 0 }), false);
});

test("raw import rejects contradictory duplicate filenames before mutation and resumes safely", (t) => {
  const root = temp(t),
    input = path.join(root, "uploads");
  fs.mkdirSync(input);
  const bytes = fs.readFileSync(path.join(D.ROOT, "data/raw/14662.png")),
    id = D.hash(bytes);
  fs.writeFileSync(path.join(input, "14662.png"), bytes);
  fs.writeFileSync(path.join(input, "11111.png"), bytes);
  assert.throws(() => importRaw({ root, dir: input, batch: "upload" }), /Conflicting filenames/);
  assert.equal(fs.existsSync(path.join(root, "data/raw-labels.json")), false);
  const resolutions = { [id]: { label: "14662", reason: "Confirmed visible original answer" } };
  assert.equal(importRaw({ root, dir: input, batch: "upload", resolutions }).added, 1);
  assert.equal(importRaw({ root, dir: input, batch: "upload", resolutions }).added, 0);
  assert.equal(D.readJson(path.join(root, "data/raw-labels.json"))[id].label, "14662");
  assert.equal(D.sourceBatches(root).imports[0].entries.length, 1);
  assert.equal(D.sourceBatches(root).imports[0].entries[0].sourceFiles.length, 2);
  assert.equal(fs.readFileSync(path.join(input, "11111.png")).equals(bytes), true);
  D.writeJson(path.join(root, "data/raw-labels.json"), {});
  D.writeJson(path.join(root, "data/manifest.json"), {
    samples: [{ id, label: "14662", labelSource: "user-filename", split: "test" }]
  });
  importRaw({ root, dir: input, batch: "again", resolutions });
  assert.equal(D.readJson(path.join(root, "data/raw-labels.json"))[id], undefined);
});

test("collector completion resumes without network; missing images and scoring changes are rejected", async (t) => {
  const root = temp(t);
  fs.cpSync(
    path.join(D.ROOT, "models/labeler-baseline"),
    path.join(root, "models/labeler-baseline"),
    { recursive: true }
  );
  const bytes = fs.readFileSync(path.join(D.ROOT, "data/raw/14662.png")),
    id = D.hash(bytes);
  fs.mkdirSync(path.join(root, "data/raw"), { recursive: true });
  fs.writeFileSync(path.join(root, "data/raw/14662.png"), bytes);
  const state = {
    version: 2,
    batchId: "resume",
    target: 1,
    modelSha256: D.modelFingerprint(path.join(root, "models/labeler-baseline")),
    preprocessingSha256: D.hash(fs.readFileSync(path.join(D.ROOT, "src/preprocess-core.js"))),
    entries: [{ sha256: id }],
    seenHashes: [],
    attempts: 1
  };
  const file = path.join(root, "data/collections/resume.json");
  D.writeJson(file, state);
  const original = global.fetch;
  global.fetch = () => {
    throw Error("Unexpected network access");
  };
  t.after(() => {
    global.fetch = original;
  });
  assert.equal((await collectHard({ root, batch: "resume", count: 1 })).status, "complete");
  D.writeJson(file, { ...state, modelSha256: "changed" });
  await assert.rejects(() => collectHard({ root, batch: "resume", count: 1 }), /original target/);
  D.writeJson(file, state);
  fs.unlinkSync(path.join(root, "data/raw/14662.png"));
  await assert.rejects(() => collectHard({ root, batch: "resume", count: 1 }), /missing/);
});

test("new collection batches preserve old source splits and reject incomplete or modified batches", async (t) => {
  const root = temp(t);
  fs.cpSync(
    path.join(D.ROOT, "models/labeler-baseline"),
    path.join(root, "models/labeler-baseline"),
    { recursive: true }
  );
  fs.mkdirSync(path.join(root, "data/raw"), { recursive: true });
  const truth = {};
  const entries = [];
  for (const label of ["14662", "99511"]) {
    const bytes = fs.readFileSync(path.join(D.ROOT, `data/raw/${label}.png`)),
      id = D.hash(bytes);
    fs.writeFileSync(path.join(root, `data/raw/${label}.png`), bytes);
    truth[id] = { label, source: "user-review" };
    entries.push({ sha256: id, originalFilename: `${label}.png` });
  }
  D.writeJson(path.join(root, "data/raw-labels.json"), truth);
  D.writeJson(path.join(root, "data/collection.json"), {
    batchId: "old",
    status: "complete",
    entries: [entries[0]]
  });
  const file = path.join(root, "data/collections/new.json");
  D.writeJson(file, { batchId: "new", status: "collecting", entries: [entries[1]] });
  await assert.rejects(() => prepare(root), /Finish or resume/);
  D.writeJson(file, {
    batchId: "new",
    status: "complete",
    selection: "minConfidence < 0.99",
    entries: [entries[1]]
  });
  const first = await prepare(root),
    second = await prepare(root);
  assert.deepEqual(
    first.samples.map((s) => [s.id, s.split, s.batchId]),
    second.samples.map((s) => [s.id, s.split, s.batchId])
  );
  assert.equal(
    second.samples.find((s) => s.id === entries[1].sha256).selection,
    "minConfidence < 0.99"
  );
  D.writeJson(file, { batchId: "changed", status: "complete", entries: [entries[1]] });
  await assert.rejects(() => prepare(root), /frozen source split changed/);
});

test("collector retains a real low-confidence image, skips a confident one, and stops on rejection", async (t) => {
  const root = temp(t);
  fs.cpSync(
    path.join(D.ROOT, "models/labeler-baseline"),
    path.join(root, "models/labeler-baseline"),
    { recursive: true }
  );
  const confident = fs.readFileSync(path.join(D.ROOT, "data/raw/14662.png")),
    hard = fs.readFileSync(path.join(D.ROOT, "data/raw/41437.png"));
  const original = global.fetch;
  let calls = 0;
  const response = (bytes, status = 200) => ({
    ok: status === 200,
    status,
    headers: { getSetCookie: () => [] },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  });
  global.fetch = async () => {
    calls++;
    return response(calls === 1 ? Buffer.from("home") : calls === 2 ? confident : hard);
  };
  t.after(() => {
    global.fetch = original;
  });
  const state = await collectHard({ root, batch: "filter", count: 1 });
  assert.equal(calls, 3);
  assert.equal(state.attempts, 2);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].sha256, D.hash(hard));
  assert.ok(state.entries[0].minConfidence < 0.99);
  assert.equal(fs.existsSync(path.join(root, state.entries[0].path)), true);
  calls = 0;
  global.fetch = async () => {
    calls++;
    return response(Buffer.from("limited"), calls === 1 ? 200 : 429);
  };
  await assert.rejects(() => collectHard({ root, batch: "limited", count: 1 }), /HTTP 429/);
  assert.equal(calls, 2);
  const stopped = D.readJson(path.join(root, "data/collections/limited.json"));
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.remaining, 1);
  assert.equal(stopped.entries.length, 0);
});
