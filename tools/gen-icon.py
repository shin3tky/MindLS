#!/usr/bin/env python3
"""拡張のアイコンを描く。

Marketplace のアイコンは PNG しか受け付けないので、これが唯一の出どころ。
題材は日本語のかぎ括弧 「 」。日本語のテキストを扱う道具だと一目で分かり、
フォントに頼らないので環境を選ばない。

    python3 tools/gen-icon.py
"""

from PIL import Image, ImageDraw

SIZE = 256
BG = (26, 31, 46)        # 深い藍
FG = (236, 239, 244)     # 生成り
ACCENT = (230, 162, 60)  # 山吹

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=56, fill=BG)

t = 18   # 線の太さ
arm = 74  # かぎの長さ

# 左上のかぎ 「
x, y = 46, 58
d.rectangle((x, y, x + arm, y + t), fill=FG)
d.rectangle((x, y, x + t, y + arm), fill=FG)

# 右下のかぎ 」
x2, y2 = SIZE - 46, SIZE - 58
d.rectangle((x2 - arm, y2 - t, x2, y2), fill=FG)
d.rectangle((x2 - t, y2 - arm, x2, y2), fill=FG)

# 括弧にはさまれた単語を表す一画
d.rounded_rectangle((92, 118, 164, 138), radius=10, fill=ACCENT)

img.save("packages/vscode-mind/icon.png")
print("packages/vscode-mind/icon.png", img.size)
