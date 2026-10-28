# Spatial HEIC to JPEG XL

macOS の Electron アプリとコマンドラインツールで、HEIC 画像を JPEG XL に変換します。対応する深度情報は JPEG XL の depth 追加チャンネルとして保存します。

公開デモ: https://yomotsu.github.io/spatial-to-jxl-depth/

デモは `demo/` にあります。GitHub Pages ではこのフォルダーだけを配信します。アプリ本体と変換用ソースコードもこのリポジトリに含みますが、写真や HEIC / JXL のサンプルファイルは含みません。

## 必要な環境

- macOS
- Homebrew、Xcode Command Line Tools、Node.js
- Python 3 と Pillow
- `heif-convert`、`heif-info`、`djxl`、`pkg-config`、C++ コンパイラ

```sh
brew install libheif jpeg-xl pkg-config
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm install
npm start
```

アプリで HEIC を選ぶと、元画像サイズとアスペクト比を読み込みます。比較プレビューは画像上の境界をドラッグして操作できます。JPEG XL のエンコードには利用可能な CPU コアを使い、ビルド済みエンコーダーを再利用します。

## コマンドライン

```sh
python3 heic_to_jxl.py /path/to/input.HEIC
python3 heic_to_jxl.py /path/to/input.HEIC --distance 1.0 --effort 9
python3 heic_to_jxl.py /path/to/input.HEIC --output converted.jxl --distance 0
```

`--distance` は 0〜25、`--effort` は 1〜10（既定値 3）です。`--width` と `--height` を同時に指定すると出力サイズを変更できます。省略時は元画像のサイズを使います。

## 深度チャンネル

JPEG XL に既定の深度形式はないため、このプロジェクトでは `JXL_CHANNEL_DEPTH` 型の追加チャンネルを明示して保存します。HEIC の深度補助画像から値を読み込み、エンコーダーが受け付けるサイズに合わせて補間します。入力 XMP と EXIF も引き継ぎます。

## 構成

- `electron/`: Electron main process と preload bridge
- `web/`: Electron renderer
- `heic_to_jxl.py`: 深度補助画像の抽出、変換オプション、レポート
- `jxl_depth_encoder.cpp`: 色画像と深度チャンネルの JPEG XL エンコーダー
- `demo/`: 写真を使わない、ブラウザー内の視差デモ

HEIC、JXL、その他の写真ファイルは `.gitignore` で除外しています。
