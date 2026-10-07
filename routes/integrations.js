import { Router } from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { upload, MAX_FILE_SIZE_MB, MAX_FILE_SIZE_BYTES } from "../middleware/upload.js";
import { authenticate, authenticateOptional } from "../middleware/auth.js";
import prisma from "../config/prisma.js";
import { getCloudinary, uploadBufferToCloudinary } from "../services/cloudinary.js";
import { sendEmail } from "../services/email.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");

const router = Router();

/**
 * Multer wrapper that returns clear JSON errors for size limits and disallowed file types
 */
const handleMulterUpload = (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          error: `File size exceeds the maximum allowed limit of ${MAX_FILE_SIZE_MB}MB. Please choose a smaller file.`,
          max_size_mb: MAX_FILE_SIZE_MB,
        });
      }
      return res.status(400).json({
        error: err.message || "Failed to process upload. Please check file type and size.",
      });
    }
    next();
  });
};

/**
 * Helper to get the base URL for local file hosting fallback
 */
function getBaseUrl(req) {
  const host = req.get("host");
  const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
  return `${protocol}://${host}`;
}

function getCloudinaryAssetDetails(fileUrl) {
  let url;
  try {
    url = new URL(fileUrl);
  } catch {
    return null;
  }

  if (url.hostname !== "res.cloudinary.com") return null;

  const segments = url.pathname.split("/");
  const resourceType = segments[2];
  const deliveryType = segments[3];
  if (!["image", "raw", "video"].includes(resourceType) ||
      !["upload", "private", "authenticated"].includes(deliveryType)) {
    throw new Error("Unsupported Cloudinary attachment URL.");
  }

  const versionIndex = segments.findIndex((segment, index) =>
    index > 3 && /^v\d+$/.test(segment)
  );
  if (versionIndex < 0 || versionIndex === segments.length - 1) {
    throw new Error("Could not parse the Cloudinary attachment URL.");
  }

  let publicId;
  try {
    publicId = decodeURIComponent(segments.slice(versionIndex + 1).join("/"));
  } catch {
    throw new Error("Could not parse the Cloudinary attachment URL.");
  }
  let format;
  if (resourceType === "image") {
    const extensionIndex = publicId.lastIndexOf(".");
    if (extensionIndex > publicId.lastIndexOf("/")) {
      format = publicId.slice(extensionIndex + 1);
      publicId = publicId.slice(0, extensionIndex);
    }
  }

  return { publicId, resourceType, deliveryType, format };
}

