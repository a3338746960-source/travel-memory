import json
import sys
from PIL import Image


def rational_to_float(value):
    if isinstance(value, tuple) and len(value) == 2:
        return value[0] / value[1]
    return float(value)


def dms_to_decimal(value, ref):
    degrees = rational_to_float(value[0])
    minutes = rational_to_float(value[1])
    seconds = rational_to_float(value[2])
    decimal = degrees + minutes / 60 + seconds / 3600
    return -decimal if ref in ("S", "W") else decimal


try:
    image = Image.open(sys.argv[1])
    exif = image.getexif()
    gps = exif.get_ifd(34853) if exif and 34853 in exif else {}
    if not gps or 1 not in gps or 2 not in gps or 3 not in gps or 4 not in gps:
        raise SystemExit(0)
    print(json.dumps({
        "lat": dms_to_decimal(gps[2], gps[1]),
        "lng": dms_to_decimal(gps[4], gps[3])
    }))
except Exception:
    raise SystemExit(0)
