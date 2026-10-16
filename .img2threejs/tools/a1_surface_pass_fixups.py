# -*- coding: utf-8 -*-
"""a1_surface_pass_fixups.py — 修复 strict-quality 两类告警：
1) colorMaterialRecipe.materialClass 必须取自枚举（按既有合格组件口径映射）
2) 子组件补 attachment（parentSocket/localStart/localEnd/contactType/embedDepth/gapTolerance）
幂等：重复运行无副作用。
"""
import json
import os
import sys

SPEC_PATH = os.path.join(os.path.dirname(__file__), "..", "object-sculpt-spec.json")

# material id -> canonical materialClass（取自 spec 既有合格组件）
CLASS_OF = {
    "chrome": "metal",
    "matte-black": "plastic",
    "screen-ui": "glass",
    "crystal": "glass",
    "bronze-dark": "metal",
    "lamp-red": "plastic",
    "leather-warm": "fabric",
    "leather-dark": "fabric",
    "leather-ivory": "fabric",
    "carpet": "fabric",
    "wood": "wood",
    "curtain": "fabric",
    "headliner-suede": "fabric",
}


def attachment(socket, contact="flush", embed=0.004, gap=0.002, start=None, end=None):
    return {
        "parentSocket": socket,
        "localStart": list(start or [0, 0, 0]),
        "localEnd": list(end or [0, 0, 0]),
        "contactType": contact,
        "embedDepth": embed,
        "gapTolerance": gap,
    }


ATTACH = {
    "console-island-charge-tray": attachment("tunnel-front.top"),
    "charge-pad-r": attachment("tunnel-front.top", embed=0.002),
    "console-island-knob-base": attachment("tunnel-front.top", embed=0.006),
    "console-island-knob-ring": attachment("tunnel-front.top", embed=0.002),
    "seat-rear-l-screen": attachment("seat-rear-l-armrest.top", embed=0.002),
    "seat-rear-r-screen": attachment("seat-rear-r-armrest.top", embed=0.002),
    "seat-rear-l-plate": attachment("seat-rear-l-headrest.front", embed=0.001),
    "seat-rear-r-plate": attachment("seat-rear-r-headrest.front", embed=0.001),
    "seat-third-row": attachment("cabin-interior.floor", contact="butt", embed=0.002, gap=0.003),
    "seat-third-row-back": attachment("seat-third-row.rear-top", contact="butt", embed=0.002, gap=0.003),
    "seat-third-row-headrest": attachment("seat-third-row-back.front-top", contact="butt", embed=0.002, gap=0.003),
    "trunk-floor": attachment("cabin-interior.floor", embed=0.002),
    "trunk-sill": attachment("cabin-interior.floor", embed=0.004),
    "door-panel-fl-crystal": attachment("door-panel-fl.inner"),
    "door-panel-fr-crystal": attachment("door-panel-fr.inner"),
    "door-panel-rl-crystal": attachment("door-panel-rl.inner"),
    "door-panel-rr-crystal": attachment("door-panel-rr.inner"),
    "taillamp-bar-top-l": attachment("taillamp-l.face", embed=0.001),
    "taillamp-bar-bottom-l": attachment("taillamp-l.face", embed=0.001),
    "taillamp-bar-top-r": attachment("taillamp-r.face", embed=0.001),
    "taillamp-bar-bottom-r": attachment("taillamp-r.face", embed=0.001),
}


def main():
    with open(SPEC_PATH, encoding="utf-8") as f:
        spec = json.load(f)
    changed = 0
    for c in spec["componentTree"]:
        cid = c.get("id")
        if cid in ATTACH:
            c["attachment"] = ATTACH[cid]
            changed += 1
        recipe = c.get("colorMaterialRecipe")
        if recipe and (cid in ATTACH or cid == "charge-pad"):  # 仅修本波新增/修改组件
            want = CLASS_OF.get(c.get("material"))
            if want:
                recipe["materialClass"] = want
    with open(SPEC_PATH, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"patched {changed} components; OK")


if __name__ == "__main__":
    sys.exit(main())
