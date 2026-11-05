---
title: Milton College Portal Server
emoji: 🏫
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Milton College Portal Server

Backend API server for Milton College Portal built with Express.js and Prisma.

## ID card APIs

- `POST /api/id-cards/issue` — Admin/accountant only; signs a card token valid through the card's three-year expiry date.
- `GET /api/id-cards/verify?token=...` — Verifies a scanned card and returns only the card's public identity details. Expired tokens return `410`.
- `POST /api/id-cards/attendance` — Registers the signed card holder as present for the current day; repeat scans do not create another record.

Student and staff QR attendance is recorded in the existing `Attendance` table. No schema migration is required.
