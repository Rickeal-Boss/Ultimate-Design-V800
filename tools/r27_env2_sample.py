"""R27-T3b 截图像素采样（主观判读 → 客观数字）。
用法：python tools/r27_env2_sample.py <png> <x,y,w,h[:label]> ...
输出每块区域的 RGB 中位 / p05 / p95 / 亮度 L。
"""
import sys
from PIL import Image
import numpy as np


def lum(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def main():
    path = sys.argv[1]
    im = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    print(f"# {path}  {im.shape[1]}x{im.shape[0]}")
    for spec in sys.argv[2:]:
        box, _, label = spec.partition(":")
        x, y, w, h = (int(v) for v in box.split(","))
        reg = im[y : y + h, x : x + w]
        L = lum(reg)
        med = np.median(reg.reshape(-1, 3), axis=0).astype(int)
        p05, p95 = np.percentile(L, [5, 95])
        r, g, b = (int(v) for v in med)
        print(
            f"{label or box:18s} med #{r:02x}{g:02x}{b:02x}  L med {np.median(L):5.1f}"
            f"  p05 {p05:5.1f}  p95 {p95:5.1f}  sat {((reg.max(-1)-reg.min(-1))/np.maximum(reg.max(-1),1)).mean():.3f}"
        )


if __name__ == "__main__":
    main()
