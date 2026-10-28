#!/usr/bin/env python3
"""Convert a HEIC image with an auxiliary depth map to JPEG XL."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import hashlib
import json
import os
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover - depends on the local environment
    raise SystemExit("Pillow is required. Install it with: python3 -m pip install Pillow") from exc


DEPTH_DIM_SHIFT = 0
DEPTH_CHANNEL_NAME = "Apple disparity"
MAX_OUTPUT_DIMENSION = 32768
MAX_OUTPUT_PIXELS = 50_000_000
XMP_NAMESPACE = "https://github.com/aki/spatial-to-jxl-depth/ns/1.0/"
RDF_NAMESPACE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"


def run(command: list[str], *, capture: bool = True) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            check=True,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"Required program not found: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        details = (exc.stderr or exc.stdout or "").strip()
        raise RuntimeError(f"Command failed: {' '.join(command)}\n{details}") from exc


def find_depth_image(prefix: Path) -> Path:
    depth_path = prefix.with_name(f"{prefix.stem}-1-depth{prefix.suffix}")
    if not depth_path.is_file():
        raise RuntimeError(
            "No auxiliary depth image was decoded. The input may not contain an "
            "iPhone depth map, or libheif may be too old."
        )
    return depth_path


def jxl_exif(exif: bytes | None) -> bytes | None:
    if not exif:
        return None
    # PNG's eXIf payload from libheif includes the six-byte "Exif\0\0" prefix.
    # JPEG XL's Exif box starts with the four-byte offset to the TIFF header.
    if exif.startswith(b"Exif\0\0"):
        tiff = exif[6:]
        return struct.pack(">I", 2) + tiff
    if exif[:4] in (b"II*\0", b"MM\0*"):
        return b"\0\0\0\0" + exif
    return None


def enrich_xmp(xmp: bytes | str | None, source_depth_size: tuple[int, int], stored_depth_size: tuple[int, int]) -> bytes:
    if isinstance(xmp, str):
        xmp_bytes = xmp.encode("utf-8")
    else:
        xmp_bytes = xmp or b""

    # Keep Apple's XMP depth/disparity range and camera calibration metadata, and
    # record the resolution change needed by JPEG XL's power-of-two channel scale.
    ET.register_namespace("rdf", RDF_NAMESPACE)
    ET.register_namespace("stjxl", XMP_NAMESPACE)
    root = None
    if xmp_bytes:
        try:
            from io import BytesIO

            for _, ns in ET.iterparse(BytesIO(xmp_bytes), events=("start-ns",)):
                prefix, uri = ns
                if prefix and prefix not in ("rdf", "stjxl", "xml", "xmlns"):
                    try:
                        ET.register_namespace(prefix, uri)
                    except ValueError:
                        pass
            root = ET.fromstring(xmp_bytes)
        except ET.ParseError:
            root = None

    if root is None:
        root = ET.Element("{adobe:ns:meta/}xmpmeta")
        rdf = ET.SubElement(root, f"{{{RDF_NAMESPACE}}}RDF")
        description = ET.SubElement(rdf, f"{{{RDF_NAMESPACE}}}Description")
    else:
        descriptions = root.findall(f".//{{{RDF_NAMESPACE}}}Description")
        if descriptions:
            description = descriptions[0]
        else:
            rdf = root.find(f".//{{{RDF_NAMESPACE}}}RDF")
            if rdf is None:
                rdf = ET.SubElement(root, f"{{{RDF_NAMESPACE}}}RDF")
            description = ET.SubElement(rdf, f"{{{RDF_NAMESPACE}}}Description")

    source_width, source_height = source_depth_size
    stored_width, stored_height = stored_depth_size
    properties = {
        "depthChannelName": DEPTH_CHANNEL_NAME,
        "depthChannelType": "JPEG XL JXL_CHANNEL_DEPTH",
        "depthSampleEncoding": "unsigned 8-bit Apple disparity samples (0..255)",
        "depthDimShift": str(DEPTH_DIM_SHIFT),
        "sourceDepthWidth": str(source_width),
        "sourceDepthHeight": str(source_height),
        "storedDepthWidth": str(stored_width),
        "storedDepthHeight": str(stored_height),
        "depthResizeFilter": "nearest-neighbor",
    }
    for key, value in properties.items():
        description.set(f"{{{XMP_NAMESPACE}}}{key}", value)

    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def compile_encoder(source: Path) -> Path:
    try:
        flags = run(["pkg-config", "--cflags", "libjxl", "libjxl_threads"]).stdout.split()
        flags += run(["pkg-config", "--libs", "libjxl_threads", "libjxl"]).stdout.split()
        library_version = run(["pkg-config", "--modversion", "libjxl"]).stdout.strip()
    except RuntimeError as exc:
        raise RuntimeError(
            "libjxl and libjxl_threads development files and pkg-config are required. On macOS, run: "
            "brew install jpeg-xl pkg-config"
        ) from exc

    compiler = shlex.split(os.environ.get("CXX", "c++"))
    if not compiler:
        compiler = ["c++"]
    build_args = ["-std=c++17", "-O2", str(source)] + flags
    cache_key = hashlib.sha256(
        source.read_bytes()
        + "\0".join([library_version] + compiler + build_args).encode("utf-8")
    ).hexdigest()[:20]
    cache_dir = Path(tempfile.gettempdir()) / "spatial-to-jxl-cache"
    destination = cache_dir / f"jxl_depth_encoder-{cache_key}"
    if destination.is_file():
        return destination

    cache_dir.mkdir(parents=True, exist_ok=True)
    temporary_destination = cache_dir / f".{destination.name}-{os.getpid()}"
    command = compiler + build_args + ["-o", str(temporary_destination)]
    try:
        run(command)
    except RuntimeError as exc:
        temporary_destination.unlink(missing_ok=True)
        raise RuntimeError(f"Could not compile the JPEG XL encoder helper.\n{exc}") from exc
    try:
        os.replace(temporary_destination, destination)
    except OSError:
        temporary_destination.unlink(missing_ok=True)
        if not destination.is_file():
            raise
    return destination


def make_preview(image: Image.Image, icc_profile: bytes | None) -> bytes:
    preview = image.convert("RGB")
    preview.thumbnail((1800, 1400), getattr(Image, "Resampling", Image).LANCZOS)
    buffer = BytesIO()
    save_options = {"format": "JPEG", "quality": 82, "optimize": True}
    if icc_profile:
        save_options["icc_profile"] = icc_profile
    preview.save(buffer, **save_options)
    return buffer.getvalue()


def convert(
    input_path: Path,
    output_path: Path,
    distance: float,
    effort: int,
    *,
    resize_to: tuple[int, int] | None = None,
    make_previews: bool = False,
    quiet: bool = False,
) -> dict[str, object]:
    input_path = input_path.expanduser().resolve()
    output_path = output_path.expanduser().resolve()
    if not input_path.is_file():
        raise RuntimeError(f"Input file does not exist: {input_path}")
    if output_path.suffix.lower() not in (".jxl", ".jxlc"):
        raise RuntimeError("The output filename must end in .jxl")
    if input_path == output_path:
        raise RuntimeError("Input and output paths must be different")
    if distance < 0 or distance > 25:
        raise RuntimeError("--distance must be between 0 and 25 (0 means lossless)")
    if effort < 1 or effort > 10:
        raise RuntimeError("--effort must be between 1 and 10")
    if resize_to is not None:
        output_width, output_height = resize_to
        if (
            output_width < 1
            or output_height < 1
            or output_width > MAX_OUTPUT_DIMENSION
            or output_height > MAX_OUTPUT_DIMENSION
            or output_width * output_height > MAX_OUTPUT_PIXELS
        ):
            raise RuntimeError(
                f"Output dimensions must be positive, at most {MAX_OUTPUT_DIMENSION} per side, "
                f"and no more than {MAX_OUTPUT_PIXELS:,} pixels total."
            )

    script_dir = Path(__file__).resolve().parent
    helper_source = script_dir / "jxl_depth_encoder.cpp"
    if not helper_source.is_file():
        raise RuntimeError(f"Missing encoder source file: {helper_source}")

    with tempfile.TemporaryDirectory(prefix="heic-to-jxl-") as temporary:
        temp_dir = Path(temporary)
        decoded_prefix = temp_dir / "decoded.png"
        run(
            [
                "heif-convert",
                "--with-aux",
                "--quiet",
                str(input_path),
                str(decoded_prefix),
            ]
        )
        main_path = temp_dir / "decoded-1.png"
        depth_path = find_depth_image(decoded_prefix)
        if not main_path.is_file():
            raise RuntimeError("libheif did not produce a primary PNG image")

        with Image.open(main_path) as main_image:
            color_has_alpha = "A" in main_image.getbands() or "transparency" in main_image.info
            color_image = main_image.convert("RGBA" if color_has_alpha else "RGB")
            source_color_size = color_image.size
            source_color_image = color_image
            if resize_to is not None and resize_to != source_color_size:
                color_image = color_image.resize(
                    resize_to,
                    getattr(Image, "Resampling", Image).LANCZOS,
                )
            width, height = color_image.size
            color_data = color_image.tobytes()
            icc_profile = main_image.info.get("icc_profile")
            exif_data = jxl_exif(main_image.info.get("exif"))
            exif = main_image.getexif()
            orientation = int(exif.get(274, 1))
            if orientation < 1 or orientation > 8:
                orientation = 1
        with Image.open(depth_path) as depth_image:
            source_depth_size = depth_image.size
            depth_plane = depth_image.convert("RGB").getchannel("R")
            # libjxl's public encoder API accepts an extra-channel buffer at
            # the main image dimensions. Upsample the small HEIC map to full
            # resolution and mark it as a full-resolution depth channel.
            stored_depth_size = (width, height)
            resampling = getattr(Image, "Resampling", Image).NEAREST
            depth_plane = depth_plane.resize(stored_depth_size, resampling)
            depth_data = depth_plane.tobytes()
            xmp = depth_image.info.get("xmp") or depth_image.info.get("XML:com.adobe.xmp")
            xmp_data = enrich_xmp(xmp, source_depth_size, stored_depth_size)

        color_path = temp_dir / "color.raw"
        depth_raw_path = temp_dir / "depth.raw"
        icc_path = temp_dir / "color.icc"
        exif_path = temp_dir / "metadata.exif"
        xmp_path = temp_dir / "metadata.xmp"
        encoder_path = compile_encoder(helper_source)
        temporary_output = temp_dir / output_path.name

        color_path.write_bytes(color_data)
        depth_raw_path.write_bytes(depth_data)
        icc_path.write_bytes(icc_profile or b"")
        exif_path.write_bytes(exif_data or b"")
        xmp_path.write_bytes(xmp_data)
        preview_executor = ThreadPoolExecutor(max_workers=1) if make_previews else None
        before_preview_future = None
        try:
            if preview_executor:
                before_preview_future = preview_executor.submit(
                    make_preview, source_color_image, icc_profile
                )
            run(
                [
                    str(encoder_path),
                    str(color_path),
                    str(depth_raw_path),
                    str(icc_path),
                    str(exif_path),
                    str(xmp_path),
                    str(temporary_output),
                    str(width),
                    str(height),
                    str(stored_depth_size[0]),
                    str(stored_depth_size[1]),
                    str(orientation),
                    str(distance),
                    str(effort),
                ]
            )

            after_preview = None
            before_preview = None
            if make_previews:
                decoded_jxl_png = temp_dir / "jxl-preview.png"
                run(["djxl", str(temporary_output), str(decoded_jxl_png)])
                with Image.open(decoded_jxl_png) as decoded_image:
                    after_preview = make_preview(decoded_image, decoded_image.info.get("icc_profile"))
                before_preview = before_preview_future.result()
        finally:
            if preview_executor:
                preview_executor.shutdown(wait=True, cancel_futures=True)

        input_size = input_path.stat().st_size
        output_size = temporary_output.stat().st_size
        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(temporary_output), str(output_path))

    if not quiet:
        print(f"Created {output_path}")
        print(f"Color: {width}x{height}; depth channel: {stored_depth_size[0]}x{stored_depth_size[1]}")
        print(f"Depth source: {source_depth_size[0]}x{source_depth_size[1]} (Apple disparity samples preserved; nearest-neighbor upscaled)")
        if distance == 0:
            print("Color encoding: lossless from the decoded HEIC pixels")
        else:
            print(f"Color encoding: JPEG XL distance {distance:g}")

    return {
        "output_path": output_path,
        "input_size": input_size,
        "output_size": output_size,
        "source_color_size": source_color_size,
        "color_size": (width, height),
        "source_depth_size": source_depth_size,
        "stored_depth_size": stored_depth_size,
        "before_preview": before_preview,
        "after_preview": after_preview,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert an iPhone HEIC with depth to JPEG XL with a typed depth channel."
    )
    parser.add_argument("input", type=Path, help="HEIC/HEIF input containing a depth auxiliary image")
    parser.add_argument("-o", "--output", type=Path, help="output .jxl path (default: input name with .jxl)")
    parser.add_argument(
        "--distance",
        type=float,
        default=0,
        help="JPEG XL distance applied to color and depth channels, 0 for lossless (default: 0)",
    )
    parser.add_argument("--effort", type=int, default=3, help="encoder effort 1-10 (default: 3)")
    parser.add_argument("--width", type=int, help="output color width in pixels")
    parser.add_argument("--height", type=int, help="output color height in pixels")
    parser.add_argument("--before-preview", type=Path, help="write a JPEG preview of the decoded HEIC")
    parser.add_argument("--after-preview", type=Path, help="write a JPEG preview of the encoded JXL")
    parser.add_argument("--json-report", action="store_true", help="print conversion details as JSON")
    args = parser.parse_args()
    output = args.output or args.input.with_suffix(".jxl")
    if (args.width is None) != (args.height is None):
        parser.error("--width and --height must be used together")
    if bool(args.before_preview) != bool(args.after_preview):
        parser.error("--before-preview and --after-preview must be used together")

    try:
        result = convert(
            args.input,
            output,
            args.distance,
            args.effort,
            resize_to=(args.width, args.height) if args.width is not None else None,
            make_previews=bool(args.before_preview),
            quiet=args.json_report,
        )
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.before_preview and args.after_preview:
        args.before_preview.parent.mkdir(parents=True, exist_ok=True)
        args.after_preview.parent.mkdir(parents=True, exist_ok=True)
        args.before_preview.write_bytes(result["before_preview"])
        args.after_preview.write_bytes(result["after_preview"])

    if args.json_report:
        print(
            json.dumps(
                {
                    "output_path": str(result["output_path"]),
                    "input_size": result["input_size"],
                    "output_size": result["output_size"],
                    "color_size": result["color_size"],
                    "source_color_size": result["source_color_size"],
                    "source_depth_size": result["source_depth_size"],
                    "stored_depth_size": result["stored_depth_size"],
                    "distance": args.distance,
                    "effort": args.effort,
                }
            )
        )
    else:
        input_size = int(result["input_size"])
        output_size = int(result["output_size"])
        change = (output_size / input_size - 1) * 100 if input_size else 0
        print(f"Size: {input_size:,} → {output_size:,} bytes ({change:+.1f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
