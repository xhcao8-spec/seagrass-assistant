"""Extract the existing Material Symbols glyph outlines; no icon redesign.

Optional regeneration: python -m pip install fonttools brotli
Then run python scripts/material-icons.py after pnpm install.
The generated TypeScript is committed, so normal builds do not need Python.
"""
import json
import re
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

root = Path(__file__).resolve().parent.parent
font = TTFont(root / "website/node_modules/material-symbols/material-symbols-outlined.woff2")
sources = [root / "website/src/App.vue", *sorted((root / "website/src/stitch").glob("*.html"))]
names = set()
for file in sources:
    text = file.read_text(encoding="utf-8")
    names.update(re.findall(r'material-symbols-outlined[^>]*>([a-z0-9_]+)<', text))
    names.update(re.findall(r'<SiteIcon name="([a-z0-9_]+)"', text))
result = {}
cmap = font.getBestCmap()
subtables = [s.ExtSubTable if hasattr(s, "ExtSubTable") else s
             for lookup in font["GSUB"].table.LookupList.Lookup for s in lookup.SubTable]
def resolve_glyph(name):
    sequence = [cmap[ord(c)] for c in name]
    for sub in subtables:
        for ligature in getattr(sub, "ligatures", {}).get(sequence[0], []):
            if ligature.Component == sequence[1:]:
                return ligature.LigGlyph
    return name

for filled in [0, 1]:
    glyphs = font.getGlyphSet(location={"FILL": filled, "wght": 400, "GRAD": 0, "opsz": 24})
    for name in sorted(names):
        glyph = resolve_glyph(name)
        if filled:
            for sub in subtables:
                glyph = getattr(sub, "mapping", {}).get(glyph, glyph)
        if glyph not in glyphs:
            raise ValueError(f"Missing original glyph: {name}")
        pen = SVGPathPen(glyphs)
        glyphs[glyph].draw(pen)
        result.setdefault(name, {})["filled" if filled else "outline"] = pen.getCommands()
output = "// Generated from material-symbols 0.47.0 (Apache-2.0); see THIRD-PARTY-NOTICES.md.\n"
output += "export default " + json.dumps(result, ensure_ascii=False, separators=(",", ":")) + ";\n"
(root / "website/src/material-icon-paths.ts").write_text(output, encoding="utf-8")
print(f"Extracted {len(result)} original icons, {len(output.encode('utf-8'))} bytes.")
