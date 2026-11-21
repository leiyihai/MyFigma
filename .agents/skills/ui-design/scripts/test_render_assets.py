"""Run with: python .agents/skills/ui-design/scripts/test_render_assets.py"""

import base64
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

SCRIPT = Path(__file__).with_name("render_assets.py")
ICONS = ("like", "popularity", "people", "camera", "close", "back", "help", "plus", "check")


class AssetScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.assets = self.root / "assets"

    def run_cli(self, *args, ok=True):
        result = subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                                capture_output=True, encoding="utf-8", errors="replace")
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("base64,", result.stdout)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        return result

    def make_png(self, name, size=(16, 16), color="red"):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGBA", size, color).save(path)
        return path

    def test_generate_scenes_and_entire_icon_catalog(self):
        results = self.run_cli("generate", "--output-dir", self.assets,
                               "--scenes", "world", "landscape", "--size", "320x180",
                               "--icons", *ICONS)
        self.assertEqual(len(results), 2 + len(ICONS))
        for item in results:
            with Image.open(item["path"]) as image:
                self.assertEqual(image.format, "PNG")
                if Path(item["path"]).name.startswith("icon-"):
                    self.assertEqual(image.size, (64, 64))
                    self.assertEqual(image.mode, "RGBA")
                    self.assertEqual(image.getpixel((0, 0))[3], 0)
                    self.assertEqual(image.getchannel("A").getextrema(), (0, 255))
                else:
                    self.assertEqual(image.size, (320, 180))
                    self.assertEqual(image.getchannel("A").getextrema(), (255, 255))

    def test_icon_color_and_size(self):
        self.run_cli("generate", "--output-dir", self.assets, "--icons", "plus",
                     "--icon-size", "128", "--color", "#abcdef")
        with Image.open(self.assets / "icon-plus.png") as image:
            self.assertEqual(image.size, (128, 128))
            self.assertEqual(image.getpixel((64, 64)), (171, 205, 239, 255))

    def test_refuses_overwrite_unless_explicit(self):
        args = ("generate", "--output-dir", self.assets, "--icons", "camera")
        self.run_cli(*args)
        before = (self.assets / "icon-camera.png").read_bytes()
        self.run_cli(*args, ok=False)
        self.assertEqual((self.assets / "icon-camera.png").read_bytes(), before)
        self.run_cli(*args, "--force")
        self.assertEqual((self.assets / "icon-camera.png").read_bytes(), before)

    def test_invalid_inputs(self):
        for extra in [("--size", "0x720"), ("--size", "8192x8192"),
                      ("--icon-size", "99999"), ("--color", "invalid")]:
            self.run_cli("generate", "--output-dir", self.assets, "--icons", "plus", *extra, ok=False)
        self.run_cli("generate", "--output-dir", self.assets, ok=False)

    def test_compose_relative_layers_and_transparency(self):
        self.make_png("layers/red.png", (4, 4), (255, 0, 0, 128))
        spec = self.root / "layers.json"
        spec.write_text(json.dumps({"size": [20, 12], "background": "#0000ff",
                                    "layers": [{"path": "layers/red.png", "xy": [3, 2],
                                                "size": [8, 8], "fit": "cover"}]}))
        output = self.root / "composite.png"
        self.run_cli("compose", "--manifest", spec, "--output", output)
        with Image.open(output) as image:
            self.assertEqual(image.size, (20, 12))
            self.assertEqual(image.getpixel((0, 0)), (0, 0, 255, 255))
            self.assertEqual(image.getpixel((4, 4)), (128, 0, 127, 255))
        self.run_cli("compose", "--manifest", spec, "--output", output, ok=False)
        self.run_cli("compose", "--manifest", spec, "--output", self.root / "layers/red.png", "--force", ok=False)

    def test_embed_inline_assets_preserves_source(self):
        asset = self.make_png("assets/icon.png")
        source = self.root / "source.html"
        original = '<img src="asset://icon.png"><style>.x{background:url(asset://icon.png)}</style>'
        source.write_text(original, encoding="utf-8")
        output = self.root / "preview.html"
        result = self.run_cli("embed", "--html", source, "--asset-dir", self.assets, "--output", output)
        html = output.read_text(encoding="utf-8")
        self.assertEqual(result[0]["embedded_assets"], 1)
        self.assertNotIn("asset://", html)
        data = html.split("base64,", 1)[1].split('"', 1)[0]
        self.assertEqual(base64.b64decode(data), asset.read_bytes())
        with Image.open(io.BytesIO(base64.b64decode(data))) as image:
            self.assertEqual(image.size, (16, 16))
        self.assertEqual(source.read_text(encoding="utf-8"), original)
        self.run_cli("embed", "--html", source, "--asset-dir", self.assets, "--output", source,
                     "--force", ok=False)
        self.run_cli("embed", "--html", source, "--asset-dir", self.assets, "--output", output, ok=False)

    def test_embed_rejects_missing_or_escaping_assets(self):
        source = self.root / "input.html"
        self.assets.mkdir()
        self.make_png("outside.png")
        for reference in ("missing.png", "../outside.png"):
            source.write_text(f'<img src="asset://{reference}">')
            self.run_cli("embed", "--html", source, "--asset-dir", self.assets,
                         "--output", self.root / "output.html", ok=False)
            self.assertFalse((self.root / "output.html").exists())

    def test_embed_rejects_non_png_and_empty_references(self):
        self.assets.mkdir()
        Image.new("RGB", (8, 8)).save(self.assets / "fake.png", format="JPEG")
        source = self.root / "input.html"
        for html in ('<img src="asset://fake.png">', '<img src="asset://fake.jpg">', '<p>No assets</p>'):
            source.write_text(html)
            self.run_cli("embed", "--html", source, "--asset-dir", self.assets,
                         "--output", self.root / "output.html", ok=False)


if __name__ == "__main__":
    unittest.main()
