import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { env } from '../config/env';

const ACCEPTED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
]);

/**
 * Build a multer uploader that writes to `<uploadDir>/<subdir>` with a unique,
 * collision-proof filename. Returns the multer instance and the absolute dir.
 */
export function createUploader(subdir: string) {
  const dir = path.resolve(env.uploadDir, subdir);
  fs.mkdirSync(dir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  });

  const upload = multer({
    storage,
    // Price-list PDFs can be large (tens of MB), so allow up to 60MB.
    limits: { fileSize: 60 * 1024 * 1024, files: 20 },
    fileFilter: (_req, file, cb) => {
      if (ACCEPTED_MIME.has(file.mimetype)) return cb(null, true);
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    },
  });

  return { upload, dir };
}

// Job-work document uploads.
export const { upload: jobworkUpload, dir: jobworkUploadDir } = createUploader('jobwork');

// Product-category document uploads.
export const { upload: productUpload, dir: productUploadDir } = createUploader('products');
