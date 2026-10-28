import assert from "node:assert/strict";
import test from "node:test";
import { depthPlaneToImageData } from "../demo/jxl-depth.js";

let moduleId = 0;
const tick = () => new Promise(setImmediate);
const pixels = () => ({ width: 1, height: 1, pixels: new Uint8ClampedArray([10, 20, 30, 255]) });
const file = () => ({ arrayBuffer() { throw new Error("Unexpected main-thread file read"); } });

async function environment(t, nativeDecode = async () => { throw new Error("No native JXL support"); }) {
  const previousWorker = globalThis.Worker;
  const previousBitmap = globalThis.createImageBitmap;
  class FakeWorker {
    static instances = [];
    constructor(url, options) {
      this.kind = url.searchParams.get("kind");
      this.options = options;
      this.requests = [];
      FakeWorker.instances.push(this);
    }
    postMessage(request) { this.requests.push(request); }
    terminate() { this.terminated = true; }
    finish(image, error) {
      const { id } = this.requests.shift();
      this.onmessage({ data: { id, image, error } });
    }
  }
  globalThis.Worker = FakeWorker;
  globalThis.createImageBitmap = nativeDecode;
  t.after(() => {
    globalThis.Worker = previousWorker;
    globalThis.createImageBitmap = previousBitmap;
  });
  const loader = await import(`../demo/jxl-loader.js?test=${++moduleId}`);
  const worker = (kind) => FakeWorker.instances.find((instance) => instance.kind === kind);
  return { ...loader, FakeWorker, worker };
}

test("color and depth start before either finishes, and workers are reused", async (t) => {
  const { decodeJxlFile, FakeWorker, worker } = await environment(t);
  const first = decodeJxlFile(file());
  await tick();
  assert.equal(worker("depth").requests.length, 1);
  assert.equal(worker("color").requests.length, 1);
  let completed = false;
  void first.then(() => { completed = true; });
  worker("color").finish(pixels());
  await tick();
  assert.equal(completed, false);
  worker("depth").finish(pixels());
  const result = await first;
  assert.equal(result.depthWarning, "");
  assert.equal(result.depthImage.width, 1);
  const second = decodeJxlFile(file());
  await tick();
  assert.equal(FakeWorker.instances.length, 2);
  worker("depth").finish(null);
  worker("color").finish(pixels());
  assert.equal((await second).depthImage, null);
});

test("native color decoding starts while depth is pending", async (t) => {
  let finishNative;
  const nativeResult = { width: 8, height: 6 };
  const { decodeJxlFile, worker, FakeWorker } = await environment(t, () => new Promise((resolve) => { finishNative = resolve; }));
  const request = decodeJxlFile(file());
  assert.equal(typeof finishNative, "function");
  assert.equal(worker("depth").requests.length, 1);
  worker("depth").finish(pixels());
  finishNative(nativeResult);
  assert.equal((await request).colorImage, nativeResult);
  assert.equal(FakeWorker.instances.length, 1);
});

test("depth failure preserves color without repeating the failed decode", async (t) => {
  const { decodeJxlFile, worker } = await environment(t, async () => ({ width: 1, height: 1 }));
  const request = decodeJxlFile(file());
  worker("depth").finish(null, "Invalid depth channel");
  const result = await request;
  assert.equal(result.colorImage.width, 1);
  assert.equal(result.depthImage, null);
  assert.match(result.depthWarning, /Invalid depth channel/);
});

test("an explicit external depth map skips embedded depth extraction", async (t) => {
  const { decodeJxlFile, FakeWorker } = await environment(t, async () => ({ width: 1, height: 1 }));
  const result = await decodeJxlFile(file(), { includeDepth: false });
  assert.equal(result.depthImage, null);
  assert.equal(result.depthWarning, "");
  assert.equal(FakeWorker.instances.length, 0);
});

test("warm-up creates each worker only once without reading image bytes", async (t) => {
  const { warmJxlWorkers, FakeWorker } = await environment(t);
  warmJxlWorkers();
  warmJxlWorkers();
  assert.equal(FakeWorker.instances.length, 2);
  assert.ok(FakeWorker.instances.every((worker) => worker.requests.length === 0 && worker.options.type === "module"));
});

test("worker startup failure falls back and reports bad depth without losing native color", async (t) => {
  const { decodeJxlFile, worker } = await environment(t, async () => ({ width: 1, height: 1 }));
  let reads = 0;
  const badFile = { async arrayBuffer() { reads += 1; return new ArrayBuffer(0); } };
  const request = decodeJxlFile(badFile);
  worker("depth").onerror({ preventDefault() {} });
  const result = await request;
  assert.equal(reads, 1);
  assert.equal(result.colorImage.width, 1);
  assert.equal(result.depthImage, null);
  assert.ok(result.depthWarning);
  assert.equal(worker("depth").terminated, true);
});

test("a color decode error is surfaced without main-thread retry", async (t) => {
  const { decodeJxlFile, worker } = await environment(t);
  const request = decodeJxlFile(file());
  await tick();
  worker("depth").finish(null);
  worker("color").finish(null, "Invalid color frame");
  await assert.rejects(request, /Invalid color frame/);
});

test("depth pixels retain orientation, normalization, and clamping", (t) => {
  const previousImageData = globalThis.ImageData;
  globalThis.ImageData = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
  t.after(() => { globalThis.ImageData = previousImageData; });
  const descriptor = { bitDepth: { sampleFormat: "unsigned-integer", bits: 8 } };
  const plane = new Int32Array([0, 51, 102, 153, 204, 255]);
  const expected = [
    [0, 51, 102, 153, 204, 255], [51, 0, 153, 102, 255, 204],
    [255, 204, 153, 102, 51, 0], [204, 255, 102, 153, 0, 51],
    [0, 102, 204, 51, 153, 255], [204, 102, 0, 255, 153, 51],
    [255, 153, 51, 204, 102, 0], [51, 153, 255, 0, 102, 204],
  ];
  for (let orientation = 1; orientation <= 8; orientation += 1) {
    const image = depthPlaneToImageData(plane, 2, 3, descriptor, orientation);
    assert.equal(image.width, orientation >= 5 ? 3 : 2);
    assert.equal(image.height, orientation >= 5 ? 2 : 3);
    assert.deepEqual(Array.from(image.data).filter((_, index) => index % 4 === 0), expected[orientation - 1]);
  }
  const clamped = depthPlaneToImageData(new Int32Array([-3, 259]), 2, 1, descriptor, 1);
  assert.deepEqual([clamped.data[0], clamped.data[4]], [0, 255]);
  const sixteen = depthPlaneToImageData(new Uint16Array([0, 32768, 65535]), 3, 1, { bitDepth: { sampleFormat: "unsigned-integer", bits: 16 } }, 1);
  assert.deepEqual([sixteen.data[0], sixteen.data[4], sixteen.data[8]], [0, 128, 255]);
});
