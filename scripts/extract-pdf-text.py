import re
import sys

import pdfplumber


def clean(text):
    text = re.sub(r"[ \t]+", " ", text or "")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


try:
    chunks = []
    with pdfplumber.open(sys.argv[1]) as pdf:
        for page in pdf.pages:
            chunks.append(page.extract_text() or "")
    print(clean("\n\n".join(chunks)))
except Exception:
    raise SystemExit(0)
