// Persistent, independent decoder instances: WASM color and JavaScript depth
// can execute at the same time without blocking pointer or progress updates.
const kind = new URL(self.location.href).searchParams.get("kind");
const ready = kind === "depth"
  ? import("./jxl-depth.js").then(async (module) => {
    await module.prepareDepthDecoder();
    return module.extractJxlDepthPixels;
  })
  : import("./vendor/jxl/decode.js").then(async (module) => {
    await module.init();
    return module.default;
  });
// A warm-up failure is reported with the next request, not as an unhandled
// rejection when the user has not selected a file yet.
void ready.catch(() => {});

self.onmessage = async ({ data: { id, file } }) => {
  try {
    const [decode, buffer] = await Promise.all([ready, file.arrayBuffer()]);
    const image = await decode(buffer);
    if (!image) {
      self.postMessage({ id, image: null });
      return;
    }
    const pixels = image.data;
    // Transfer ownership of decoded pixels; do not clone large RGBA buffers.
    self.postMessage({ id, image: { width: image.width, height: image.height, pixels } }, [pixels.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  }
};
