# R17 P0-3：seat-quilt.jpg 重 author —— 平场去光照渐变 + 缝线强化
# 背景：原实拍图被强左右渐变（边缘亮度 94→130）压制，菱格缝线（~2px 细亮纹）
# 在 mip + 渐变下糊成「大平面块」（用户报「接线后菱格方块化明显」）。
# 处理：① 除以大半径高斯模糊 = 平场（flat-field）消除光照渐变，使贴图可平铺
#       （四边亮度差 35 → ≤10）；② UnsharpMask 半径 5 强化缝线 crispness。
# 菱格密度不动：实测原图 ~12 缝线/1024px，tileWorld 0.24 下椅面单元格 ~2cm，
# 与真车（087Z 参考）同级 —— 密度不是病因，对比度才是。
# 用法：python tools/r17_requilt.py（写回 src/assets/ref/seat-quilt.jpg）
from PIL import Image, ImageFilter, ImageChops, ImageOps, ImageEnhance
import sys

SRC = r'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/src/assets/ref/seat-quilt.jpg'
DST = sys.argv[1] if len(sys.argv) > 1 else SRC

im = Image.open(SRC).convert('RGB')
w, h = im.size

# ① 平场：img * (255 - blur) / 255 ≈ img / blur（乘式近似，PIL 无 ImageChops.divide）
blur = im.filter(ImageFilter.GaussianBlur(90))
flat = ImageChops.multiply(im, ImageOps.invert(blur))

# 均值回归 128（绝对亮度由 refTextures 的 tint 机制二次归一到策展色，此处只防整体偏移）
g = flat.convert('L')
mean = sum(g.getdata()) // (g.size[0] * g.size[1])
if mean > 0:
    flat = ImageEnhance.Brightness(flat).enhance(min(2.0, max(0.5, 128 / mean)))

# ② 缝线强化：中半径 unsharp（threshold=2 只增强既有结构，不放大平坦区噪点）
out = flat.filter(ImageFilter.UnsharpMask(radius=5, percent=140, threshold=2))

out.save(DST, quality=90)
print('written', DST, out.size)

# 自检：四边亮度差（可平铺性）—— 原图 ~35，处理后应 ≤12
px = out.convert('L').load()
def edge(xs, ys):
    return sum(px[x, y] for x in xs for y in ys) / (len(xs) * len(ys))
L = edge(range(3), range(0, h, 4)); R = edge(range(w - 3, w), range(0, h, 4))
T = edge(range(0, w, 4), range(3)); B = edge(range(0, w, 4), range(h - 3, h))
print(f'edges L={L:.1f} R={R:.1f} T={T:.1f} B={B:.1f} maxdiff={max(L,R,T,B)-min(L,R,T,B):.1f}')
