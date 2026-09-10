# PrintMyDoc

Shop operating system for Indian Xerox / print shops.

**Stack:** Next.js · Node.js (Express) · MySQL 8 · Prisma · Socket.IO

## What works in this MVP

- Merchant register / login
- Shop QR customer page (`/s/{slug}`)
- File upload + print options + live price quote
- Mock UPI payment (Razorpay-ready)
- Merchant dashboard: live orders, approve, complete
- Pricing editor
- Windows agent API + local agent simulator
- Printer sync / enable-disable

## Quick start

### 1. MySQL

```bash
brew services start mysql
mysql -u root -e "CREATE DATABASE IF NOT EXISTS inkdesk CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

### 2. Install & migrate

```bash
cd inkdesk
npm install
cd apps/api && npx prisma db push && npm run db:seed
```

### 3. Run

Terminal A (API):

```bash
cd apps/api && npm run dev
```

Terminal B (Web):

```bash
cd apps/web && npm run dev
```

- Web: http://localhost:3000  
- API: http://localhost:4000  

### Demo login

- Email: `demo@inkdesk.in`
- Password: `demo1234`
- Customer demo: http://localhost:3000/s/campus-xerox

### Printer agent

For a real counter PC, see `apps/agent/README.md` — it's a cross-platform desktop app that detects actual installed printers and prints real jobs.

For local testing without a real printer, there's a simulator that reports one fake printer. It needs real agent credentials first (generate them from the dashboard's Printers tab, or `POST /api/agents/register`), then:

```bash
cd apps/api && AGENT_DEVICE_KEY=<deviceKey> AGENT_TOKEN=<token> npx tsx scripts/agent-sim.ts
```

## Razorpay (optional)

In `apps/api/.env`:

```
PAYMENT_MODE=razorpay
RAZORPAY_KEY_ID=...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
```

## Project layout

```
inkdesk/
  apps/api     Node.js API + Prisma + agent endpoints
  apps/web     Next.js customer + merchant UI
```
# Printmydoc
