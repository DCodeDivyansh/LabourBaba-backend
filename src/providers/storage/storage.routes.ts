import express from "express";
import { storageController } from "./storage.controller";

const router = express.Router();

/**
 * Route for serving signed downloads of private documents.
 * Requires valid HMAC signature and unexpired timestamp in query string.
 */
router.get("/download/:key", storageController.downloadObject);

/**
 * Route for handling presigned uploads of private documents.
 * Requires valid HMAC signature and unexpired timestamp in query string.
 */
router.put("/upload/:key", storageController.uploadObject);

export default router;
