"""R17 R7 参考图量化分析 v2：正侧图车顶轮廓/轮心/地线。只读。"""
from PIL import Image
import json
import os

SRC = "C:/Users/16896/.workbuddy/clipboard-images/clipboard-2026-10-19T04-46-20-099Z-ed6b05ea.jpg"
OUT = "C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs/tools/r17_r7_crops"
os.makedirs(OUT, exist_ok=True)

im = Image.open(SRC).convert("RGB")
W, H = im.size
px = im.load()
print(f"image {W}x{H}")
print("corner px:", px[3, 3], px[W - 4, 3], px[3, H - 4], px[W - 4, H - 4], px[W // 2, 3])


def lum(c):
    return (c[0] + c[1] + c[2]) / 3


def near_black(c):
    # 轮胎近黑（lum<45）；深色地板 lum≈88、侧裙 lum≈20 但竖跨短
    return lum(c) < 45


# 1) 轮心：底部区域逐列统计近黑像素（轮胎≈200+，侧裙≈36）
cnt = [0] * W
low = [0] * W
for x in range(W):
    n = 0
    lo = 0
    for y in range(int(H * 0.55), H):
        if near_black(px[x, y]):
            n += 1
            lo = y
    cnt[x] = n
    low[x] = lo
cols = [x for x in range(W) if cnt[x] > 120]
clusters = []
if cols:
    cur = [cols[0]]
    for x in cols[1:]:
        if x - cur[-1] <= 4:
            cur.append(x)
        else:
            clusters.append(cur)
            cur = [x]
    clusters.append(cur)
clusters = [c for c in clusters if len(c) > 60]
wheels = []
for c in clusters:
    xc = (c[0] + c[-1]) / 2
    wheels.append({"x": xc, "ground_y": low[int(xc)], "x0": c[0], "x1": c[-1], "wpx": c[-1] - c[0]})
print("wheels:")
for w in wheels:
    print(f"  x={w['x']:.0f} ({w['x']/W:.3f}) w={w['wpx']}px ground_y={w['ground_y']}")

xf, xr = wheels[0]["x"], wheels[-1]["x"]
gy = sum(w["ground_y"] for w in wheels) / len(wheels)
tire_px = sum(w["wpx"] for w in wheels) / len(wheels)
z_per_px = 2.95 / (xr - xf)
h_per_px = 0.766 / tire_px
print(f"xf={xf:.0f} xr={xr:.0f} gy={gy:.1f} tire_px={tire_px:.0f}")
print(f"z_per_px={z_per_px:.5f} h_per_px={h_per_px:.5f}")


def to_model(x, y):
    return 1.475 - (x - xf) * z_per_px, (gy - y) * h_per_px


# 2) 车顶轮廓：背景亮（avg lum≈217），车身暗（avg lum≈67）。每列自顶向下第一个 lum<120 的像素
roof = []
for x in range(W):
    y = 0
    while y < H and lum(px[x, y]) > 120:
        y += 1
    roof.append(min(y, H - 1))

pts = []
for i in range(0, W, W // 48):
    z, h = to_model(i, roof[i])
    pts.append((round(z, 3), round(h, 3)))
print("roofline (z,h) 48pt:")
for j in range(0, len(pts), 4):
    print("  ", pts[j:j + 4])

# 3) 关键横坐标：机盖前端（z≈2.48）/ 车尾端（z≈-2.48）
for zt in (2.478, 2.0, 1.0, 0.0, -1.0, -1.5, -2.0, -2.3, -2.478):
    x = xf - (1.475 - zt) / z_per_px
    xi = min(W - 1, max(0, int(x)))
    print(f"  z={zt:+.3f} -> x={xi} roof_h={to_model(xi, roof[xi])[1]:.3f}")

# 4) 保存裁剪图
im.crop((int(W * 0.20), 0, W, int(H * 0.66))).resize((int(W * 0.80 * 1.4), int(H * 0.66 * 1.4))).save(f"{OUT}/side_roof.png")
im.crop((int(W * 0.28), int(H * 0.30), int(W * 0.98), int(H * 0.95))).resize((int(W * 0.70 * 1.8), int(H * 0.65 * 1.8))).save(f"{OUT}/side_doors.png")
json.dump({"roof": pts, "wheels": wheels, "z_per_px": z_per_px, "h_per_px": h_per_px, "ground_y": gy},
          open(f"{OUT}/side_metrics.json", "w"), ensure_ascii=False, indent=1)
print("done")
