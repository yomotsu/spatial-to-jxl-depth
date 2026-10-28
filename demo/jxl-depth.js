// Shared by the depth worker and the main-thread compatibility fallback.
let decoderPromise = null;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function prepareDepthDecoder() {
  return decoderPromise ||= import("./vendor/jxl-depth/decode.js");
}

function depthSampleAtOrientedPoint(plane, width, height, orientation, x, y) {
  let sourceX;
  let sourceY;
  switch (orientation) {
    case 1:
      sourceX = x;
      sourceY = y;
      break;
    case 2:
      sourceX = width - 1 - x;
      sourceY = y;
      break;
    case 3:
      sourceX = width - 1 - x;
      sourceY = height - 1 - y;
      break;
    case 4:
      sourceX = x;
      sourceY = height - 1 - y;
      break;
    case 5:
      sourceX = y;
      sourceY = x;
      break;
    case 6:
      sourceX = y;
      sourceY = height - 1 - x;
      break;
    case 7:
      sourceX = width - 1 - y;
      sourceY = height - 1 - x;
      break;
    case 8:
      sourceX = width - 1 - y;
      sourceY = x;
      break;
    default:
      throw new Error(`未対応のJXL画像向きです (${orientation})。`);
  }
  return plane[sourceY * width + sourceX] ?? 0;
}

export function depthPlaneToImageData(plane, width, height, descriptor, orientation) {
  if (descriptor.bitDepth.sampleFormat !== "unsigned-integer") {
    throw new Error("浮動小数点形式の深度チャンネルには対応していません。");
  }
  const bits = descriptor.bitDepth.bits;
  if (!Number.isInteger(bits) || bits < 1 || bits > 31) {
    throw new Error(`深度チャンネルのビット深度 ${bits} には対応していません。`);
  }
  if (plane.length !== width * height) {
    throw new Error("深度チャンネルの寸法とデータ長が一致しません。");
  }

  const orientedWidth = orientation >= 5 ? height : width;
  const orientedHeight = orientation >= 5 ? width : height;
  const scale = Math.min(1, 2048 / Math.max(orientedWidth, orientedHeight));
  const outputWidth = Math.max(1, Math.round(orientedWidth * scale));
  const outputHeight = Math.max(1, Math.round(orientedHeight * scale));
  const imageData = new ImageData(outputWidth, outputHeight);
  const maximum = 2 ** bits - 1;
  for (let y = 0; y < outputHeight; y += 1) {
    const sourceY = clamp((y + 0.5) * orientedHeight / outputHeight - 0.5, 0, orientedHeight - 1);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(y0 + 1, orientedHeight - 1);
    const fy = sourceY - y0;
    for (let x = 0; x < outputWidth; x += 1) {
      const sourceX = clamp((x + 0.5) * orientedWidth / outputWidth - 0.5, 0, orientedWidth - 1);
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(x0 + 1, orientedWidth - 1);
      const fx = sourceX - x0;
      const top = depthSampleAtOrientedPoint(plane, width, height, orientation, x0, y0) * (1 - fx)
        + depthSampleAtOrientedPoint(plane, width, height, orientation, x1, y0) * fx;
      const bottom = depthSampleAtOrientedPoint(plane, width, height, orientation, x0, y1) * (1 - fx)
        + depthSampleAtOrientedPoint(plane, width, height, orientation, x1, y1) * fx;
      const value = Math.round(clamp((top * (1 - fy) + bottom * fy) / maximum, 0, 1) * 255);
      const target = (y * outputWidth + x) * 4;
      imageData.data[target] = value;
      imageData.data[target + 1] = value;
      imageData.data[target + 2] = value;
      imageData.data[target + 3] = 255;
    }
  }
  return imageData;
}

export async function extractJxlDepthPixels(arrayBuffer) {
  const { openJpegXlSequence } = await prepareDepthDecoder();
  const sequence = await openJpegXlSequence(new Uint8Array(arrayBuffer), {
    maxDecodedPixels: 40000000,
    limits: { maxDecodedBytes: 4000000000 },
  });
  try {
    let hasDepthChannel = false;
    for await (const header of sequence.headers()) {
      if (header.extraChannels.some((channel) => channel.type === 1)) {
        hasDepthChannel = true;
        break;
      }
    }
    if (!hasDepthChannel) return null;

    for await (const layer of sequence.layers()) {
      if (layer.header.frameType !== "regular") continue;
      const depthChannelIndex = layer.header.extraChannels.findIndex((channel) => channel.type === 1);
      if (depthChannelIndex < 0) continue;
      const colorChannelCount = layer.planes.length - layer.header.extraChannels.length;
      const planeIndex = colorChannelCount + depthChannelIndex;
      const plane = layer.planes[planeIndex];
      const layout = layer.layouts[planeIndex];
      const descriptor = layer.header.extraChannels[depthChannelIndex];
      if (!plane || !layout || !descriptor) {
        throw new Error("JXL深度チャンネルのデータが見つかりません。");
      }
      return depthPlaneToImageData(
        plane,
        layout.width,
        layout.height,
        descriptor,
        layer.header.orientation,
      );
    }
    throw new Error("JXLの深度チャンネルを含む画像フレームがありません。");
  } finally {
    await sequence.close();
  }
}
