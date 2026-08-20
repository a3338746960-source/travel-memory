import sys
from PIL import Image, ImageOps

def compress(input_path, output_path, max_size=1000, quality=65):
    img = Image.open(input_path)
    # Apply EXIF orientation so the image displays correctly
    img = ImageOps.exif_transpose(img)
    img.thumbnail((max_size, max_size), Image.LANCZOS)
    img.save(output_path, 'JPEG', quality=quality, optimize=True)

if __name__ == '__main__':
    compress(sys.argv[1], sys.argv[2])
