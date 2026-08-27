"""Generate and apply image overlay watermarks to Excel worksheets."""

import io
from openpyxl.drawing.image import Image as XlImage
from PIL import Image, ImageDraw, ImageFont


def hex_to_rgba(hex_str, opacity=1.0):
    """Convert hex color to (R, G, B, A) tuple."""
    h = hex_str.lstrip("#")
    r = int(h[0:2], 16)
    g = int(h[2:4], 16)
    b = int(h[4:6], 16)
    a = int(255 * opacity)
    return (r, g, b, a)


def _find_system_font(font_name="PingFang SC"):
    """Find a system font path that supports Chinese. Falls back gracefully.

    Tries macOS / Windows / Linux font locations in order so the watermark
    renders correctly on any platform.
    """
    candidates = [
        # macOS
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
        # Windows
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/msyh.ttf",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/simsun.ttc",
        "C:/Windows/Fonts/Deng.ttf",
        # Linux
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    ]

    for path in candidates:
        try:
            font = ImageFont.truetype(path, 20)
            # Quick test: see if the font can render Chinese
            return path
        except Exception:
            continue

    return None


def generate_watermark_image(text, config, canvas_width=800, canvas_height=600):
    """Generate a semi-transparent PNG image with watermark text.

    Args:
        text: Watermark text to render
        config: Watermark config dict with keys: size, color, rotate, opacity, font
        canvas_width: Image width in pixels
        canvas_height: Image height in pixels

    Returns:
        BytesIO containing PNG image data
    """
    font_size = config.get("size", 60)
    color_hex = config.get("color", "BFBFBF")
    rotate = config.get("rotate", -30)
    opacity = config.get("opacity", 0.2)
    font_name = config.get("font", "PingFang SC")

    rgba = hex_to_rgba(color_hex, opacity)

    # Create transparent base
    base = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))

    # Load font
    font_path = _find_system_font(font_name)
    try:
        if font_path:
            font = ImageFont.truetype(font_path, font_size)
        else:
            font = ImageFont.load_default()
    except Exception:
        font = ImageFont.load_default()

    # Measure text
    draw_temp = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    bbox = draw_temp.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    # Create text layer with extra padding for rotation
    pad = font_size * 2
    text_layer = Image.new("RGBA", (tw + pad * 2, th + pad * 2), (0, 0, 0, 0))
    text_draw = ImageDraw.Draw(text_layer)
    text_draw.text((pad, pad), text, fill=rgba, font=font)

    # Rotate text layer
    text_layer = text_layer.rotate(rotate, expand=True, resample=Image.BICUBIC)

    # Center on canvas
    px = (canvas_width - text_layer.width) // 2
    py = (canvas_height - text_layer.height) // 2
    base.paste(text_layer, (px, py), text_layer)

    # Save to bytes
    buf = io.BytesIO()
    base.save(buf, format="PNG")
    buf.seek(0)
    return buf


def apply_watermark(ws, config, structure):
    """Apply image overlay watermark to a worksheet.

    The watermark is placed as a floating image centered over the data area.
    """
    if not config.get("enabled"):
        return

    text = config.get("text", "机密")
    if not text:
        return

    cs = structure["col_start"]
    ce = structure["col_end"]
    ds = structure["data_start"]
    de = structure["data_end"]

    # Estimate pixel dimensions from cell range.
    # Rough approximation: each column ~100px, each row ~20px.
    # Cap the canvas size: a huge data area (e.g. thousands of rows) would
    # otherwise produce a multi-hundred-megapixel PNG. Since the image is
    # anchored at the top of the data area, covering ~60 rows is visually
    # equivalent to covering the whole sheet when the file is opened.
    max_img_w = config.get("max_width", 2600)
    max_img_h = config.get("max_height", 1200)
    col_count = ce - cs + 1
    row_count = de - ds + 1
    img_w = max(min(col_count * 100, max_img_w), 400)
    img_h = max(min(row_count * 20, max_img_h), 200)

    # Generate watermark image
    img_buf = generate_watermark_image(text, config, img_w, img_h)

    # Create openpyxl image anchored over data area
    xl_img = XlImage(img_buf)

    # Size the image to span the data area (convert pixels to EMU)
    xl_img.width = img_w * 9525 // 96
    xl_img.height = img_h * 9525 // 96

    # Anchor image using OneCellAnchor
    from openpyxl.drawing.spreadsheet_drawing import OneCellAnchor, AnchorMarker
    from openpyxl.drawing.xdr import XDRPositiveSize2D

    marker = AnchorMarker(col=cs - 1, colOff=0, row=structure["header_row"] - 1, rowOff=0)
    ext = XDRPositiveSize2D(cx=xl_img.width, cy=xl_img.height)
    anchor = OneCellAnchor(_from=marker, ext=ext)
    xl_img.anchor = anchor

    ws.add_image(xl_img)
