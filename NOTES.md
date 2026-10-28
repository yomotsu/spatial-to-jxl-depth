# プロジェクトメモ

## Distance とチャンネル

- `Distance` は JPEG XL の知覚的な画質指定。0 は数学的ロスレスで、値が高いほど見た目の差を許容する。libjxl の目安は 0.5〜3.0、指定範囲は 0〜25。
- このアプリは色画像の Distance を深度追加チャンネルにも適用する。Distance が 0 より大きければ深度もロッシーになる。アルファチャンネルは Distance 0 のまま。
- リサイズ時は色画像を LANCZOS、深度マップを最近傍補間で出力サイズへ変換する。「ロスレス」はリサイズ後の深度データを JPEG XL 内でロスレス保存する意味。
- libjxl は追加チャンネルごとの Distance 指定に対応するが、このアプリでは色と深度に同じ値を使う。
- `cjxl` の Quality（0〜100）は Distance の代替指定で、内部で Distance に変換される。両方は同時指定できない。

参考: [cjxl マニュアル](https://github.com/libjxl/libjxl/blob/main/doc/man/cjxl.txt)、[libjxl エンコード effort](https://github.com/libjxl/libjxl/blob/main/doc/encode_effort.md)

## Effort

- Effort を上げるとエンコード時間が延び、より多くの圧縮手法や探索を使う。非可逆圧縮では同じファイルサイズで画質が向上する場合があるが、容量が必ず小さくなるわけではない。
- Effort は JPEG ブロックノイズ専用の除去機能ではない。圧縮後にブロック状の荒れが目立ちにくくなる場合はあるが、`encode_effort.md` はその効果を保証していない。

## デモの JXL 深度読み込み

- demo は同梱の JavaScript デコーダーで JXL の追加チャンネルを抽出する。Common VarDCT の深度抽出経路は XYB 色変換を前提とする。
- ICC 付き入力をロッシー圧縮する際に `uses_original_profile=true` のままだと、非 XYB の VarDCT が出力され、demo で `Common VarDCT decode requires bounded XYB groups...` エラーになることがある。リサイズそのものが原因ではない。
- 現在はロスレス時だけ元の ICC プロファイル形式を使い、ロッシー時は libjxl の XYB 変換を使う。ICC プロファイルは引き続きエンコーダーへ渡す。
- `IMG_8733.HEIC` を 1024×768、Distance 3 で変換し、demo と同じデコーダーで色・深度の各プレーンを読み取れることを確認した。修正前に生成した JXL は再変換が必要。
