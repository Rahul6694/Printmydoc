import fs from "fs";
import path from "path";

export const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");

try {
  fs.mkdirSync(uploadDir, { recursive: true });
} catch (err) {
  console.error(
    `[uploadDir] Failed to create upload directory at "${uploadDir}". File uploads will fail until this is fixed (check UPLOAD_DIR / disk permissions).`,
    err
  );
}
