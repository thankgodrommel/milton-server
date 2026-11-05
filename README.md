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

## Staff attendance APIs

All endpoints require a bearer token. Staff can generate a two-minute personal QR with
`GET /api/staff-attendance/qr` (`{ "qrData": "..." }`). Admins, accountants, and principals
can register it with `POST /api/staff-attendance/scan` (`{ "qrData": "..." }`); signed
staff ID-card tokens are accepted as well. The response is `{ "record": ..., "scanType": ... }`,
where `scanType` is `time_in`, `time_out`, or `duplicate`.

`GET /api/staff-attendance/records?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&staffId=...`
returns `{ "records": [...] }`; staff can only query their own records.
`GET /api/staff-attendance/requests` lists the caller's requests for staff and all requests for
authorized administrators. Staff submit future-date requests using
`POST /api/staff-attendance/requests` with `{ "startDate", "endDate", "reason" }`.
Admins, accountants, and principals review them using
`PATCH /api/staff-attendance/requests/:id` with `{ "status": "approved"|"declined" }`.
Approved dates create excused attendance rows without overwriting an existing check-in.

Attendance dates use `SCHOOL_TIME_ZONE` (default `Africa/Lagos`); scan timestamps are stored
as server-generated UTC instants. Configure the timezone consistently across application
instances. Date ranges are inclusive and limited to 366 days.

Staff attendance uses dedicated `StaffAttendance` and `StaffAttendanceRequest` Prisma models,
leaving the existing student `Attendance` API unchanged. This repository does not currently
track Prisma migration history; apply the schema using `npm run db:generate` followed by
`npm run db:push` against the target database before deploying the routes.
