import express, { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

router.use(
  '/ui',
  express.static(publicDir, {
    index: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
  })
);

router.get(['/ui', '/ui/'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.sendFile(path.join(publicDir, 'index.html'));
});

export default router;
