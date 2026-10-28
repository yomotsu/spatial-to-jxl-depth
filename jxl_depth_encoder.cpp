#include <jxl/encode.h>
#include <jxl/codestream_header.h>
#include <jxl/resizable_parallel_runner.h>

#include <array>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

std::vector<uint8_t> ReadFile(const std::string& path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) throw std::runtime_error("Cannot read " + path);
  return std::vector<uint8_t>(std::istreambuf_iterator<char>(input), {});
}

void Check(JxlEncoderStatus status, const char* operation) {
  if (status != JXL_ENC_SUCCESS) {
    throw std::runtime_error(std::string("JPEG XL encoder failed at ") + operation);
  }
}

uint32_t ParseUint(const char* value, const char* label) {
  char* end = nullptr;
  const unsigned long parsed = std::strtoul(value, &end, 10);
  if (end == value || *end != '\0' || parsed > UINT32_MAX) {
    throw std::runtime_error(std::string("Invalid ") + label);
  }
  return static_cast<uint32_t>(parsed);
}

float ParseFloat(const char* value, const char* label) {
  char* end = nullptr;
  const float parsed = std::strtof(value, &end);
  if (end == value || *end != '\0' || parsed < 0.0f || parsed > 25.0f) {
    throw std::runtime_error(std::string("Invalid ") + label);
  }
  return parsed;
}

