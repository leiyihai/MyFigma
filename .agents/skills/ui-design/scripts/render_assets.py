#!/usr/bin/env python3
"""Generate lightweight grayscale PNG assets without building Figma scene layers."""

import argparse
import base64
import json
import re
import sys
from pathlib import Path

try:
    from PIL import Image, ImageColor, ImageDraw, ImageOps
except ImportError:
    raise SystemExit("Pillow is required. Ask permission before installing dependencies.")

SCENES = ("world", "landscape")
ICONS = ("like", "popularity", "people", "camera", "close", "back", "help", "plus", "check")
ASSET_REF = re.compile(r"asset://([^\s\"'<>\(\)]+\.png)", re.IGNORECASE)
MAX_PIXELS = 16_000_000


def size_value(value):
    if not re.fullmatch(r"[1-9]\d*x[1-9]\d*", value):
        raise argparse.ArgumentTypeError("Use WIDTHxHEIGHT, for example 1280x720")
    size = tuple(map(int, value.split("x")))
    try:
        validate_size(size)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error
    return size


def validate_size(size):
    if (not isinstance(size, (list, tuple)) or len(size) != 2
            or any(type(n) is not int or n < 1 or n > 8192 for n in size)
            or size[0] * size[1] > MAX_PIXELS):
        raise ValueError("Size must contain two positive integers, <=8192 per axis and <=16M pixels")
    return tuple(size)


