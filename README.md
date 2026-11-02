# SabkaCode Manual UPI Payment Gateway

A starter project using HTML/EJS, CSS, browser JavaScript (minimal), Node.js/Express and SQLite.

## Included flow

1. Homepage lists digital resources with fixed prices stored in SQLite.
2. Buy now opens a checkout page.
3. Checkout generates a UPI QR containing the configured UPI ID, payee, currency and exact product amount.
4. Customer submits name, email, optional phone, UPI transaction ID/UTR and a payment screenshot.
5. Submission is stored as `pending` in SQLite.
6. Admin signs in, reviews the UTR and screenshot, and checks the actual credit in the bank/UPI account.
7. Admin verifies or rejects; the app emails the customer if SMTP is configured.

**Important:** This is a manual-verification UPI workflow, not an automatic payment confirmation integration. A screenshot or customer-entered UTR is not proof that money was received. Never release a paid resource until you independently confirm the credit in your merchant bank/UPI account. For true automatic confirmation, integrate a regulated payment provider (for example Razorpay/Cashfree/PhonePe PG) and verify signed webhooks on the server.

## Requirements

- Node.js 20+
- npm

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- Set `UPI_ID` to your actual merchant UPI ID.
- Set `UPI_PAYEE_NAME`.
- Set a long random `SESSION_SECRET`.
- Set `ADMIN_USERNAME`.
- Generate a bcrypt password hash:

```bash
node -e "require('bcryptjs').hash(process.argv[1], 12).then(console.log)" "Choose-A-Strong-Admin-Password"
```

Copy the printed hash into `ADMIN_PASSWORD_HASH`. Do not put a plain password in the environment file.

Configure SMTP values to send approval/rejection emails. For Gmail, use a Google App Password with 2-Step Verification; do not use your normal Gmail password.

Start:

```bash
npm start
```

Open `http://localhost:3000`. Admin: `http://localhost:3000/admin/login`.

## Change resources and prices

Example using SQLite command line (install sqlite3 CLI separately):

```sql
INSERT INTO products (name, description, amount_paise, active)
VALUES ('New PDF Bundle', 'Description here', 19900, 1);
```

Amounts are stored in paise: ₹199 = `19900`. To deactivate a product, set `active=0`. The sample products are inserted automatically on first start.

## Production checklist

- Deploy behind HTTPS; set `NODE_ENV=production`, `BASE_URL` and a strong `SESSION_SECRET`.
- Use a persistent disk/volume for `data/` and `uploads/`; do not deploy on ephemeral storage.
- Keep `.env`, database files and uploaded screenshots private; do not expose `uploads/` as static files.
- Back up the SQLite database and uploads.
- Add CSRF protection, admin audit logs, stronger validation, and a retention/deletion policy before public launch.
- Add a product-delivery mechanism after verified status if customers should receive a download/link. This starter only emails the verification status.
- Configure SMTP and test delivery. If SMTP is not configured, status changes still save, but email sending is logged as an error.
- Consider antivirus scanning for uploaded files and stricter content inspection.
- Do not use this starter as a substitute for a payment gateway's server-side payment verification.

## Data

SQLite database: `data/payments.sqlite`
Payment screenshots: `uploads/`
Admin sessions: `data/sessions.sqlite`

Never commit `.env`, `data/`, or real customer uploads to Git.
