# Kit images

The jersey shown in the **Kit** section on the home page and on `kit.html`.

| File | Purpose |
|------|---------|
| `kit_front.webp` / `kit_back.webp` | What modern browsers actually load (~95 KB each) |
| `kit_front.jpg` / `kit_back.jpg` | Fallback for browsers without WebP (~200 KB each) |
| `kit_front.png` / `kit_back.png` | Full-quality source renders — **not** served to visitors |

## Replacing the kit
1. Drop the new renders in here as `kit_front.png` and `kit_back.png` (1200×960, 5:4).
2. Regenerate the web versions:

```bash
python -c "from PIL import Image; [ (lambda im: (im.save(f'assets/kit/{n}.jpg','JPEG',quality=90,optimize=True,progressive=True,subsampling=0), im.save(f'assets/kit/{n}.webp','WEBP',quality=88,method=6)))(Image.open(f'assets/kit/{n}.png').convert('RGB')) for n in ('kit_front','kit_back') ]"
```

3. Commit & push — Vercel redeploys and the new kit is live.

The card keeps a 5:4 aspect ratio, so renders in other proportions get letterboxed
rather than cropped.