def check_output(path, force):
    if path.exists() and not force:
        raise ValueError(f"Output exists; choose a new path or explicitly use --force: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)


def save_png(image, path, force):
    check_output(path, force)
    image.save(path, format="PNG")
    return {"path": str(path.resolve()), "width": image.width, "height": image.height}


def render_scene(name, size):
    image = Image.new("RGBA", size, "#cecece")
    draw = ImageDraw.Draw(image)
    w, h = size

    def polygon(points, color):
        draw.polygon([(round(x * w), round(y * h)) for x, y in points], fill=color)

    polygon([(0, .48), (.2, .25), (.4, .48), (.62, .22), (.82, .43), (1, .32), (1, 1), (0, 1)], "#b4b4b4")
    if name == "landscape":
        polygon([(0, .8), (.35, .5), (.62, .75), (1, .45), (1, 1), (0, 1)], "#989898")
    else:
        polygon([(.06, .65), (.5, .36), (.94, .65), (.5, .96)], "#aaaaaa")
        polygon([(.36, .49), (.51, .38), (.67, .49), (.51, .61)], "#e5e5e5")
        polygon([(.36, .49), (.51, .61), (.51, .79), (.36, .67)], "#bbbbbb")
        polygon([(.51, .61), (.67, .49), (.67, .67), (.51, .79)], "#909090")
        polygon([(.33, .49), (.51, .27), (.7, .49), (.51, .62)], "#777777")
        polygon([(.13, .55), (.18, .33), (.23, .55)], "#929292")
        polygon([(.76, .58), (.82, .3), (.88, .58)], "#969696")
    return image


def render_icon(name, size, color):
    # A fixed coordinate system keeps the catalog compact; supersample only icons.
    image = Image.new("RGBA", (256, 256))
    draw = ImageDraw.Draw(image)
    stroke = 15
    if name == "like":
        draw.polygon([(40, 110), (95, 110), (120, 45), (148, 45), (148, 100),
                      (215, 100), (195, 210), (95, 210), (95, 120), (40, 120)], fill=color)
        draw.rectangle((35, 110, 72, 210), fill=color)
    elif name == "popularity":
        draw.polygon([(135, 25), (185, 105), (195, 75), (222, 150),
                      (195, 210), (128, 235), (60, 205), (35, 145), (85, 80),
                      (88, 130), (125, 95)], fill=color)
    elif name == "people":
        draw.ellipse((65, 35, 135, 105), outline=color, width=stroke)
        draw.arc((30, 120, 175, 260), 180, 360, fill=color, width=stroke)
        draw.line([(30, 190), (30, 215), (175, 215), (175, 190)], fill=color, width=stroke)
        draw.arc((140, 45, 200, 105), 270, 90, fill=color, width=stroke)
        draw.arc((160, 125, 230, 240), 270, 360, fill=color, width=stroke)
    elif name == "camera":
        draw.rounded_rectangle((25, 75, 231, 211), radius=15, outline=color, width=stroke)
        draw.line([(70, 75), (90, 40), (166, 40), (186, 75)], fill=color, width=stroke)
        draw.ellipse((85, 100, 171, 186), outline=color, width=stroke)
    elif name in ("close", "plus", "check", "back"):
        points = {
            "close": [[(55, 55), (201, 201)], [(201, 55), (55, 201)]],
            "plus": [[(128, 40), (128, 216)], [(40, 128), (216, 128)]],
            "check": [[(40, 130), (100, 190), (215, 65)]],
            "back": [[(160, 40), (70, 128), (160, 216)]],
        }
        for line in points[name]:
            draw.line(line, fill=color, width=stroke, joint="curve")
    else:  # help: no font dependency
        draw.ellipse((25, 25, 231, 231), outline=color, width=stroke)
        draw.arc((85, 65, 165, 135), 180, 450, fill=color, width=stroke)
        draw.line([(125, 135), (125, 160)], fill=color, width=stroke)
        draw.ellipse((117, 184, 133, 200), fill=color)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def generate(args):
    if not args.scenes and not args.icons:
        raise ValueError("Choose at least one --scenes or --icons item")
    if not 8 <= args.icon_size <= 512:
        raise ValueError("--icon-size must be between 8 and 512")
    color = ImageColor.getcolor(args.color, "RGBA")
    jobs = [(f"scene-{name}.png", lambda n=name: render_scene(n, args.size))
            for name in dict.fromkeys(args.scenes)]
    jobs += [(f"icon-{name}.png", lambda n=name: render_icon(n, args.icon_size, color))
             for name in dict.fromkeys(args.icons)]
    for filename, _ in jobs:
        if (args.output_dir / filename).exists() and not args.force:
            raise ValueError(f"Output exists: {args.output_dir / filename}; use a new directory or --force")
    return [save_png(render(), args.output_dir / filename, args.force) for filename, render in jobs]


def compose(args):
    """Manifest: {size:[w,h], background:"#ccc", layers:[{path, xy:[x,y], size:[w,h], fit}]}"""
    spec = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
    image = Image.new("RGBA", validate_size(spec["size"]), spec.get("background", "#00000000"))
    target = args.output.resolve()
    for layer in spec.get("layers", []):
        source = (args.manifest.parent / layer["path"]).resolve()
        if source == target:
            raise ValueError("A composite output cannot overwrite one of its source images")
        xy = layer.get("xy", [0, 0])
        if len(xy) != 2 or any(type(n) is not int for n in xy):
            raise ValueError("Layer xy must contain two integers")
        with Image.open(source) as opened:
            validate_size(opened.size)
            asset = opened.convert("RGBA")
        if "size" in layer:
            size = validate_size(layer["size"])
            fit = layer.get("fit", "contain")
            if fit == "contain":
                asset = ImageOps.contain(asset, size, Image.Resampling.LANCZOS)
            elif fit == "cover":
                asset = ImageOps.fit(asset, size, Image.Resampling.LANCZOS)
            elif fit == "stretch":
                asset = asset.resize(size, Image.Resampling.LANCZOS)
            else:
                raise ValueError("Layer fit must be contain, cover or stretch")
        image.alpha_composite(asset, tuple(xy))
    return [save_png(image, args.output, args.force)]


def embed(args):
    if args.html.resolve() == args.output.resolve():
        raise ValueError("Use a separate output HTML path; the input is never edited in place")
    html = args.html.read_text(encoding="utf-8-sig")
    root = args.asset_dir.resolve()
    cache = {}

    def replace(match):
        source = (root / match[1]).resolve()
        if not source.is_relative_to(root):
            raise ValueError("Asset references must remain inside --asset-dir")
        if source not in cache:
            with Image.open(source) as opened:
                validate_size(opened.size)
                if opened.format != "PNG":
                    raise ValueError(f"Expected PNG: {source}")
                opened.load()
            cache[source] = "data:image/png;base64," + base64.b64encode(source.read_bytes()).decode("ascii")
        return cache[source]

    html = ASSET_REF.sub(replace, html)
    if "asset://" in html:
        raise ValueError("Unresolved asset:// reference; use a local PNG filename")
    if not cache:
        raise ValueError("No asset:// PNG references found")
    check_output(args.output, args.force)
    args.output.write_text(html, encoding="utf-8")
    return [{"path": str(args.output.resolve()), "embedded_assets": len(cache)}]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    gen = subparsers.add_parser("generate", help="Render fixed scene/icon templates into PNG files")
    gen.add_argument("--output-dir", type=Path, required=True)
    gen.add_argument("--scenes", choices=SCENES, nargs="+", default=[])
    gen.add_argument("--icons", choices=ICONS, nargs="+", default=[])
    gen.add_argument("--size", type=size_value, default=(1280, 720))
    gen.add_argument("--icon-size", type=int, default=64)
    gen.add_argument("--color", default="#666666", help="Icon foreground color")
    gen.set_defaults(run=generate)
    comp = subparsers.add_parser("compose", help="Composite local images using a small JSON manifest", description=compose.__doc__)
    comp.add_argument("--manifest", type=Path, required=True)
    comp.add_argument("--output", type=Path, required=True)
    comp.set_defaults(run=compose)
    inline = subparsers.add_parser("embed", help="Replace asset://name.png references without printing Base64")
    inline.add_argument("--html", type=Path, required=True)
    inline.add_argument("--asset-dir", type=Path, required=True)
    inline.add_argument("--output", type=Path, required=True)
    inline.set_defaults(run=embed)
    for command in (gen, comp, inline):
        command.add_argument("--force", action="store_true", help="Explicitly allow overwriting output files")
    args = parser.parse_args()
    try:
        results = args.run(args)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"Error: {error}\n")
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
