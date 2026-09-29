import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { corsMiddleware } from "./middleware/cors.js";
import authRoutes from "./routes/auth.js";
import entityRoutes from "./routes/entities.js";
import sendVerificationEmailRoute from "./routes/functions/sendVerificationEmail.js";
import sendAdmissionOfferEmailRoute from "./routes/functions/sendAdmissionOfferEmail.js";
import handleAdmissionResponseRoute from "./routes/functions/handleAdmissionResponse.js";
import logsRoute from "./routes/logs.js";
import integrationsRoutes from "./routes/integrations.js";
import resultsRoutes from "./routes/results.js";
import cbtRoutes from "./routes/cbt.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(corsMiddleware);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Static file uploads serving
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/cbt", cbtRoutes);
app.use("/api/results", resultsRoutes);
app.use("/api/entities", entityRoutes);
app.use("/api/integrations", integrationsRoutes);
app.use("/api", integrationsRoutes); // Alias for /api/upload & /api/email/send
app.use("/api/functions/sendVerificationEmail", sendVerificationEmailRoute);
app.use("/api/functions/sendAdmissionOfferEmail", sendAdmissionOfferEmailRoute);
app.use("/api/functions/handleAdmissionResponse", handleAdmissionResponseRoute);
app.use("/api/logs", logsRoute);

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// 404 handler for API routes
app.use("/api/*", (req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

// Global error handling middleware (handles Multer errors, payload too large, etc.)
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      error: "File size exceeds the maximum allowed limit of 15MB. Please choose a smaller file.",
      max_size_mb: 15,
    });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({
      error: "Request entity is too large. Please upload smaller files or data.",
    });
  }
  console.error("[Unhandled Error]", err);
  res.status(err.status || 500).json({
    error: err.message || "An unexpected server error occurred.",
  });
});

app.listen(PORT, () => {
  console.log(
    `🚀 Milton College Portal Backend running on http://localhost:${PORT}`,
  );
});

export default app;
