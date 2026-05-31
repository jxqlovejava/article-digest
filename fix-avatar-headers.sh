#!/bin/sh
# Fix articles where the header image is actually an avatar (small file size)
ARTICLES_DIR="/app/data/articles"
IMAGES_DIR="/app/data/images"

for f in "$ARTICLES_DIR"/*.html; do
  [ -f "$f" ] || continue
  base=$(basename "$f" .html)

  # Check if this file has a header-img
  if ! grep -q 'class="header-img"' "$f" 2>/dev/null; then
    continue
  fi

  # Find img0 and check size
  for img in "$IMAGES_DIR/${base}_img0".*; do
    [ -f "$img" ] || continue
    size=$(stat -c%s "$img" 2>/dev/null)
    if [ -n "$size" ] && [ "$size" -lt 10000 ]; then
      echo "FIXING: $base (img0 = $size bytes, looks like avatar)"
      # Remove the header-img line
      sed -i '/<img src="[^"]*" alt="头图" class="header-img" \/>/d' "$f"
      # Remove the img0 file
      rm -f "$img"
    else
      echo "OK: $base (img0 = $size bytes)"
    fi
    break
  done
done

echo "Done."
