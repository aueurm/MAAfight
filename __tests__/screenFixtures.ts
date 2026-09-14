import * as fs from "fs";
import * as path from "path";
import { gunzipSync } from "zlib";

// White-title masks cropped from saved Official-client screenshots; no player data is retained.
export function titleFixture(name: string, background = 8): Buffer {
  const frame = Buffer.alloc(1280 * 720 * 3, background);
  const crop = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures", `${name}-title.bgr.gz`)));
  for (let y = 0; y < 171; y++) {
    crop.copy(frame, ((y + 270) * 1280 + 50) * 3, y * 431 * 3, (y + 1) * 431 * 3);
  }
  return frame;
}
