require("dotenv").config();
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const QRCode = require("qrcode");
const nodemailer = require("nodemailer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DB_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new sqlite3.Database(path.join(DB_DIR, "payments.sqlite"));
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, description TEXT DEFAULT '', amount_paise INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT UNIQUE NOT NULL, product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL, amount_paise INTEGER NOT NULL,
    customer_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT DEFAULT '',
    transaction_id TEXT NOT NULL, screenshot_file TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    verified_at TEXT
  )`);
  db.get("SELECT COUNT(*) AS count FROM products", (err, row) => {
    if (!err && row.count === 0) {
      const stmt = db.prepare("INSERT INTO products (name, description, amount_paise) VALUES (?, ?, ?)");
      stmt.run("Premium Study Notes", "Example resource. Change this in the database or admin panel.", 9900);
      stmt.run("Previous Year Question Papers", "Example resource. Change this in the database or admin panel.", 14900);
      stmt.finalize();
    }
  });
});

app.set("view engine", "ejs");
app.set("views", path.join(ROOT, "views"));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));
app.use(session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: DB_DIR }),
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    cb(allowed.includes(file.mimetype) ? null : new Error("Upload JPG, PNG, or WEBP only."), allowed.includes(file.mimetype));
  }
});

function money(paise) { return (paise / 100).toFixed(2); }
function getProduct(id) {
  return new Promise((resolve, reject) => db.get("SELECT * FROM products WHERE id=? AND active=1", [id], (e, r) => e ? reject(e) : resolve(r)));
}
function mailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}
async function sendStatusEmail(payment, approved) {
  const transport = mailer();
  if (!transport) throw new Error("SMTP is not configured. Set SMTP variables in .env.");
  const subject = approved ? `Payment verified - ${payment.reference}` : `Payment update - ${payment.reference}`;
  const text = approved
    ? `Hello ${payment.customer_name},\n\nYour payment for ${payment.product_name} (₹${money(payment.amount_paise)}) has been verified.\nReference: ${payment.reference}\n\nThank you.`
    : `Hello ${payment.customer_name},\n\nWe could not verify your payment for ${payment.product_name}.\nReference: ${payment.reference}\nAdmin note: ${payment.admin_note || "Please contact support."}\n\nPlease contact support before making another payment.`;
  await transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: payment.email, subject, text });
}
function adminOnly(req, res, next) {
  if (!req.session.admin) return res.redirect("/admin/login");
  next();
}

app.get("/", (_req, res) => {
  db.all("SELECT * FROM products WHERE active=1 ORDER BY id DESC", (err, products) => {
    if (err) return res.status(500).send("Could not load products.");
    res.render("index", { products, money });
  });
});

app.get("/checkout/:id", async (req, res) => {
  try {
    const product = await getProduct(Number(req.params.id));
    if (!product) return res.status(404).send("Resource not found.");
    const upiId = process.env.UPI_ID || "";
    if (!upiId || upiId === "yourupi@bank") return res.status(503).send("Set your real UPI_ID in .env before accepting payments.");
    const amount = money(product.amount_paise);
    const upiUrl = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(process.env.UPI_PAYEE_NAME || "Merchant")}&am=${amount}&cu=INR&tn=${encodeURIComponent("Order " + product.id)}`;
    const qr = await QRCode.toDataURL(upiUrl, { errorCorrectionLevel: "M", margin: 2, width: 280 });
    res.render("checkout", { product, amount, qr });
  } catch (e) { console.error(e); res.status(500).send("Unable to start checkout."); }
});

app.post("/payments", limiter, upload.single("screenshot"), async (req, res) => {
  try {
    const { productId, customerName, email, phone, transactionId } = req.body;
    const product = await getProduct(Number(productId));
    if (!product) return res.status(400).send("Invalid resource.");
    if (!req.file) return res.status(400).send("Payment screenshot is required.");
    if (!customerName?.trim() || !email?.trim() || !transactionId?.trim()) {
      fs.unlinkSync(req.file.path);
      return res.status(400).send("Name, email and transaction ID are required.");
    }
    const reference = "SK" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString("hex").toUpperCase();
    db.run(`INSERT INTO payments
      (reference, product_id, product_name, amount_paise, customer_name, email, phone, transaction_id, screenshot_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [reference, product.id, product.name, product.amount_paise, customerName.trim(), email.trim(), (phone || "").trim(), transactionId.trim(), req.file.filename],
      function(err) {
        if (err) { console.error(err); return res.status(500).send("Could not save payment submission."); }
        res.render("submitted", { reference });
      });
  } catch (e) { console.error(e); res.status(500).send("Submission failed."); }
});

app.get("/admin/login", (_req, res) => res.render("login", { error: "" }));
app.post("/admin/login", limiter, async (req, res) => {
  const validUser = req.body.username === (process.env.ADMIN_USERNAME || "admin");
  const hash = process.env.ADMIN_PASSWORD_HASH || "";
  const validPass = hash ? await bcrypt.compare(req.body.password || "", hash) : false;
  if (!validUser || !validPass) return res.status(401).render("login", { error: "Invalid login. Configure ADMIN_PASSWORD_HASH in .env." });
  req.session.regenerate(err => {
    if (err) return res.status(500).send("Login error.");
    req.session.admin = true;
    res.redirect("/admin");
  });
});
app.post("/admin/logout", adminOnly, (req, res) => req.session.destroy(() => res.redirect("/admin/login")));

app.get("/admin", adminOnly, (_req, res) => {
  db.all("SELECT * FROM payments ORDER BY created_at DESC", (err, payments) => {
    if (err) return res.status(500).send("Could not load submissions.");
    res.render("admin", { payments, money });
  });
});
app.get("/admin/screenshot/:id", adminOnly, (req, res) => {
  db.get("SELECT screenshot_file FROM payments WHERE id=?", [req.params.id], (err, row) => {
    if (err || !row) return res.sendStatus(404);
    const file = path.join(UPLOAD_DIR, path.basename(row.screenshot_file));
    if (!fs.existsSync(file)) return res.sendStatus(404);
    res.sendFile(file);
  });
});
app.post("/admin/payment/:id/status", adminOnly, (req, res) => {
  const status = req.body.status;
  if (!["verified", "rejected"].includes(status)) return res.status(400).send("Invalid status.");
  db.get("SELECT * FROM payments WHERE id=?", [req.params.id], async (err, payment) => {
    if (err || !payment) return res.sendStatus(404);
    const note = (req.body.adminNote || "").slice(0, 500);
    db.run("UPDATE payments SET status=?, admin_note=?, verified_at=CURRENT_TIMESTAMP WHERE id=?",
      [status, note, payment.id], async updateErr => {
        if (updateErr) return res.status(500).send("Could not update status.");
        payment.status = status; payment.admin_note = note;
        try { await sendStatusEmail(payment, status === "verified"); }
        catch (mailErr) { console.error("Email error:", mailErr.message); }
        res.redirect("/admin");
      });
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).send(err.message || "Request error.");
});

app.listen(PORT, () => console.log(`SabkaCode payment app running at http://localhost:${PORT}`));