router.get("/lesson-notes/:id/attachment", authenticate, async (req, res) => {
  try {
    const roles = [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
      .map((role) => String(role || "").toLowerCase());
    if (!roles.includes("student")) {
      return res.status(403).json({ error: "Student access is required." });
    }

    const student = await prisma.student.findFirst({
      where: {
        OR: [
          { id: req.user.profile_id || req.user.id },
          { admission_number: req.user.admission_number || req.user.username },
        ],
      },
    });
    if (!student) return res.status(403).json({ error: "Student profile not found." });

    const note = await prisma.lessonNote.findUnique({ where: { id: req.params.id } });
    if (!note || note.status !== "Published" ||
        note.class.trim().toLowerCase() !== student.current_class.trim().toLowerCase()) {
      return res.status(404).json({ error: "Lesson note attachment not found." });
    }
    if (!note.attachment_url) {
      return res.status(404).json({ error: "This lesson note has no attachment." });
    }

    const asset = getCloudinaryAssetDetails(note.attachment_url);
    if (!asset) return res.json({ file_url: note.attachment_url });

    const cloudinary = getCloudinary();
    if (!cloudinary) {
      return res.status(503).json({ error: "Attachment delivery is temporarily unavailable." });
    }

    const fileUrl = cloudinary.utils.private_download_url(asset.publicId, asset.format || "", {
      resource_type: asset.resourceType,
      type: asset.deliveryType,
      expires_at: Math.floor(Date.now() / 1000) + 5 * 60,
    });
    return res.json({ file_url: fileUrl });
  } catch (err) {
    console.error("[LessonNote attachment]", err);
    return res.status(500).json({ error: "Failed to prepare lesson note attachment." });
  }
});

/**
 * POST /api/integrations/Core/UploadFile (and /api/upload)
 * Handles file uploads via Cloudinary (primary) with local disk fallback.
 */
router.post(
  ["/Core/UploadFile", "/upload"],
  authenticateOptional,
  handleMulterUpload,
  async (req, res) => {
    try {
      let buffer = null;
      let originalname = "upload.bin";
      let mimetype = "application/octet-stream";

      // 1. Check for multipart file from multer memoryStorage
      if (req.file) {
        buffer = req.file.buffer;
        originalname = req.file.originalname;
        mimetype = req.file.mimetype;
      } else if (req.body && req.body.file) {
        // 2. Check for base64 encoded data URI
        const fileData = req.body.file;
        if (typeof fileData === "string" && fileData.startsWith("data:")) {
          const matches = fileData.match(/^data:([A-Za-z0-9+/]+);base64,(.+)$/);
          if (matches) {
            mimetype = matches[1];
            buffer = Buffer.from(matches[2], "base64");
            originalname = `upload_${Date.now()}.${mimetype.split("/")[1] || "bin"}`;
          }
        }
      }

      if (!buffer) {
        return res.status(400).json({ error: "No file provided. Please upload a file." });
      }

      // Check buffer size for base64 uploads
      if (buffer.length > MAX_FILE_SIZE_BYTES) {
        return res.status(400).json({
          error: `File size exceeds the maximum allowed limit of ${MAX_FILE_SIZE_MB}MB. Please choose a smaller file.`,
          max_size_mb: MAX_FILE_SIZE_MB,
        });
      }

      // Check if Cloudinary is configured
      const cloudinary = getCloudinary();
      if (cloudinary) {
        console.log(`[Upload] Uploading "${originalname}" (${mimetype}) to Cloudinary...`);
        const folder = mimetype.startsWith("image/") ? "milton_college/images" : "milton_college/documents";
        const result = await uploadBufferToCloudinary(buffer, {
          folder,
          resource_type: "auto",
          type: "upload",
          access_mode: "public",
        });

        console.log(`[Upload] Cloudinary upload successful: ${result.secure_url}`);
        return res.json({
          file_url: result.secure_url,
          url: result.secure_url,
          public_id: result.public_id,
          format: result.format,
          bytes: result.bytes,
        });
      }

      // Fallback: Save to local disk
      console.warn("[Upload] Cloudinary not configured. Saving to local disk fallback...");
      const subfolder = mimetype.startsWith("image/") ? "images" : "files";
      const destDir = path.join(UPLOADS_DIR, subfolder);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      const ext = path.extname(originalname) || `.${mimetype.split("/")[1] || "bin"}`;
      const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      const filePath = path.join(destDir, filename);

      fs.writeFileSync(filePath, buffer);

      const fileUrl = `${getBaseUrl(req)}/uploads/${subfolder}/${filename}`;
      console.log(`[Upload] Local disk upload successful: ${fileUrl}`);

      return res.json({
        file_url: fileUrl,
        url: fileUrl,
      });
    } catch (err) {
      console.error("[Upload] Error processing file upload:", err);
      return res.status(500).json({ error: err.message || "Failed to upload file" });
    }
  }
);

/**
 * POST /api/integrations/Core/SendEmail (and /api/email/send)
 * Generic email dispatch endpoint for school portals
 */
router.post(
  ["/Core/SendEmail", "/email/send"],
  authenticateOptional,
  async (req, res) => {
    const { to, subject, body, content, text, html, from } = req.body;

    if (!to || !subject) {
      return res.status(400).json({ error: "Missing required fields: 'to' and 'subject' are required." });
    }

    try {
      const emailText = body || content || text || "";
      const emailHtml = html || (emailText ? `<p>${emailText.replace(/\n/g, "<br>")}</p>` : undefined);

      await sendEmail({
        to,
        subject,
        text: emailText,
        html: emailHtml,
        from,
      });

      return res.json({
        success: true,
        message: "Email sent successfully",
      });
    } catch (err) {
      console.error("[SendEmail] Error sending email:", err);
      return res.status(500).json({ error: err.message || "Failed to send email" });
    }
  }
);

export default router;
