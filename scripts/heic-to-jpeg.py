import sys
import pillow_heif
from PIL import Image, ImageOps

def convert(input_path, output_path, max_size=1600):
    heif = pillow_heif.open_heif(input_path)
    img = Image.frombytes(heif.mode, heif.size, heif.data)
    # Apply EXIF rotation
    img = ImageOps.exif_transpose(img)
    img.thumbnail((max_size, max_size), Image.LANCZOS)
    img.save(output_path, 'JPEG', quality=85, optimize=True)

if __name__ == '__main__':
    convert(sys.argv[1], sys.argv[2])