void Encode(const std::string& color_path, const std::string& depth_path,
            const std::string& icc_path, const std::string& exif_path,
            const std::string& xmp_path, const std::string& output_path,
            uint32_t width, uint32_t height, uint32_t depth_width,
            uint32_t depth_height, uint32_t orientation, float distance,
            uint32_t effort) {
  const std::vector<uint8_t> color = ReadFile(color_path);
  const std::vector<uint8_t> depth = ReadFile(depth_path);
  const std::vector<uint8_t> icc = ReadFile(icc_path);
  const std::vector<uint8_t> exif = ReadFile(exif_path);
  const std::vector<uint8_t> xmp = ReadFile(xmp_path);

  const uint64_t pixel_count = static_cast<uint64_t>(width) * height;
  uint32_t color_channels = 0;
  if (color.size() == pixel_count * 3) {
    color_channels = 3;
  } else if (color.size() == pixel_count * 4) {
    color_channels = 4;
  } else {
    throw std::runtime_error("Color buffer size does not match its dimensions");
  }
  if (depth.size() != static_cast<uint64_t>(depth_width) * depth_height) {
    throw std::runtime_error("Depth buffer size does not match its dimensions");
  }
  if (orientation < 1 || orientation > 8) {
    throw std::runtime_error("Invalid image orientation");
  }

  JxlEncoder* encoder = JxlEncoderCreate(nullptr);
  if (encoder == nullptr) throw std::runtime_error("Cannot create JPEG XL encoder");
  void* runner = JxlResizableParallelRunnerCreate(nullptr);
  if (runner == nullptr) {
    JxlEncoderDestroy(encoder);
    throw std::runtime_error("Cannot create JPEG XL worker threads");
  }

  try {
    const uint32_t suggested_threads =
        JxlResizableParallelRunnerSuggestThreads(width, height);
    JxlResizableParallelRunnerSetThreads(runner,
                                         suggested_threads > 0 ? suggested_threads : 1);
    Check(JxlEncoderSetParallelRunner(encoder, JxlResizableParallelRunner, runner),
          "JxlEncoderSetParallelRunner");
    Check(JxlEncoderUseBoxes(encoder), "JxlEncoderUseBoxes");

    JxlBasicInfo basic_info;
    JxlEncoderInitBasicInfo(&basic_info);
    basic_info.xsize = width;
    basic_info.ysize = height;
    basic_info.bits_per_sample = 8;
    basic_info.exponent_bits_per_sample = 0;
    basic_info.num_color_channels = 3;
    basic_info.num_extra_channels = color_channels == 4 ? 2 : 1;
    basic_info.alpha_bits = color_channels == 4 ? 8 : 0;
    basic_info.alpha_exponent_bits = 0;
    basic_info.alpha_premultiplied = JXL_FALSE;
    basic_info.have_container = JXL_TRUE;
    basic_info.uses_original_profile =
        !icc.empty() && distance == 0.0f ? JXL_TRUE : JXL_FALSE;
    basic_info.orientation = static_cast<JxlOrientation>(orientation);
    Check(JxlEncoderSetBasicInfo(encoder, &basic_info), "JxlEncoderSetBasicInfo");

    if (!icc.empty()) {
      Check(JxlEncoderSetICCProfile(encoder, icc.data(), icc.size()),
            "JxlEncoderSetICCProfile");
    } else {
      JxlColorEncoding color_encoding;
      JxlColorEncodingSetToSRGB(&color_encoding, JXL_FALSE);
      Check(JxlEncoderSetColorEncoding(encoder, &color_encoding),
            "JxlEncoderSetColorEncoding");
    }

    uint32_t depth_channel_index = 0;
    if (color_channels == 4) {
      JxlExtraChannelInfo alpha_info;
      JxlEncoderInitExtraChannelInfo(JXL_CHANNEL_ALPHA, &alpha_info);
      alpha_info.bits_per_sample = 8;
      Check(JxlEncoderSetExtraChannelInfo(encoder, 0, &alpha_info),
            "JxlEncoderSetExtraChannelInfo(alpha)");
      depth_channel_index = 1;
    }

    JxlExtraChannelInfo depth_info;
    JxlEncoderInitExtraChannelInfo(JXL_CHANNEL_DEPTH, &depth_info);
    depth_info.bits_per_sample = 8;
    depth_info.exponent_bits_per_sample = 0;
    depth_info.dim_shift = 0;
    Check(JxlEncoderSetExtraChannelInfo(encoder, depth_channel_index, &depth_info),
          "JxlEncoderSetExtraChannelInfo(depth)");
    Check(JxlEncoderSetExtraChannelName(encoder, depth_channel_index,
                                        "Apple disparity", 15),
          "JxlEncoderSetExtraChannelName");

    JxlEncoderFrameSettings* frame_settings =
        JxlEncoderFrameSettingsCreate(encoder, nullptr);
    if (frame_settings == nullptr) throw std::runtime_error("Cannot create frame settings");
    Check(JxlEncoderFrameSettingsSetOption(frame_settings,
                                          JXL_ENC_FRAME_SETTING_EFFORT,
                                          effort),
          "JxlEncoderFrameSettingsSetOption");
    if (distance == 0.0f) {
      Check(JxlEncoderSetFrameLossless(frame_settings, JXL_TRUE),
            "JxlEncoderSetFrameLossless");
    } else {
      Check(JxlEncoderSetFrameDistance(frame_settings, distance),
            "JxlEncoderSetFrameDistance");
    }
    Check(JxlEncoderSetExtraChannelDistance(frame_settings, depth_channel_index, distance),
          "JxlEncoderSetExtraChannelDistance(depth)");
    if (color_channels == 4) {
      Check(JxlEncoderSetExtraChannelDistance(frame_settings, 0, 0.0f),
            "JxlEncoderSetExtraChannelDistance(alpha)");
    }

    JxlPixelFormat color_format = {
        color_channels, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
    Check(JxlEncoderAddImageFrame(frame_settings, &color_format, color.data(),
                                  color.size()),
          "JxlEncoderAddImageFrame");

    JxlPixelFormat depth_format = {1, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
    Check(JxlEncoderSetExtraChannelBuffer(frame_settings, &depth_format,
                                          depth.data(), depth.size(),
                                          depth_channel_index),
          "JxlEncoderSetExtraChannelBuffer(depth)");

    if (!exif.empty()) {
      const JxlBoxType exif_type = {'E', 'x', 'i', 'f'};
      Check(JxlEncoderAddBox(encoder, exif_type, exif.data(), exif.size(), JXL_FALSE),
            "JxlEncoderAddBox(Exif)");
    }
    if (!xmp.empty()) {
      const JxlBoxType xmp_type = {'x', 'm', 'l', ' '};
      Check(JxlEncoderAddBox(encoder, xmp_type, xmp.data(), xmp.size(), JXL_FALSE),
            "JxlEncoderAddBox(XMP)");
    }
    JxlEncoderCloseInput(encoder);

    std::ofstream output(output_path, std::ios::binary);
    if (!output) throw std::runtime_error("Cannot write " + output_path);

    std::array<uint8_t, 1 << 20> buffer{};
    uint8_t* next_out = buffer.data();
    size_t available_out = buffer.size();
    JxlEncoderStatus status;
    do {
      status = JxlEncoderProcessOutput(encoder, &next_out, &available_out);
      const size_t produced = static_cast<size_t>(next_out - buffer.data());
      output.write(reinterpret_cast<const char*>(buffer.data()), produced);
      if (!output) throw std::runtime_error("Failed while writing JPEG XL output");
      if (status == JXL_ENC_NEED_MORE_OUTPUT) {
        next_out = buffer.data();
        available_out = buffer.size();
      } else if (status != JXL_ENC_SUCCESS) {
        throw std::runtime_error("JPEG XL encoding failed while processing output");
      }
    } while (status != JXL_ENC_SUCCESS);
    output.close();
  } catch (...) {
    JxlEncoderDestroy(encoder);
    JxlResizableParallelRunnerDestroy(runner);
    throw;
  }

  JxlEncoderDestroy(encoder);
  JxlResizableParallelRunnerDestroy(runner);
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 14) {
    std::cerr << "Usage: jxl_depth_encoder COLOR DEPTH ICC EXIF XMP OUTPUT "
                 "WIDTH HEIGHT DEPTH_WIDTH DEPTH_HEIGHT ORIENTATION DISTANCE EFFORT\n";
    return 2;
  }

  try {
    Encode(argv[1], argv[2], argv[3], argv[4], argv[5], argv[6],
           ParseUint(argv[7], "width"), ParseUint(argv[8], "height"),
           ParseUint(argv[9], "depth width"), ParseUint(argv[10], "depth height"),
           ParseUint(argv[11], "orientation"), ParseFloat(argv[12], "distance"),
           ParseUint(argv[13], "effort"));
  } catch (const std::exception& error) {
    std::cerr << "error: " << error.what() << "\n";
    return 1;
  }
  return 0;
}
