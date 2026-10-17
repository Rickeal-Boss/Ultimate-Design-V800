# -*- coding: utf-8 -*-
"""a1_ex08_texture_sync.py — EX-08 spec 文本同步（结构工程师/搭景，R2 之后）

背景：调光第二轮已裁决并实施「createHeadlampLedTexture 简化为纯竖向光导」（暗底 + x[40,88]
全高亮带），6 枚 headlamp-led-dot-* 的 remapUVToRegion 落点 u[0.328,0.672]（画布 x[42,86]）
正落在新亮带内、重映射代码零改动。本脚本把 spec 中三处因此过期的描述文本同步为现状：
  1. lamp-head 材质 textureless 证据：原「3 枚圆形 LED 点阵由集成层 Canvas emissiveMap 提供」
     → 点阵由 headlamp-led-dot-* 几何件承担；Canvas 现为纯竖向光导贴图 + 点阵 UV 重映射
  2. headlamp-led-l/r 的 notes：「点阵贴图叠加于灯带表面」→「光导贴图（暗底+全高亮带）」
  3. 6 枚 headlamp-led-dot-* 的 localFeatures：remap「需/已通告」→「已由集成层落入光导亮带」
纯文本改动，不触碰任何几何/坐标/材质参数。改后 validate → 重产工厂 → tsc。
用法：python .img2threejs/tools/a1_ex08_texture_sync.py
"""
import json
import os

SPEC_PATH = os.path.join(os.path.dirname(__file__), "..", "object-sculpt-spec.json")

OLD_MAT_EVIDENCE = "头灯发光内芯为均匀 emissive；3 枚圆形 LED 点阵（EX-08）由集成层 Canvas emissiveMap 提供。"
NEW_MAT_EVIDENCE = (
    "头灯发光内芯为均匀 emissive（光导表面）；EX-08 3 枚圆形 LED 点阵由 "
    "headlamp-led-dot-{1,2,3}-{l,r} 几何件承担，集成层 Canvas（createHeadlampLedTexture）"
    "现为纯竖向光导贴图（暗底 + 全高亮带）并对 6 枚点阵做 UV 重映射落入亮带。"
)
OLD_DOT_NOTE_KEY = "需集成层 remapUVToRegion 到白色圆区"
NEW_DOT_NOTE = (
    "EX-08：A1/A8 前脸——大灯内侧 3 枚圆形灯珠，上二下一三角点阵；lamp-head 自发光内芯。"
    "UV 已由集成层 remapUVToRegion 落入 createHeadlampLedTexture 光导亮带"
    "（纯白柔边圆面，随 setHeadlights 联动）。"
)


def main():
    with open(SPEC_PATH, encoding="utf-8") as f:
        spec = json.load(f)
    n_mat = n_strip = n_dot = 0
    for m in spec["materials"]:
        if m["id"] == "lamp-head":
            ev = m["textureless"]["evidence"]
            assert OLD_MAT_EVIDENCE in ev, f"unexpected lamp-head evidence: {ev}"
            m["textureless"]["evidence"] = [NEW_MAT_EVIDENCE]
            n_mat += 1
    for c in spec["componentTree"]:
        if c["id"] in ("headlamp-led-l", "headlamp-led-r"):
            side = "l" if c["id"].endswith("-l") else "r"
            sgn = 1 if side == "l" else -1
            old = c.get("notes", "")
            assert "点阵贴图（集成层 createHeadlampLedTexture）叠加于灯带表面" in old, old
            c["notes"] = old.replace(
                "点阵贴图（集成层 createHeadlampLedTexture）叠加于灯带表面",
                "光导贴图（集成层 createHeadlampLedTexture：暗底 + 全高亮带）叠加于灯带表面；"
                "3 枚点阵由 headlamp-led-dot-* 几何件承担",
            )
            n_strip += 1
        if c["id"].startswith("headlamp-led-dot-"):
            for lf in c.get("localFeatures", []):
                note = lf.get("note", "")
                if OLD_DOT_NOTE_KEY in note:
                    lf["note"] = NEW_DOT_NOTE
                    n_dot += 1
    assert n_mat == 1 and n_strip == 2 and n_dot == 6, (n_mat, n_strip, n_dot)
    with open(SPEC_PATH, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"synced: material evidence x{n_mat}, strip notes x{n_strip}, dot localFeatures x{n_dot}")


if __name__ == "__main__":
    main()
