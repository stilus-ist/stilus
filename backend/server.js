require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Pool, types } = require("pg");

// Keep PostgreSQL DATE values as YYYY-MM-DD strings so dates of birth never shift by timezone.
types.setTypeParser(1082, (value) => value);

const app = express();
const PORT = Number(process.env.PORT) || 5000;

const ADMIN_SESSION_DURATION = 8 * 60 * 60 * 1000;
const adminSessions = new Map();

const CUSTOMER_SESSION_DURATION = 30 * 24 * 60 * 60 * 1000;
const customerSessions = new Map();

const PASSWORD_RESET_TOKEN_DURATION = 60 * 60 * 1000;

// Product images must live on persistent storage in production (Render Persistent Disk).
// Set UPLOADS_DIR to the disk mount path on Render, e.g. /var/data/uploads.
// Locally, keep using ./uploads so development continues to work as before.
const uploadsDirectory = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(__dirname, "uploads");

const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");

const storeSettingsFilePath = path.join(
    __dirname,
    ".stilus_store_settings.json"
);

const defaultStoreSettings = {
    store_name: "STIŁUS",
    currency: "TL",
    standard_shipping: 150,
    express_shipping: 400,
    free_shipping_threshold: 5000,
    contact_email: "",
    contact_phone: "",
    maintenance_mode: false,
    international_shipping: 1500,
    banner_url: ""
};

function readStoreSettings() {
    try {
        if (!fs.existsSync(storeSettingsFilePath)) {
            return { ...defaultStoreSettings };
        }

        const parsed = JSON.parse(
            fs.readFileSync(storeSettingsFilePath, "utf8")
        );

        return {
            ...defaultStoreSettings,
            ...parsed,
            store_name: "STIŁUS"
        };
    } catch (error) {
        console.error("Store settings read error:", error);
        return { ...defaultStoreSettings };
    }
}

function writeStoreSettings(settings) {
    fs.writeFileSync(
        storeSettingsFilePath,
        JSON.stringify(settings, null, 2),
        "utf8"
    );
}


if (!fs.existsSync(uploadsDirectory)) {
    fs.mkdirSync(uploadsDirectory, {
        recursive: true
    });
}

app.use(express.json());

app.use(
    "/uploads",
    express.static(uploadsDirectory)
);

app.use((req, res, next) => {
    res.header(
        "Access-Control-Allow-Origin",
        "*"
    );

    res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization"
    );

    res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    );

    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }

    next();
});

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT)
});

async function ensureCoreStoreTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS products (
            id VARCHAR(40) PRIMARY KEY,
            category VARCHAR(120) NOT NULL,
            name VARCHAR(255) NOT NULL,
            price NUMERIC(14,2) NOT NULL DEFAULT 0,
            image TEXT NOT NULL,
            images JSONB NOT NULL DEFAULT '[]'::jsonb,
            stock JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS orders (
            id BIGSERIAL PRIMARY KEY,
            order_number VARCHAR(120) NOT NULL UNIQUE,
            customer_first_name VARCHAR(150) NOT NULL,
            customer_last_name VARCHAR(150) NOT NULL,
            customer_email VARCHAR(254) NOT NULL,
            customer_phone VARCHAR(60) NOT NULL,
            shipping_address TEXT NOT NULL,
            shipping_method VARCHAR(80) NOT NULL,
            subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
            shipping_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
            total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
            status VARCHAR(40) NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS order_items (
            id BIGSERIAL PRIMARY KEY,
            order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            product_id VARCHAR(40) NOT NULL,
            product_name VARCHAR(255) NOT NULL,
            size VARCHAR(80) NOT NULL,
            quantity INTEGER NOT NULL,
            unit_price NUMERIC(14,2) NOT NULL DEFAULT 0
        )
    `);
}

async function ensureProductImagesColumn() {
    await pool.query(`
        ALTER TABLE products
        ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb
    `);
}

async function ensureOrderMoneyColumns() {
    await pool.query(`
        ALTER TABLE orders
            ALTER COLUMN subtotal TYPE NUMERIC(14,2) USING subtotal::numeric,
            ALTER COLUMN shipping_cost TYPE NUMERIC(14,2) USING shipping_cost::numeric,
            ALTER COLUMN total_amount TYPE NUMERIC(14,2) USING total_amount::numeric
    `);

    await pool.query(`
        ALTER TABLE order_items
            ALTER COLUMN unit_price TYPE NUMERIC(14,2) USING unit_price::numeric
    `);
}


async function ensureDiscountTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS discount_codes (
            id BIGSERIAL PRIMARY KEY,
            code VARCHAR(80) NOT NULL,
            discount_type VARCHAR(40) NOT NULL DEFAULT 'percentage',
            value NUMERIC(14,2) NOT NULL DEFAULT 0,
            max_discount NUMERIC(14,2),
            min_order_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
            applies_to VARCHAR(30) NOT NULL DEFAULT 'all',
            product_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            category VARCHAR(80),
            buy_quantity INTEGER,
            get_quantity INTEGER,
            usage_limit INTEGER,
            per_customer_limit INTEGER,
            starts_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ,
            first_order_only BOOLEAN NOT NULL DEFAULT FALSE,
            customer_email VARCHAR(254),
            active BOOLEAN NOT NULL DEFAULT TRUE,
            usage_count INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS discount_codes_code_lower_unique
        ON discount_codes (LOWER(code))
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS coupon_redemptions (
            id BIGSERIAL PRIMARY KEY,
            coupon_id BIGINT NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
            customer_email VARCHAR(254) NOT NULL,
            order_id BIGINT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS sitewide_sale (
            id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            percentage NUMERIC(6,2) NOT NULL DEFAULT 0,
            starts_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ,
            active BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        INSERT INTO sitewide_sale (id)
        VALUES (1)
        ON CONFLICT (id) DO NOTHING
    `);

    await pool.query(`
        ALTER TABLE orders
            ADD COLUMN IF NOT EXISTS discount_code VARCHAR(80),
            ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0
    `);
}

function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

async function getActiveSitewideSale(db = pool) {
    const result = await db.query(`
        SELECT percentage, starts_at, expires_at, active
        FROM sitewide_sale
        WHERE id = 1
    `);

    const sale = result.rows[0];

    if (!sale || !sale.active) return null;

    const now = Date.now();
    const startsAt = sale.starts_at ? new Date(sale.starts_at).getTime() : null;
    const expiresAt = sale.expires_at ? new Date(sale.expires_at).getTime() : null;
    const percentage = Number(sale.percentage);

    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) return null;
    if (startsAt && now < startsAt) return null;
    if (expiresAt && now > expiresAt) return null;

    return {
        percentage,
        starts_at: sale.starts_at,
        expires_at: sale.expires_at,
        active: true
    };
}

function applySitewideSalePrice(price, sale) {
    const base = Number(price);
    if (!sale) return roundMoney(base);
    return roundMoney(base * (1 - Number(sale.percentage) / 100));
}

function couponAppliesToItem(coupon, item) {
    const appliesTo = String(coupon.applies_to || "all");

    if (appliesTo === "all") return true;

    if (appliesTo === "category") {
        return String(item.category || "") === String(coupon.category || "");
    }

    if (appliesTo === "products") {
        const ids = Array.isArray(coupon.product_ids) ? coupon.product_ids : [];
        return ids.map(String).includes(String(item.productId));
    }

    return false;
}

function calculateCouponDiscount(coupon, items, subtotal, shippingCost) {
    if (!coupon) {
        return {
            itemDiscount: 0,
            shippingDiscount: 0,
            totalDiscount: 0
        };
    }

    const minimum = Number(coupon.min_order_amount || 0);
    if (Number(subtotal) < minimum) {
        throw new Error(`Minimum order amount for this code is ${minimum} TL`);
    }

    const eligibleItems = items.filter((item) => couponAppliesToItem(coupon, item));
    const eligibleSubtotal = eligibleItems.reduce(
        (sum, item) => sum + Number(item.unitPrice) * Number(item.quantity),
        0
    );

    if (!eligibleItems.length && coupon.discount_type !== "free_shipping") {
        throw new Error("This discount code does not apply to the products in your cart");
    }

    let itemDiscount = 0;
    let shippingDiscount = 0;
    const value = Number(coupon.value || 0);

    if (coupon.discount_type === "percentage") {
        itemDiscount = eligibleSubtotal * (value / 100);
    } else if (coupon.discount_type === "fixed") {
        itemDiscount = Math.min(value, eligibleSubtotal);
    } else if (coupon.discount_type === "free_shipping") {
        shippingDiscount = Number(shippingCost) || 0;
    } else if (coupon.discount_type === "buy_x_get_y") {
        const buyQuantity = Number(coupon.buy_quantity || 0);
        const getQuantity = Number(coupon.get_quantity || 0);

        if (!Number.isInteger(buyQuantity) || !Number.isInteger(getQuantity) || buyQuantity <= 0 || getQuantity <= 0) {
            throw new Error("This Buy X Get Y code is not configured correctly");
        }

        const unitPrices = [];
        for (const item of eligibleItems) {
            for (let i = 0; i < Number(item.quantity); i += 1) {
                unitPrices.push(Number(item.unitPrice));
            }
        }

        unitPrices.sort((a, b) => a - b);
        const groupSize = buyQuantity + getQuantity;
        const freeUnits = Math.floor(unitPrices.length / groupSize) * getQuantity;
        itemDiscount = unitPrices.slice(0, freeUnits).reduce((sum, price) => sum + price, 0);
    } else {
        throw new Error("Unsupported discount code type");
    }

    const maxDiscount = coupon.max_discount === null || coupon.max_discount === undefined || coupon.max_discount === ""
        ? null
        : Number(coupon.max_discount);

    if (Number.isFinite(maxDiscount) && maxDiscount >= 0) {
        itemDiscount = Math.min(itemDiscount, maxDiscount);
    }

    itemDiscount = roundMoney(Math.max(0, Math.min(itemDiscount, Number(subtotal))));
    shippingDiscount = roundMoney(Math.max(0, Math.min(shippingDiscount, Number(shippingCost))));

    return {
        itemDiscount,
        shippingDiscount,
        totalDiscount: roundMoney(itemDiscount + shippingDiscount)
    };
}

async function getUsableCoupon(db, code, customerEmail = "") {
    const normalizedCode = String(code || "").trim();

    if (!normalizedCode) return null;

    const result = await db.query(
        `
        SELECT *
        FROM discount_codes
        WHERE LOWER(code) = LOWER($1)
        ${db === pool ? "" : "FOR UPDATE"}
        `,
        [normalizedCode]
    );

    const coupon = result.rows[0];

    if (!coupon || !coupon.active) {
        throw new Error("Invalid or inactive discount code");
    }

    const now = Date.now();
    if (coupon.starts_at && now < new Date(coupon.starts_at).getTime()) {
        throw new Error("This discount code is not active yet");
    }
    if (coupon.expires_at && now > new Date(coupon.expires_at).getTime()) {
        throw new Error("This discount code has expired");
    }

    if (coupon.usage_limit !== null && Number(coupon.usage_count || 0) >= Number(coupon.usage_limit)) {
        throw new Error("This discount code has reached its usage limit");
    }

    const email = String(customerEmail || "").trim().toLowerCase();

    if (coupon.customer_email && String(coupon.customer_email).trim().toLowerCase() !== email) {
        throw new Error("This discount code is not available for this email");
    }

    if (coupon.per_customer_limit && email) {
        const countResult = await db.query(
            `
            SELECT COUNT(*)::int AS count
            FROM coupon_redemptions
            WHERE coupon_id = $1
              AND LOWER(customer_email) = LOWER($2)
            `,
            [coupon.id, email]
        );

        if (Number(countResult.rows[0]?.count || 0) >= Number(coupon.per_customer_limit)) {
            throw new Error("You have already used this discount code the maximum number of times");
        }
    }

    if (coupon.first_order_only && email) {
        const orderCountResult = await db.query(
            `
            SELECT COUNT(*)::int AS count
            FROM orders
            WHERE LOWER(customer_email) = LOWER($1)
              AND status <> 'cancelled'
            `,
            [email]
        );

        if (Number(orderCountResult.rows[0]?.count || 0) > 0) {
            throw new Error("This discount code is for first orders only");
        }
    }

    return coupon;
}

async function ensureCustomersTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS customers (
            id BIGSERIAL PRIMARY KEY,
            name VARCHAR(150) NOT NULL,
            last_name VARCHAR(150),
            email VARCHAR(254) NOT NULL UNIQUE,
            birth_date DATE,
            password_salt VARCHAR(128),
            password_hash VARCHAR(128),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    // Existing STIŁUS databases may already have a customers table from an older version.
    // Add only the account fields that are missing so registration works without deleting old customer data.
    await pool.query(`
        ALTER TABLE customers
            ADD COLUMN IF NOT EXISTS last_name VARCHAR(150),
            ADD COLUMN IF NOT EXISTS birth_date DATE,
            ADD COLUMN IF NOT EXISTS password_salt VARCHAR(128),
            ADD COLUMN IF NOT EXISTS password_hash VARCHAR(128),
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ADD COLUMN IF NOT EXISTS address1_label VARCHAR(80),
            ADD COLUMN IF NOT EXISTS address1 TEXT,
            ADD COLUMN IF NOT EXISTS address1_country VARCHAR(120),
            ADD COLUMN IF NOT EXISTS address1_phone VARCHAR(40),
            ADD COLUMN IF NOT EXISTS address2_label VARCHAR(80),
            ADD COLUMN IF NOT EXISTS address2 TEXT,
            ADD COLUMN IF NOT EXISTS address2_country VARCHAR(120),
            ADD COLUMN IF NOT EXISTS address2_phone VARCHAR(40)
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS customers_email_lower_unique
        ON customers (LOWER(email))
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id BIGSERIAL PRIMARY KEY,
            customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
            token_hash VARCHAR(128) NOT NULL UNIQUE,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS password_reset_tokens_customer_idx
        ON password_reset_tokens (customer_id)
    `);
}

const allowedImageTypes = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif"
]);

const storage = multer.diskStorage({
    destination: (req, file, callback) => {
        callback(null, uploadsDirectory);
    },

    filename: (req, file, callback) => {
        const extension = path
            .extname(file.originalname)
            .toLowerCase();

        const filename =
            `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`;

        callback(null, filename);
    }
});

const upload = multer({
    storage,

    limits: {
        fileSize: 10 * 1024 * 1024
    },

    fileFilter: (req, file, callback) => {
        if (!allowedImageTypes.has(file.mimetype)) {
            return callback(
                new Error(
                    "Only JPG, PNG, WEBP, and GIF images are allowed"
                )
            );
        }

        callback(null, true);
    }
});

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/\'/g, "&#39;");
}

async function sendResendEmail({ to, subject, text, html, replyTo }) {
    const resendApiKey = process.env.RESEND_API_KEY;

    if (!resendApiKey) {
        throw new Error("Email service is not configured");
    }

    const fromEmail =
        process.env.CONTACT_FROM_EMAIL ||
        "STIŁUS <noreply@stilusist.com>";

    const payload = {
        from: fromEmail,
        to: Array.isArray(to) ? to : [to],
        subject: String(subject || "").slice(0, 998),
        text: String(text || "")
    };

    if (html) payload.html = String(html);
    if (replyTo) payload.reply_to = String(replyTo);

    const response = await fetch(
        "https://api.resend.com/emails",
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${resendApiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        }
    );

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
        console.error("Resend email error:", result);
        throw new Error(
            result?.message ||
            result?.error ||
            "Failed to send email"
        );
    }

    return result;
}


function getOrderStatusLabel(status) {
    const labels = {
        pending: "Order Received",
        processing: "Order Processing",
        shipped: "Order Shipped",
        delivered: "Order Delivered",
        cancelled: "Order Cancelled"
    };

    return labels[String(status || "").toLowerCase()] || "Order Update";
}

function buildOrderEmail({
    orderNumber,
    customerFirstName,
    customerLastName,
    customerEmail,
    customerPhone,
    shippingAddress,
    shippingMethod,
    subtotal,
    shippingCost,
    totalAmount,
    status,
    items = [],
    isStatusUpdate = false
}) {
    const safeName = escapeHtml(customerFirstName || "Customer");
    const safeLastName = escapeHtml(customerLastName || "");
    const safeOrderNumber = escapeHtml(orderNumber || "");
    const safeStatus = escapeHtml(getOrderStatusLabel(status));
    const safeShippingAddress = escapeHtml(shippingAddress || "");
    const safeShippingMethod = escapeHtml(shippingMethod || "");
    const safePhone = escapeHtml(customerPhone || "");

    const rows = items.map((item) => {
        const name = escapeHtml(item.product_name ?? item.productName ?? "Product");
        const size = escapeHtml(item.size ?? "");
        const quantity = Number(item.quantity || 0);
        const unitPrice = Number(item.unit_price ?? item.unitPrice ?? 0);
        const lineTotal = quantity * unitPrice;

        return {
            name,
            size,
            quantity,
            unitPrice,
            lineTotal
        };
    });

    const itemsText = rows.map((item) =>
        `${item.name} | Size: ${item.size} | Qty: ${item.quantity} | ${item.unitPrice.toFixed(2)} TRY | ${item.lineTotal.toFixed(2)} TRY`
    ).join("\n");

    const text =
        `Hi ${customerFirstName || "Customer"},\n\n` +
        `${isStatusUpdate ? "There is an update to your STIŁUS order." : "Thank you for your STIŁUS order."}\n\n` +
        `Order: ${orderNumber}\n` +
        `Status: ${getOrderStatusLabel(status)}\n\n` +
        `Items:\n${itemsText}\n\n` +
        `Subtotal: ${Number(subtotal || 0).toFixed(2)} TRY\n` +
        `Shipping: ${Number(shippingCost || 0).toFixed(2)} TRY\n` +
        `Total: ${Number(totalAmount || 0).toFixed(2)} TRY\n\n` +
        `Shipping method: ${shippingMethod || ""}\n` +
        `Shipping address: ${shippingAddress || ""}\n` +
        `Phone: ${customerPhone || ""}\n\n` +
        `STIŁUS`;

    const itemRowsHtml = rows.map((item) => `
        <tr>
            <td style="padding:12px 8px;border-bottom:1px solid #eee;font-size:14px;">${item.name}</td>
            <td style="padding:12px 8px;border-bottom:1px solid #eee;font-size:14px;text-align:center;">${item.size}</td>
            <td style="padding:12px 8px;border-bottom:1px solid #eee;font-size:14px;text-align:center;">${item.quantity}</td>
            <td style="padding:12px 8px;border-bottom:1px solid #eee;font-size:14px;text-align:right;">${item.unitPrice.toFixed(2)} TRY</td>
            <td style="padding:12px 8px;border-bottom:1px solid #eee;font-size:14px;text-align:right;">${item.lineTotal.toFixed(2)} TRY</td>
        </tr>
    `).join("");

    const html = `
        <div style="margin:0;background:#f6f6f6;padding:40px 16px;font-family:Arial,Helvetica,sans-serif;color:#111;">
            <div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;padding:36px;">
                <div style="font-size:28px;font-weight:700;letter-spacing:2px;margin-bottom:28px;">STIŁUS</div>
                <h1 style="font-size:24px;margin:0 0 10px;">${safeStatus}</h1>
                <p style="font-size:15px;line-height:1.6;margin:0 0 24px;">
                    Hi ${safeName} ${safeLastName}, ${isStatusUpdate ? "there is an update to your order." : "thank you for your order."}
                </p>

                <div style="background:#f7f7f7;padding:16px;margin-bottom:24px;">
                    <div style="font-size:13px;color:#666;margin-bottom:5px;">Order number</div>
                    <div style="font-size:16px;font-weight:700;">${safeOrderNumber}</div>
                </div>

                <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
                    <thead>
                        <tr>
                            <th style="padding:10px 8px;border-bottom:2px solid #111;text-align:left;font-size:12px;">Product</th>
                            <th style="padding:10px 8px;border-bottom:2px solid #111;text-align:center;font-size:12px;">Size</th>
                            <th style="padding:10px 8px;border-bottom:2px solid #111;text-align:center;font-size:12px;">Qty</th>
                            <th style="padding:10px 8px;border-bottom:2px solid #111;text-align:right;font-size:12px;">Price</th>
                            <th style="padding:10px 8px;border-bottom:2px solid #111;text-align:right;font-size:12px;">Total</th>
                        </tr>
                    </thead>
                    <tbody>${itemRowsHtml}</tbody>
                </table>

                <div style="margin-left:auto;max-width:300px;font-size:14px;line-height:1.9;">
                    <div><span>Subtotal</span><span style="float:right;">${Number(subtotal || 0).toFixed(2)} TRY</span></div>
                    <div><span>Shipping</span><span style="float:right;">${Number(shippingCost || 0).toFixed(2)} TRY</span></div>
                    <div style="font-weight:700;font-size:16px;border-top:1px solid #111;margin-top:8px;padding-top:8px;"><span>Total</span><span style="float:right;">${Number(totalAmount || 0).toFixed(2)} TRY</span></div>
                </div>

                <div style="margin-top:30px;padding-top:20px;border-top:1px solid #eee;font-size:13px;line-height:1.7;color:#555;">
                    <strong style="color:#111;">Shipping</strong><br>
                    Method: ${safeShippingMethod}<br>
                    Address: ${safeShippingAddress}<br>
                    Phone: ${safePhone}
                </div>
            </div>
        </div>
    `;

    return { text, html };
}

async function sendOrderEmail(orderData) {
    try {
        const { text, html } = buildOrderEmail(orderData);
        await sendResendEmail({
            to: orderData.customerEmail,
            subject: `STIŁUS - ${getOrderStatusLabel(orderData.status)} - ${orderData.orderNumber}`,
            text,
            html
        });
        return true;
    } catch (error) {
        console.error("Order email error:", error);
        return false;
    }
}

function secureCompare(valueA, valueB) {
    const bufferA = Buffer.from(String(valueA));
    const bufferB = Buffer.from(String(valueB));

    if (bufferA.length !== bufferB.length) {
        return false;
    }

    return crypto.timingSafeEqual(
        bufferA,
        bufferB
    );
}

function createAdminSession() {
    const token =
        crypto.randomBytes(32).toString("hex");

    const expiresAt =
        Date.now() +
        ADMIN_SESSION_DURATION;

    adminSessions.set(
        token,
        expiresAt
    );

    return {
        token,
        expiresAt
    };
}

function cleanExpiredSessions() {
    const now = Date.now();

    for (
        const [
            token,
            expiresAt
        ] of adminSessions.entries()
    ) {
        if (expiresAt <= now) {
            adminSessions.delete(token);
        }
    }
}

function hashCustomerPassword(password, salt) {
    return crypto.scryptSync(
        String(password),
        salt,
        64
    ).toString("hex");
}

function hashPasswordResetToken(token) {
    return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function createCustomerSession(customerId) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + CUSTOMER_SESSION_DURATION;

    customerSessions.set(token, {
        customerId,
        expiresAt
    });

    return { token, expiresAt };
}

function cleanExpiredCustomerSessions() {
    const now = Date.now();

    for (const [token, session] of customerSessions.entries()) {
        if (!session || session.expiresAt <= now) {
            customerSessions.delete(token);
        }
    }
}

function requireCustomer(req, res, next) {
    cleanExpiredCustomerSessions();

    const authorization = String(req.headers.authorization || "");
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    const token = match ? match[1] : "";
    const session = token ? customerSessions.get(token) : null;

    if (!session) {
        return res.status(401).json({
            success: false,
            message: "Customer login required"
        });
    }

    req.customerId = session.customerId;
    req.customerToken = token;
    next();
}

function requireAdmin(req, res, next) {
    cleanExpiredSessions();

    const authorization =
        req.headers.authorization;

    if (
        !authorization ||
        !authorization.startsWith(
            "Bearer "
        )
    ) {
        return res.status(401).json({
            success: false,
            message:
                "Admin authentication required"
        });
    }

    const token =
        authorization
            .slice(7)
            .trim();

    const expiresAt =
        adminSessions.get(token);

    if (!expiresAt) {
        return res.status(401).json({
            success: false,
            message:
                "Invalid or expired admin session"
        });
    }

    if (expiresAt <= Date.now()) {
        adminSessions.delete(token);

        return res.status(401).json({
            success: false,
            message:
                "Admin session expired"
        });
    }

    req.adminToken = token;

    next();
}


/* =========================
   SERVER TEST
========================= */

app.get("/", (req, res) => {
    res.json({
        success: true,
        message:
            "STILUS Backend is running"
    });
});


/* =========================
   CONTACT FORM EMAIL
========================= */

app.post(
    "/api/contact",
    async (req, res) => {
        try {
            const name = String(
                req.body.name || ""
            ).trim();

            const email = String(
                req.body.email || ""
            ).trim();

            const message = String(
                req.body.message || ""
            ).trim();

            if (
                !name ||
                !email ||
                !message
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Name, email, and message are required"
                });
            }

            if (
                name.length > 100 ||
                email.length > 254 ||
                message.length > 5000
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Contact form data is too long"
                });
            }

            const emailPattern =
                /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

            if (!emailPattern.test(email)) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter a valid email address"
                });
            }

            const resendApiKey =
                process.env.RESEND_API_KEY;

            if (!resendApiKey) {
                console.error(
                    "RESEND_API_KEY is missing"
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Email service is not configured"
                });
            }

            const fromEmail =
                process.env.CONTACT_FROM_EMAIL ||
                "STIŁUS Website <noreply@stilusist.com>";

            const safeSubjectName =
                name.replace(/[\r\n]+/g, " ");

            const emailResponse =
                await fetch(
                    "https://api.resend.com/emails",
                    {
                        method: "POST",
                        headers: {
                            Authorization:
                                `Bearer ${resendApiKey}`,
                            "Content-Type":
                                "application/json"
                        },
                        body: JSON.stringify({
                            from: fromEmail,
                            to: [
                                "info@stilusist.com"
                            ],
                            reply_to: email,
                            subject:
                                `STIŁUS Contact Form - ${safeSubjectName}`,
                            text:
                                `New message from STIŁUS Contact Us\n\n` +
                                `Name: ${name}\n` +
                                `Email: ${email}\n\n` +
                                `Message:\n${message}`
                        })
                    }
                );

            const emailResult =
                await emailResponse
                    .json()
                    .catch(() => ({}));

            if (!emailResponse.ok) {
                console.error(
                    "Resend email error:",
                    emailResult
                );

                return res.status(502).json({
                    success: false,
                    message:
                        "Failed to send email"
                });
            }

            res.json({
                success: true,
                message:
                    "Message sent successfully"
            });
        } catch (error) {
            console.error(
                "Contact form error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Failed to send message"
            });
        }
    }
);


/* =========================
   ADMIN LOGIN
========================= */

app.post(
    "/api/admin/login",
    (req, res) => {
        const { username, email, password } =
            req.body;

        const loginName =
            String(username || email || "").trim();

        const configuredUsername =
            process.env.ADMIN_USERNAME ||
            process.env.ADMIN_EMAIL ||
            "";

        if (!loginName || !password) {
            return res.status(400).json({
                success: false,
                message: "Admin username and password are required"
            });
        }

        if (!configuredUsername || !process.env.ADMIN_PASSWORD) {
            return res.status(500).json({
                success: false,
                message: "Admin username/password are not configured"
            });
        }

        const usernameIsValid =
            secureCompare(loginName, configuredUsername);

        const passwordIsValid =
            secureCompare(password, process.env.ADMIN_PASSWORD);

        if (!usernameIsValid || !passwordIsValid) {
            return res.status(401).json({
                success: false,
                message: "Invalid admin username or password"
            });
        }

        if (
            !process.env.ADMIN_PASSWORD
        ) {
            return res.status(500).json({
                success: false,
                message:
                    "Admin password is not configured"
            });
        }

        if (!password) {
            return res.status(400).json({
                success: false,
                message:
                    "Admin password is required"
            });
        }

        const valid =
            secureCompare(
                password,
                process.env.ADMIN_PASSWORD
            );

        if (!valid) {
            return res.status(401).json({
                success: false,
                message:
                    "Invalid admin password"
            });
        }

        const session =
            createAdminSession();

        res.json({
            success: true,
            message:
                "Admin login successful",
            token:
                session.token,
            expiresAt:
                session.expiresAt
        });
    }
);


/* =========================
   ADMIN LOGOUT
========================= */

app.post(
    "/api/admin/logout",
    requireAdmin,
    (req, res) => {
        adminSessions.delete(
            req.adminToken
        );

        res.json({
            success: true,
            message:
                "Admin logout successful"
        });
    }
);


/* =========================
   ADMIN SESSION
========================= */

app.get(
    "/api/admin/session",
    requireAdmin,
    (req, res) => {
        const expiresAt =
            adminSessions.get(
                req.adminToken
            );

        res.json({
            success: true,
            authenticated: true,
            expiresAt
        });
    }
);


/* =========================
   IMAGE UPLOAD
========================= */

app.post(
    "/api/admin/upload-image",
    requireAdmin,
    (req, res, next) => {
        upload.single("image")(
            req,
            res,
            (error) => {
                if (error) {
                    return next(error);
                }

                next();
            }
        );
    },
    (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message:
                    "Image file is required"
            });
        }

        // Use the permanent public URL in production instead of a temporary
        // Cloudflare tunnel URL. PUBLIC_BASE_URL should be your Render service URL.
        const baseUrl = publicBaseUrl || `${req.protocol}://${req.get("host")}`;
        const imageUrl = `${baseUrl}/uploads/${encodeURIComponent(req.file.filename)}`;

        res.status(201).json({
            success: true,
            message:
                "Image uploaded successfully",
            filename:
                req.file.filename,
            imageUrl
        });
    }
);


/* =========================
   GET ALL PRODUCTS
========================= */

app.get(
    "/api/products",
    async (req, res) => {
        try {
            const result =
                await pool.query(`
                    SELECT
                        id,
                        category,
                        name,
                        price,
                        image,
                        images,
                        stock
                    FROM products
                    ORDER BY created_at ASC
                `);

            res.json({
                success: true,
                products:
                    result.rows
            });
        } catch (error) {
            console.error(
                "Products fetch error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Failed to fetch products"
            });
        }
    }
);


/* =========================
   GET ONE PRODUCT
========================= */

app.get(
    "/api/products/:id",
    async (req, res) => {
        try {
            const { id } =
                req.params;

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        category,
                        name,
                        price,
                        image,
                        images,
                        stock
                    FROM products
                    WHERE id = $1
                    `,
                    [id]
                );

            if (
                result.rows.length ===
                0
            ) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Product not found"
                });
            }

            res.json({
                success: true,
                product:
                    result.rows[0]
            });
        } catch (error) {
            console.error(
                "Product fetch error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Failed to fetch product"
            });
        }
    }
);


/* =========================
   CREATE PRODUCT
========================= */

app.post(
    "/api/products",
    requireAdmin,
    async (req, res) => {
        let client;

        try {
            const {
                category,
                name,
                price,
                image,
                images,
                stock
            } = req.body;

            if (
                !category ||
                !name ||
                price === undefined ||
                !image ||
                !stock ||
                typeof stock !==
                    "object" ||
                Array.isArray(stock)
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Missing or invalid product data"
                });
            }

            const cleanCategory =
                String(
                    category
                ).trim();

            const cleanName =
                String(name).trim();

            const cleanImage =
                String(image).trim();

            const cleanImages = Array.isArray(images)
                ? images.map(x => String(x).trim()).filter(Boolean).slice(0, 2)
                : [cleanImage];

            if (!cleanImages.length) cleanImages.push(cleanImage);

            const cleanPrice =
                Number(price);

            if (
                !cleanCategory ||
                !cleanName ||
                !cleanImage
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Product fields cannot be empty"
                });
            }

            if (
                !Number.isInteger(
                    cleanPrice
                ) ||
                cleanPrice < 0
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Product price must be a valid integer"
                });
            }

            const cleanStock = {};

            for (
                const [
                    size,
                    quantity
                ] of Object.entries(
                    stock
                )
            ) {
                const cleanSize =
                    String(size).trim();

                const cleanQuantity =
                    Number(quantity);

                if (!cleanSize) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Invalid product size"
                    });
                }

                if (
                    !Number.isInteger(
                        cleanQuantity
                    ) ||
                    cleanQuantity < 0
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            `Invalid stock quantity for size ${cleanSize}`
                    });
                }

                cleanStock[
                    cleanSize
                ] = cleanQuantity;
            }

            if (
                Object.keys(
                    cleanStock
                ).length === 0
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Product must have at least one size"
                });
            }

            client = await pool.connect();
            await client.query("BEGIN");

            // Serialize automatic product ID generation so two products
            // created at the same time cannot receive the same ID.
            await client.query(
                "SELECT pg_advisory_xact_lock(hashtext('stilus_product_id'))"
            );

            const idResult = await client.query(`
                SELECT COALESCE(
                    MAX(
                        CASE
                            WHEN id ~ '^STL-[0-9]+$'
                            THEN SUBSTRING(id FROM 5)::integer
                            ELSE 0
                        END
                    ),
                    0
                ) + 1 AS next_number
                FROM products
            `);

            const nextNumber = Number(
                idResult.rows[0].next_number
            );

            const cleanId =
                `STL-${String(nextNumber).padStart(4, "0")}`;

            const result =
                await client.query(
                    `
                    INSERT INTO products (
                        id,
                        category,
                        name,
                        price,
                        image,
                        images,
                        stock
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6::jsonb,
                        $7::jsonb
                    )
                    RETURNING
                        id,
                        category,
                        name,
                        price,
                        image,
                        images,
                        stock,        created_at
                    `,
                    [
                        cleanId,
                        cleanCategory,
                        cleanName,
                        cleanPrice,
                        cleanImage,
                        JSON.stringify(cleanImages),
                        JSON.stringify(cleanStock)
                    ]
                );

            await client.query("COMMIT");

            res.status(201).json({
                success: true,
                message:
                    "Product created successfully",
                product:
                    result.rows[0]
            });
        } catch (error) {
            if (client) {
                try {
                    await client.query("ROLLBACK");
                } catch (rollbackError) {
                    console.error(
                        "Product creation rollback error:",
                        rollbackError
                    );
                }
            }

            console.error(
                "Product creation error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Failed to create product"
            });
        } finally {
            if (client) {
                client.release();
            }
        }
    }
);


/* =========================
   UPDATE PRODUCT
========================= */

app.patch(
    "/api/products/:id",
    requireAdmin,
    async (req, res) => {
        try {
            const productId =
                String(
                    req.params.id
                ).trim();

            const {
                category,
                name,
                price,
                image,
                images,
                stock
            } = req.body;

            if (!productId) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Product ID is required"
                });
            }

            if (
                !category ||
                !name ||
                price === undefined ||
                !stock ||
                typeof stock !==
                    "object" ||
                Array.isArray(stock)
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Missing or invalid product data"
                });
            }

            const cleanCategory =
                String(
                    category
                ).trim();

            const cleanName =
                String(name).trim();

            const cleanPrice =
                Number(price);

            if (
                !cleanCategory ||
                !cleanName
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Product fields cannot be empty"
                });
            }

            if (
                !Number.isInteger(
                    cleanPrice
                ) ||
                cleanPrice < 0
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Product price must be a valid integer"
                });
            }

            const cleanStock = {};

            for (
                const [
                    size,
                    quantity
                ] of Object.entries(
                    stock
                )
            ) {
                const cleanSize =
                    String(size).trim();

                const cleanQuantity =
                    Number(quantity);

                if (!cleanSize) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Invalid product size"
                    });
                }

                if (
                    !Number.isInteger(
                        cleanQuantity
                    ) ||
                    cleanQuantity < 0
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            `Invalid quantity for size ${cleanSize}`
                    });
                }

                cleanStock[
                    cleanSize
                ] = cleanQuantity;
            }

            if (
                Object.keys(
                    cleanStock
                ).length === 0
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Enter at least one stock size"
                });
            }

            const existing =
                await pool.query(
                    `SELECT image, images FROM products WHERE id = $1`,
                    [productId]
                );

            if (!existing.rows.length) {
                return res.status(404).json({
                    success: false,
                    message: "Product not found"
                });
            }

            const currentImages = Array.isArray(existing.rows[0].images)
                ? existing.rows[0].images.filter(Boolean)
                : (existing.rows[0].image ? [existing.rows[0].image] : []);

            const cleanImages = Array.isArray(images)
                ? images.map(x => String(x).trim()).filter(Boolean).slice(0, 2)
                : currentImages.slice(0, 2);

            const cleanImage =
                String(image || cleanImages[0] || existing.rows[0].image || "").trim();

            if (!cleanImage) {
                return res.status(400).json({
                    success: false,
                    message: "Product must have Image 1"
                });
            }

            if (!cleanImages.length) cleanImages.push(cleanImage);

            const result =
                await pool.query(
                    `
                    UPDATE products
                    SET
                        category = $1,
                        name = $2,
                        price = $3,
                        image = $4,
                        images = $5::jsonb,
                        stock = $6::jsonb
                    WHERE id = $7
                    RETURNING
                        id,
                        category,
                        name,
                        price,
                        image,
                        images,
                        stock,
                        created_at
                    `,
                    [
                        cleanCategory,
                        cleanName,
                        cleanPrice,
                        cleanImage,
                        JSON.stringify(cleanImages),
                        JSON.stringify(cleanStock),
                        productId
                    ]
                );

            res.json({
                success: true,
                message:
                    "Product updated successfully",
                product:
                    result.rows[0]
            });
        } catch (error) {
            console.error(
                "Product update error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Failed to update product"
            });
        }
    }
);


/* =========================
   DELETE PRODUCT
========================= */

app.delete(
    "/api/products/:id",
    requireAdmin,
    async (req, res) => {
        let client;

        try {
            const productId = String(req.params.id || "").trim();

            if (!productId) {
                return res.status(400).json({
                    success: false,
                    message: "Product ID is required"
                });
            }

            client = await pool.connect();
            await client.query("BEGIN");

            const existing = await client.query(
                `
                SELECT id, name
                FROM products
                WHERE id = $1
                FOR UPDATE
                `,
                [productId]
            );

            if (existing.rows.length === 0) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    success: false,
                    message: "Product not found"
                });
            }

            // Keep existing order history, but remove the database link to this product
            // so the product row itself can be deleted completely.
            await client.query(
                `ALTER TABLE order_items ALTER COLUMN product_id DROP NOT NULL`
            );

            const foreignKeys = await client.query(
                `
                SELECT tc.constraint_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.constraint_schema = kcu.constraint_schema
                WHERE tc.constraint_type = 'FOREIGN KEY'
                  AND tc.table_schema = 'public'
                  AND tc.table_name = 'order_items'
                  AND kcu.column_name = 'product_id'
                `
            );

            for (const row of foreignKeys.rows) {
                const constraintName = String(row.constraint_name).replaceAll('"', '""');
                await client.query(
                    `ALTER TABLE order_items DROP CONSTRAINT IF EXISTS "${constraintName}"`
                );
            }

            await client.query(
                `
                ALTER TABLE order_items
                ADD CONSTRAINT order_items_product_id_fkey
                FOREIGN KEY (product_id)
                REFERENCES products(id)
                ON DELETE SET NULL
                `
            );

            const result = await client.query(
                `
                DELETE FROM products
                WHERE id = $1
                RETURNING id, name
                `,
                [productId]
            );

            await client.query("COMMIT");

            return res.json({
                success: true,
                message: "Product deleted successfully",
                product: result.rows[0]
            });
        } catch (error) {
            if (client) {
                try {
                    await client.query("ROLLBACK");
                } catch (rollbackError) {
                    console.error("Product delete rollback error:", rollbackError);
                }
            }

            console.error("Product delete error:", error);

            return res.status(500).json({
                success: false,
                message: error.message || "Failed to delete product"
            });
        } finally {
            if (client) {
                client.release();
            }
        }
    }
);


/* =========================
   GET ORDERS
========================= */

app.get(
    "/api/orders",
    requireAdmin,
    async (req, res) => {
        try {
            const ordersResult =
                await pool.query(`
                    SELECT
                        id,
                        order_number,
                        customer_first_name,
                        customer_last_name,
                        customer_email,
                        customer_phone,
                        shipping_address,
                        shipping_method,
                        subtotal,
                        shipping_cost,
                        total_amount,
                        status,
                        created_at
                    FROM orders
                    ORDER BY id DESC
                `);

            const itemsResult =
                await pool.query(`
                    SELECT
                        id,
                        order_id,
                        product_id,
                        product_name,
                        size,
                        quantity,
                        unit_price
                    FROM order_items
                    ORDER BY id ASC
                `);

            const orders =
                ordersResult.rows.map(
                    (order) => {
                        const items =
                            itemsResult.rows.filter(
                                (item) =>
                                    item.order_id ===
                                    order.id
                            );

                        return {
                            ...order,
                            items
                        };
                    }
                );

            res.json({
                success: true,
                orders
            });
        } catch (error) {
            console.error(
                "Orders fetch error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Failed to fetch orders"
            });
        }
    }
);


/* =========================
   PUBLIC ORDER STATUS
========================= */

app.get(
    "/api/order-status/:orderNumber",
    async (req, res) => {
        try {
            const orderNumber = String(
                req.params.orderNumber || ""
            ).trim();

            if (!orderNumber) {
                return res.status(400).json({
                    success: false,
                    message: "Order number is required"
                });
            }

            const result = await pool.query(
                `
                SELECT
                    order_number,
                    status
                FROM orders
                WHERE order_number = $1
                LIMIT 1
                `,
                [orderNumber]
            );

            if (!result.rows.length) {
                return res.status(404).json({
                    success: false,
                    message: "Order not found"
                });
            }

            return res.json({
                success: true,
                order: result.rows[0]
            });
        } catch (error) {
            console.error(
                "Public order status error:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Failed to check order status"
            });
        }
    }
);


/* =========================
   GET SINGLE ORDER
========================= */

app.get(
    "/api/orders/:orderNumber",
    requireAdmin,
    async (req, res) => {
        try {
            const {
                orderNumber
            } = req.params;

            const orderResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        order_number,
                        customer_first_name,
                        customer_last_name,
                        customer_email,
                        customer_phone,
                        shipping_address,
                        shipping_method,
                        subtotal,
                        shipping_cost,
                        total_amount,
                        status,
                        created_at
                    FROM orders
                    WHERE order_number = $1
                    `,
                    [orderNumber]
                );

            if (
                orderResult.rows.length ===
                0
            ) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Order not found"
                });
            }

            const order =
                orderResult.rows[0];

            const itemsResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        product_id,
                        product_name,
                        size,
                        quantity,
                        unit_price
                    FROM order_items
                    WHERE order_id = $1
                    ORDER BY id ASC
                    `,
                    [order.id]
                );

            res.json({
                success: true,
                order: {
                    ...order,
                    items:
                        itemsResult.rows
                }
            });
        } catch (error) {
            console.error(
                "Order fetch error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Failed to fetch order"
            });
        }
    }
);


/* =========================
   UPDATE ORDER STATUS
========================= */

app.patch(
    "/api/orders/:orderNumber/status",
    requireAdmin,
    async (req, res) => {
        let client;

        try {
            const {
                orderNumber
            } = req.params;

            const { status } =
                req.body;

            const allowedStatuses = [
                "pending",
                "processing",
                "shipped",
                "delivered",
                "cancelled"
            ];

            if (
                !status ||
                !allowedStatuses.includes(
                    status
                )
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid order status"
                });
            }

            client =
                await pool.connect();

            await client.query(
                "BEGIN"
            );

            const orderResult =
                await client.query(
                    `
                    SELECT
                        id,
                        order_number,
                        customer_first_name,
                        customer_last_name,
                        customer_email,
                        customer_phone,
                        shipping_address,
                        shipping_method,
                        subtotal,
                        shipping_cost,
                        total_amount,
                        status
                    FROM orders
                    WHERE order_number = $1
                    FOR UPDATE
                    `,
                    [orderNumber]
                );

            if (
                orderResult.rows.length ===
                0
            ) {
                await client.query(
                    "ROLLBACK"
                );

                return res.status(404).json({
                    success: false,
                    message:
                        "Order not found"
                });
            }

            const order =
                orderResult.rows[0];

            const previousStatus =
                order.status;

            if (
                previousStatus ===
                    "cancelled" &&
                status !== "cancelled"
            ) {
                await client.query(
                    "ROLLBACK"
                );

                return res.status(400).json({
                    success: false,
                    message:
                        "Cancelled orders cannot be reopened"
                });
            }

            if (
                previousStatus !==
                    "cancelled" &&
                status === "cancelled"
            ) {
                const itemsResult =
                    await client.query(
                        `
                        SELECT
                            product_id,
                            size,
                            quantity
                        FROM order_items
                        WHERE order_id = $1
                        `,
                        [order.id]
                    );

                for (
                    const item
                    of itemsResult.rows
                ) {
                    const productResult =
                        await client.query(
                            `
                            SELECT
                                id,
                                stock
                            FROM products
                            WHERE id = $1
                            FOR UPDATE
                            `,
                            [
                                item.product_id
                            ]
                        );

                    if (
                        productResult
                            .rows.length ===
                        0
                    ) {
                        throw new Error(
                            `Product not found: ${item.product_id}`
                        );
                    }

                    const product =
                        productResult
                            .rows[0];

                    const currentStock =
                        Number(
                            product.stock[
                                item.size
                            ] ?? 0
                        );

                    const restoredStock = {
                        ...product.stock,

                        [item.size]:
                            currentStock +
                            Number(
                                item.quantity
                            )
                    };

                    await client.query(
                        `
                        UPDATE products
                        SET stock = $1::jsonb
                        WHERE id = $2
                        `,
                        [
                            JSON.stringify(
                                restoredStock
                            ),
                            item.product_id
                        ]
                    );
                }
            }

            const updateResult =
                await client.query(
                    `
                    UPDATE orders
                    SET status = $1
                    WHERE id = $2
                    RETURNING
                        id,
                        order_number,
                        status
                    `,
                    [
                        status,
                        order.id
                    ]
                );

            const statusItemsResult =
                await client.query(
                    `
                    SELECT
                        product_name,
                        size,
                        quantity,
                        unit_price
                    FROM order_items
                    WHERE order_id = $1
                    ORDER BY id ASC
                    `,
                    [order.id]
                );

            await client.query(
                "COMMIT"
            );

            await sendOrderEmail({
                orderNumber: order.order_number,
                customerFirstName: order.customer_first_name,
                customerLastName: order.customer_last_name,
                customerEmail: order.customer_email,
                customerPhone: order.customer_phone,
                shippingAddress: order.shipping_address,
                shippingMethod: order.shipping_method,
                subtotal: order.subtotal,
                shippingCost: order.shipping_cost,
                totalAmount: order.total_amount,
                status,
                items: statusItemsResult.rows,
                isStatusUpdate: true
            });

            res.json({
                success: true,
                message:
                    "Order status updated successfully",
                order:
                    updateResult.rows[0]
            });
        } catch (error) {
            if (client) {
                try {
                    await client.query(
                        "ROLLBACK"
                    );
                } catch (
                    rollbackError
                ) {
                    console.error(
                        "Rollback error:",
                        rollbackError
                    );
                }
            }

            console.error(
                "Order status update error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    error.message ||
                    "Failed to update order status"
            });
        } finally {
            if (client) {
                client.release();
            }
        }
    }
);


/* =========================
   CUSTOMER ACCOUNTS
========================= */

app.post(
    "/api/customers/register",
    async (req, res) => {
        try {
            const name = String(req.body.name || "").trim();
            const lastName = String(req.body.lastName || "").trim();
            const email = String(req.body.email || "").trim().toLowerCase();
            const birthDate = String(req.body.birthDate || "").trim();
            const password = String(req.body.password || "");

            if (!name || !lastName || !email || !birthDate || !password) {
                return res.status(400).json({
                    success: false,
                    message: "First name, last name, email, date of birth, and password are required"
                });
            }

            if (password.length < 6) {
                return res.status(400).json({
                    success: false,
                    message: "Password must be at least 6 characters"
                });
            }

            const existing = await pool.query(
                "SELECT id FROM customers WHERE LOWER(email) = LOWER($1) LIMIT 1",
                [email]
            );

            if (existing.rows.length) {
                return res.status(409).json({
                    success: false,
                    message: "An account with this email already exists"
                });
            }

            const salt = crypto.randomBytes(16).toString("hex");
            const passwordHash = hashCustomerPassword(password, salt);

            const result = await pool.query(
                `
                INSERT INTO customers (
                    name,
                    last_name,
                    email,
                    birth_date,
                    password_salt,
                    password_hash
                )
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id, name, last_name, email, birth_date, created_at
                `,
                [name, lastName, email, birthDate, salt, passwordHash]
            );

            const customer = result.rows[0];
            const session = createCustomerSession(customer.id);

            return res.status(201).json({
                success: true,
                token: session.token,
                customer
            });
        } catch (error) {
            console.error("Customer registration error:", error);
            return res.status(500).json({
                success: false,
                message: error.message || "Failed to create account"
            });
        }
    }
);

app.post(
    "/api/customers/forgot-password",
    async (req, res) => {
        try {
            const email = String(req.body.email || "").trim().toLowerCase();

            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return res.status(400).json({
                    success: false,
                    message: "Please enter a valid email address"
                });
            }

            const genericResponse = {
                success: true,
                message: "If an account exists for this email, a password reset link has been sent."
            };

            const customerResult = await pool.query(
                `SELECT id, name, email FROM customers WHERE LOWER(email) = LOWER($1) LIMIT 1`,
                [email]
            );

            if (!customerResult.rows.length) {
                return res.json(genericResponse);
            }

            const customer = customerResult.rows[0];
            const rawToken = crypto.randomBytes(32).toString("hex");
            const tokenHash = hashPasswordResetToken(rawToken);
            const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_DURATION);

            await pool.query(
                `UPDATE password_reset_tokens SET used_at = NOW() WHERE customer_id = $1 AND used_at IS NULL`,
                [customer.id]
            );

            await pool.query(
                `INSERT INTO password_reset_tokens (customer_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
                [customer.id, tokenHash, expiresAt]
            );

            const resetBaseUrl = String(process.env.FRONTEND_URL || "https://stilusist.com").replace(/\/$/, "");
            const resetUrl = `${resetBaseUrl}/?reset_token=${encodeURIComponent(rawToken)}`;

            const safeName = escapeHtml(customer.name || "");
            const safeResetUrl = escapeHtml(resetUrl);

            const text =
                `Hi ${customer.name || ""},\n\n` +
                `We received a request to reset your STIŁUS password.\n\n` +
                `Use this link to create a new password:\n${resetUrl}\n\n` +
                `This link expires in 1 hour and can only be used once.\n\n` +
                `If you did not request a password reset, you can ignore this email.\n\n` +
                `STIŁUS`;

            const html = `
                <div style="margin:0;background:#f6f6f6;padding:40px 16px;font-family:Arial,Helvetica,sans-serif;color:#111;">
                    <div style="max-width:640px;margin:0 auto;background:#fff;padding:40px;border:1px solid #e5e5e5;">
                        <div style="font-size:28px;font-weight:700;letter-spacing:2px;margin-bottom:28px;">STIŁUS</div>
                        <h1 style="font-size:24px;margin:0 0 12px;">Reset your password</h1>
                        <p style="font-size:15px;line-height:1.6;margin:0 0 24px;">Hi ${safeName}, we received a request to reset your STIŁUS password.</p>
                        <a href="${safeResetUrl}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:14px 22px;font-size:14px;font-weight:700;">Create New Password</a>
                        <p style="font-size:13px;line-height:1.6;color:#666;margin:24px 0 0;">This link expires in 1 hour and can only be used once. If you did not request a password reset, you can ignore this email.</p>
                    </div>
                </div>
            `;

            await sendResendEmail({
                to: customer.email,
                subject: "STIŁUS - Reset Your Password",
                text,
                html
            });

            return res.json(genericResponse);
        } catch (error) {
            console.error("Forgot password error:", error);
            return res.status(500).json({
                success: false,
                message: "Unable to process password reset request"
            });
        }
    }
);

app.post(
    "/api/customers/reset-password",
    async (req, res) => {
        let client;

        try {
            const token = String(req.body.token || "").trim();
            const newPassword = String(req.body.newPassword || "");

            if (!token || !newPassword) {
                return res.status(400).json({ success: false, message: "Reset token and new password are required" });
            }

            if (newPassword.length < 6) {
                return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
            }

            const tokenHash = hashPasswordResetToken(token);
            client = await pool.connect();
            await client.query("BEGIN");

            const tokenResult = await client.query(
                `SELECT id, customer_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1 LIMIT 1 FOR UPDATE`,
                [tokenHash]
            );

            if (!tokenResult.rows.length) {
                await client.query("ROLLBACK");
                return res.status(400).json({ success: false, message: "This password reset link is invalid or has expired" });
            }

            const resetToken = tokenResult.rows[0];

            if (resetToken.used_at || new Date(resetToken.expires_at).getTime() <= Date.now()) {
                await client.query("ROLLBACK");
                return res.status(400).json({ success: false, message: "This password reset link is invalid or has expired" });
            }

            const salt = crypto.randomBytes(16).toString("hex");
            const passwordHash = hashCustomerPassword(newPassword, salt);

            const customerResult = await client.query(
                `UPDATE customers SET password_salt = $1, password_hash = $2 WHERE id = $3 RETURNING id`,
                [salt, passwordHash, resetToken.customer_id]
            );

            if (!customerResult.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({ success: false, message: "Customer account not found" });
            }

            await client.query(
                `UPDATE password_reset_tokens SET used_at = NOW() WHERE customer_id = $1 AND used_at IS NULL`,
                [resetToken.customer_id]
            );

            await client.query("COMMIT");

            for (const [sessionToken, session] of customerSessions.entries()) {
                if (session && session.customerId === resetToken.customer_id) {
                    customerSessions.delete(sessionToken);
                }
            }

            return res.json({ success: true, message: "Password reset successfully" });
        } catch (error) {
            if (client) {
                try { await client.query("ROLLBACK"); } catch (rollbackError) { console.error("Password reset rollback error:", rollbackError); }
            }
            console.error("Reset password error:", error);
            return res.status(500).json({ success: false, message: "Unable to reset password" });
        } finally {
            if (client) client.release();
        }
    }
);

app.post(
    "/api/customers/login",
    async (req, res) => {
        try {
            const email = String(req.body.email || "").trim().toLowerCase();
            const password = String(req.body.password || "");

            if (!email || !password) {
                return res.status(400).json({
                    success: false,
                    message: "Email and password are required"
                });
            }

            const result = await pool.query(
                `
                SELECT
                    id,
                    name,
                    last_name,
                    email,
                    birth_date,
                    created_at,
                    password_salt,
                    password_hash
                FROM customers
                WHERE LOWER(email) = LOWER($1)
                LIMIT 1
                `,
                [email]
            );

            if (!result.rows.length) {
                return res.status(401).json({
                    success: false,
                    message: "Invalid email or password"
                });
            }

            const customer = result.rows[0];
            const suppliedHash = hashCustomerPassword(password, customer.password_salt);

            if (!secureCompare(suppliedHash, customer.password_hash)) {
                return res.status(401).json({
                    success: false,
                    message: "Invalid email or password"
                });
            }

            const session = createCustomerSession(customer.id);

            return res.json({
                success: true,
                token: session.token,
                customer: {
                    id: customer.id,
                    name: customer.name,
                    last_name: customer.last_name,
                    email: customer.email,
                    birth_date: customer.birth_date,
                    created_at: customer.created_at
                }
            });
        } catch (error) {
            console.error("Customer login error:", error);
            return res.status(500).json({
                success: false,
                message: "Failed to log in"
            });
        }
    }
);

app.get(
    "/api/customers/me",
    requireCustomer,
    async (req, res) => {
        try {
            const result = await pool.query(
                `
                SELECT
                    id,
                    name,
                    last_name,
                    email,
                    birth_date,
                    created_at,
                    address1_label,
                    address1,
                    address1_country,
                    address1_phone,
                    address2_label,
                    address2,
                    address2_country,
                    address2_phone
                FROM customers
                WHERE id = $1
                LIMIT 1
                `,
                [req.customerId]
            );

            if (!result.rows.length) {
                customerSessions.delete(req.customerToken);
                return res.status(401).json({
                    success: false,
                    message: "Customer account not found"
                });
            }

            return res.json({
                success: true,
                customer: result.rows[0]
            });
        } catch (error) {
            console.error("Customer profile error:", error);
            return res.status(500).json({
                success: false,
                message: "Failed to load customer account"
            });
        }
    }
);

app.patch(
    "/api/customers/me",
    requireCustomer,
    async (req, res) => {
        try {
            const name = String(req.body?.name || "").trim();
            const lastName = String(req.body?.lastName || "").trim();
            const birthDate = String(req.body?.birthDate || "").trim();

            if (!name || !lastName || !birthDate) {
                return res.status(400).json({
                    success: false,
                    message: "First name, last name and date of birth are required"
                });
            }

            const result = await pool.query(
                `
                UPDATE customers
                SET name = $1, last_name = $2, birth_date = $3
                WHERE id = $4
                RETURNING id, name, last_name, email, birth_date, created_at
                `,
                [name, lastName, birthDate, req.customerId]
            );

            if (!result.rows.length) {
                return res.status(404).json({
                    success: false,
                    message: "Customer account not found"
                });
            }

            return res.json({
                success: true,
                customer: result.rows[0]
            });
        } catch (error) {
            console.error("Customer account update error:", error);
            return res.status(500).json({
                success: false,
                message: "Failed to update customer account"
            });
        }
    }
);

app.patch(
    "/api/customers/me/addresses",
    requireCustomer,
    async (req, res) => {
        try {
            const clean = (value, maxLength) => {
                const text = String(value || "").trim();
                return text ? text.slice(0, maxLength) : null;
            };

            const address1Label = clean(req.body?.address1Label, 80);
            const address1 = clean(req.body?.address1, 1000);
            const address1Country = clean(req.body?.address1Country, 120);
            const address1Phone = clean(req.body?.address1Phone, 40);
            const address2Label = clean(req.body?.address2Label, 80);
            const address2 = clean(req.body?.address2, 1000);
            const address2Country = clean(req.body?.address2Country, 120);
            const address2Phone = clean(req.body?.address2Phone, 40);

            const result = await pool.query(
                `
                UPDATE customers
                SET
                    address1_label = $1,
                    address1 = $2,
                    address1_country = $3,
                    address1_phone = $4,
                    address2_label = $5,
                    address2 = $6,
                    address2_country = $7,
                    address2_phone = $8
                WHERE id = $9
                RETURNING
                    id,
                    name,
                    last_name,
                    email,
                    birth_date,
                    created_at,
                    address1_label,
                    address1,
                    address1_country,
                    address1_phone,
                    address2_label,
                    address2,
                    address2_country,
                    address2_phone
                `,
                [
                    address1Label,
                    address1,
                    address1Country,
                    address1Phone,
                    address2Label,
                    address2,
                    address2Country,
                    address2Phone,
                    req.customerId
                ]
            );

            if (!result.rows.length) {
                return res.status(404).json({
                    success: false,
                    message: "Customer account not found"
                });
            }

            return res.json({
                success: true,
                customer: result.rows[0]
            });
        } catch (error) {
            console.error("Customer addresses update error:", error);
            return res.status(500).json({
                success: false,
                message: "Failed to update saved addresses"
            });
        }
    }
);

app.get(
    "/api/customers/me/orders",
    requireCustomer,
    async (req, res) => {
        try {
            const customerResult = await pool.query(
                "SELECT email FROM customers WHERE id = $1 LIMIT 1",
                [req.customerId]
            );

            if (!customerResult.rows.length) {
                return res.status(404).json({
                    success: false,
                    message: "Customer account not found"
                });
            }

            const ordersResult = await pool.query(
                `
                SELECT
                    o.id,
                    o.order_number,
                    o.total_amount,
                    o.status,
                    o.created_at,
                    COALESCE(
                        json_agg(
                            json_build_object(
                                'product_name', oi.product_name,
                                'size', oi.size,
                                'quantity', oi.quantity,
                                'unit_price', oi.unit_price
                            ) ORDER BY oi.id
                        ) FILTER (WHERE oi.id IS NOT NULL),      '[]'::json
                    ) AS items
                FROM orders o
                LEFT JOIN order_items oi ON oi.order_id = o.id
                WHERE LOWER(o.customer_email) = LOWER($1)
                GROUP BY o.id
                ORDER BY o.created_at DESC
                `,
                [customerResult.rows[0].email]
            );

            return res.json({
                success: true,
                orders: ordersResult.rows
            });
        } catch (error) {
            console.error("Customer orders error:", error);
            return res.status(500).json({
                success: false,
                message: "Failed to load customer orders"
            });
        }
    }
);

app.get(
    "/api/admin/customers",
    requireAdmin,
    async (req, res) => {
        try {
            const result = await pool.query(
                `
                SELECT
                    c.id,
                    c.name,
                    c.last_name,
                    c.email,
                    c.birth_date,
                    c.created_at
                FROM customers c
                ORDER BY c.created_at DESC
                `
            );

            return res.json({
                success: true,
                customers: result.rows
            });
        } catch (error) {
            console.error("Admin customers error:", error);
            return res.status(500).json({
                success: false,
                message: "Failed to fetch customers"
            });
        }
    }
);

app.post(
    "/api/admin/customers/email",
    requireAdmin,
    async (req, res) => {
        try {
            const subject = String(req.body.subject || "").trim();
            const message = String(req.body.message || "").trim();

            if (!subject || !message) {
                return res.status(400).json({
                    success: false,
                    message: "Subject and message are required"
                });
            }

            if (subject.length > 200 || message.length > 10000) {
                return res.status(400).json({
                    success: false,
                    message: "Email subject or message is too long"
                });
            }

            const resendApiKey = process.env.RESEND_API_KEY;

            if (!resendApiKey) {
                return res.status(500).json({
                    success: false,
                    message: "Email service is not configured"
                });
            }

            const customersResult = await pool.query(
                `
                SELECT DISTINCT LOWER(TRIM(email)) AS email
                FROM customers
                WHERE email IS NOT NULL
                  AND TRIM(email) <> ''
                ORDER BY email ASC
                `
            );

            const recipients = customersResult.rows
                .map((row) => row.email)
                .filter(Boolean);

            if (!recipients.length) {
                return res.status(400).json({
                    success: false,
                    message: "There are no registered customer emails"
                });
            }

            const fromEmail =
                process.env.MARKETING_FROM_EMAIL ||
                process.env.CONTACT_FROM_EMAIL ||
                "STIŁUS <noreply@stilusist.com>";

            let sentCount = 0;
            const failedRecipients = [];

            for (const recipient of recipients) {
                const emailResponse = await fetch(
                    "https://api.resend.com/emails",
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${resendApiKey}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            from: fromEmail,
                            to: [recipient],
                            subject,
                            text: message
                        })
                    }
                );

                const emailResult = await emailResponse
                    .json()
                    .catch(() => ({}));

                if (emailResponse.ok) {
                    sentCount += 1;
                } else {
                    failedRecipients.push(recipient);
                    console.error(
                        "Customer email send error:",
                        recipient,
                        emailResult
                    );
                }
            }

            if (sentCount === 0) {
                return res.status(502).json({
                    success: false,
                    message: "Failed to send the customer email"
                });
            }

            return res.json({
                success: true,
                sentCount,
                failedCount: failedRecipients.length
            });
        } catch (error) {
            console.error("Admin customer email error:", error);
            return res.status(500).json({
                success: false,
                message: "Failed to send customer email"
            });
        }
    }
);



/* =========================
   DISCOUNT CODES + SITEWIDE SALE
========================= */

app.get(
    "/api/admin/coupons",
    requireAdmin,
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT *
                FROM discount_codes
                ORDER BY created_at DESC, id DESC
            `);

            res.json({
                success: true,
                coupons: result.rows
            });
        } catch (error) {
            console.error("Load coupons error:", error);
            res.status(500).json({
                success: false,
                message: "Failed to load discount codes"
            });
        }
    }
);

app.post(
    "/api/admin/coupons",
    requireAdmin,
    async (req, res) => {
        try {
            const {
                code,
                discountType,
                value,
                maxDiscount,
                minOrderAmount,
                appliesTo,
                productIds,
                category,
                buyQuantity,
                getQuantity,
                usageLimit,
                perCustomerLimit,
                startsAt,
                expiresAt,
                firstOrderOnly,
                customerEmail,
                active
            } = req.body;

            const normalizedCode = String(code || "").trim().toUpperCase();
            const allowedTypes = new Set(["percentage", "fixed", "free_shipping", "buy_x_get_y"]);
            const allowedAppliesTo = new Set(["all", "products", "category"]);

            if (!normalizedCode) {
                return res.status(400).json({ success: false, message: "Discount code is required" });
            }

            if (!allowedTypes.has(String(discountType))) {
                return res.status(400).json({ success: false, message: "Invalid discount type" });
            }

            if (!allowedAppliesTo.has(String(appliesTo || "all"))) {
                return res.status(400).json({ success: false, message: "Invalid Applies To value" });
            }

            const result = await pool.query(
                `
                INSERT INTO discount_codes (
                    code, discount_type, value, max_discount, min_order_amount,
                    applies_to, product_ids, category, buy_quantity, get_quantity,
                    usage_limit, per_customer_limit, starts_at, expires_at,
                    first_order_only, customer_email, active
                )
                VALUES (
                    $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
                )
                RETURNING *
                `,
                [
                    normalizedCode,
                    discountType,
                    Number(value || 0),
                    maxDiscount === "" || maxDiscount === null || maxDiscount === undefined ? null : Number(maxDiscount),
                    Number(minOrderAmount || 0),
                    appliesTo || "all",
                    JSON.stringify(Array.isArray(productIds) ? productIds : []),
                    category || null,
                    buyQuantity === "" || buyQuantity === null || buyQuantity === undefined ? null : Number(buyQuantity),
                    getQuantity === "" || getQuantity === null || getQuantity === undefined ? null : Number(getQuantity),
                    usageLimit === "" || usageLimit === null || usageLimit === undefined ? null : Number(usageLimit),
                    perCustomerLimit === "" || perCustomerLimit === null || perCustomerLimit === undefined ? null : Number(perCustomerLimit),
                    startsAt || null,
                    expiresAt || null,
                    Boolean(firstOrderOnly),
                    String(customerEmail || "").trim() || null,
                    active !== false
                ]
            );

            res.status(201).json({ success: true, coupon: result.rows[0] });
        } catch (error) {
            console.error("Create coupon error:", error);
            if (error.code === "23505") {
                return res.status(409).json({ success: false, message: "This discount code already exists" });
            }
            res.status(500).json({ success: false, message: "Failed to create discount code" });
        }
    }
);

app.patch(
    "/api/admin/coupons/:id",
    requireAdmin,
    async (req, res) => {
        try {
            const {
                code,
                discountType,
                value,
                maxDiscount,
                minOrderAmount,
                appliesTo,
                productIds,
                category,
                buyQuantity,
                getQuantity,
                usageLimit,
                perCustomerLimit,
                startsAt,
                expiresAt,
                firstOrderOnly,
                customerEmail,
                active
            } = req.body;

            const normalizedCode = String(code || "").trim().toUpperCase();

            const result = await pool.query(
                `
                UPDATE discount_codes
                SET code=$1,
                    discount_type=$2,
                    value=$3,
                    max_discount=$4,
                    min_order_amount=$5,
                    applies_to=$6,
                    product_ids=$7::jsonb,
                    category=$8,
                    buy_quantity=$9,
                    get_quantity=$10,
                    usage_limit=$11,
                    per_customer_limit=$12,
                    starts_at=$13,
                    expires_at=$14,
                    first_order_only=$15,
                    customer_email=$16,
                    active=$17,
                    updated_at=NOW()
                WHERE id=$18
                RETURNING *
                `,
                [
                    normalizedCode,
                    discountType,
                    Number(value || 0),
                    maxDiscount === "" || maxDiscount === null || maxDiscount === undefined ? null : Number(maxDiscount),
                    Number(minOrderAmount || 0),
                    appliesTo || "all",
                    JSON.stringify(Array.isArray(productIds) ? productIds : []),
                    category || null,
                    buyQuantity === "" || buyQuantity === null || buyQuantity === undefined ? null : Number(buyQuantity),
                    getQuantity === "" || getQuantity === null || getQuantity === undefined ? null : Number(getQuantity),
                    usageLimit === "" || usageLimit === null || usageLimit === undefined ? null : Number(usageLimit),
                    perCustomerLimit === "" || perCustomerLimit === null || perCustomerLimit === undefined ? null : Number(perCustomerLimit),
                    startsAt || null,
                    expiresAt || null,
                    Boolean(firstOrderOnly),
                    String(customerEmail || "").trim() || null,
                    Boolean(active),
                    req.params.id
                ]
            );

            if (!result.rows.length) {
                return res.status(404).json({ success: false, message: "Discount code not found" });
            }

            res.json({ success: true, coupon: result.rows[0] });
        } catch (error) {
            console.error("Update coupon error:", error);
            if (error.code === "23505") {
                return res.status(409).json({ success: false, message: "This discount code already exists" });
            }
            res.status(500).json({ success: false, message: "Failed to update discount code" });
        }
    }
);

app.delete(
    "/api/admin/coupons/:id",
    requireAdmin,
    async (req, res) => {
        try {
            const result = await pool.query(
                "DELETE FROM discount_codes WHERE id=$1 RETURNING id",
                [req.params.id]
            );

            if (!result.rows.length) {
                return res.status(404).json({ success: false, message: "Discount code not found" });
            }

            res.json({ success: true });
        } catch (error) {
            console.error("Delete coupon error:", error);
            res.status(500).json({ success: false, message: "Failed to delete discount code" });
        }
    }
);

app.get(
    "/api/admin/sitewide-sale",
    requireAdmin,
    async (req, res) => {
        try {
            const result = await pool.query(
                "SELECT percentage, starts_at, expires_at, active, updated_at FROM sitewide_sale WHERE id=1"
            );
            res.json({ success: true, sale: result.rows[0] || null });
        } catch (error) {
            console.error("Load sitewide sale error:", error);
            res.status(500).json({ success: false, message: "Failed to load sitewide sale" });
        }
    }
);

app.patch(
    "/api/admin/sitewide-sale",
    requireAdmin,
    async (req, res) => {
        try {
            const percentage = Number(req.body.percentage || 0);
            if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
                return res.status(400).json({ success: false, message: "Percentage must be between 0 and 100" });
            }

            const result = await pool.query(
                `
                UPDATE sitewide_sale
                SET percentage=$1,
                    starts_at=$2,
                    expires_at=$3,
                    active=$4,
                    updated_at=NOW()
                WHERE id=1
                RETURNING percentage, starts_at, expires_at, active, updated_at
                `,
                [
                    percentage,
                    req.body.startsAt || null,
                    req.body.expiresAt || null,
                    Boolean(req.body.active)
                ]
            );

            res.json({ success: true, sale: result.rows[0] });
        } catch (error) {
            console.error("Save sitewide sale error:", error);
            res.status(500).json({ success: false, message: "Failed to save sitewide sale" });
        }
    }
);

app.get(
    "/api/sitewide-sale",
    async (req, res) => {
        try {
            const sale = await getActiveSitewideSale(pool);
            res.json({ success: true, sale });
        } catch (error) {
            console.error("Public sitewide sale error:", error);
            res.status(500).json({ success: false, message: "Failed to load sitewide sale" });
        }
    }
);

app.post(
    "/api/coupons/apply",
    async (req, res) => {
        try {
            const {
                code,
                customerEmail,
                shippingMethod,
                items
            } = req.body;

            if (!code || !Array.isArray(items) || !items.length) {
                return res.status(400).json({ success: false, message: "Discount code and cart items are required" });
            }

            const coupon = await getUsableCoupon(pool, code, customerEmail);
            const sale = await getActiveSitewideSale(pool);
            const pricedItems = [];
            let subtotal = 0;

            for (const item of items) {
                const quantity = Number(item.quantity);
                if (!item.productId || !Number.isInteger(quantity) || quantity <= 0) {
                    throw new Error("Invalid cart item");
                }

                const productResult = await pool.query(
                    "SELECT id, category, price FROM products WHERE id=$1",
                    [item.productId]
                );

                if (!productResult.rows.length) {
                    throw new Error(`Product not found: ${item.productId}`);
                }

                const product = productResult.rows[0];
                const unitPrice = applySitewideSalePrice(product.price, sale);
                subtotal += unitPrice * quantity;
                pricedItems.push({
                    productId: product.id,
                    category: product.category,
                    quantity,
                    unitPrice
                });
            }

            subtotal = roundMoney(subtotal);

            const storeSettings = readStoreSettings();
            const standardShippingPrice =
                Number(storeSettings.standard_shipping) || 0;
            const expressShippingPrice =
                Number(storeSettings.express_shipping) || 0;
            const internationalShippingPrice =
                Number(storeSettings.international_shipping) || 0;
            const freeShippingThreshold =
                Number(storeSettings.free_shipping_threshold) || 0;

            const shippingCost =
                shippingMethod === "international"
                    ? internationalShippingPrice
                    : shippingMethod === "express"
                        ? expressShippingPrice
                        : subtotal > freeShippingThreshold
                            ? 0
                            : standardShippingPrice;

            const discount = calculateCouponDiscount(coupon, pricedItems, subtotal, shippingCost);
            const totalAmount = roundMoney(
                subtotal + shippingCost - discount.itemDiscount - discount.shippingDiscount
            );

            res.json({
                success: true,
                code: coupon.code,
                subtotal,
                shippingCost,
                discountAmount: discount.itemDiscount,
                shippingDiscount: discount.shippingDiscount,
                totalDiscount: discount.totalDiscount,
                totalAmount
            });
        } catch (error) {
            res.status(400).json({
                success: false,
                message: error.message || "Unable to apply discount code"
            });
        }
    }
);


/* =========================
   CREATE ORDER
========================= */

app.post(
    "/api/orders",
    async (req, res) => {
        let client;

        try {
            const {
                customerFirstName,
                customerLastName,
                customerEmail,
                customerPhone,
                shippingAddress,
                shippingMethod,
                couponCode,
                items
            } = req.body;

            if (
                !customerFirstName ||
                !customerLastName ||
                !customerEmail ||
                !customerPhone ||
                !shippingAddress ||
                !shippingMethod ||
                !Array.isArray(items) ||
                items.length === 0
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Missing required order data"
                });
            }

            if (
                shippingMethod !==
                    "standard" &&
                shippingMethod !==
                    "express" &&
                shippingMethod !==
                    "international"
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid shipping method"
                });
            }

            client =
                await pool.connect();

            await client.query(
                "BEGIN"
            );

            const activeSale = await getActiveSitewideSale(client);
            const coupon = couponCode
                ? await getUsableCoupon(client, couponCode, customerEmail)
                : null;

            const verifiedItems = [];

            let subtotal = 0;

            for (
                const item
                of items
            ) {
                const quantity =
                    Number(
                        item.quantity
                    );

                if (
                    !Number.isInteger(
                        quantity
                    ) ||
                    quantity <= 0
                ) {
                    throw new Error(
                        "Invalid item quantity"
                    );
                }

                if (
                    !item.productId ||
                    !item.size
                ) {
                    throw new Error(
                        "Invalid item data"
                    );
                }

                const productResult =
                    await client.query(
                        `
                        SELECT
                            id,
                            name,
                            category,
                            price,
                            stock
                        FROM products
                        WHERE id = $1
                        FOR UPDATE
                        `,
                        [
                            item.productId
                        ]
                    );

                if (
                    productResult
                        .rows.length ===
                    0
                ) {
                    throw new Error(
                        `Product not found: ${item.productId}`
                    );
                }

                const product =
                    productResult
                        .rows[0];

                const unitPrice =
                    applySitewideSalePrice(
                        product.price,
                        activeSale
                    );

                const currentStock =
                    Number(
                        product.stock[
                            item.size
                        ]
                    );

                if (
                    !Number.isFinite(
                        unitPrice
                    ) ||
                    unitPrice < 0
                ) {
                    throw new Error(
                        `Invalid product price: ${product.id}`
                    );
                }

                if (
                    !Number.isFinite(
                        currentStock
                    )
                ) {
                    throw new Error(
                        `Invalid size ${item.size} for product ${item.productId}`
                    );
                }

                if (
                    currentStock <
                    quantity
                ) {
                    throw new Error(
                        `Not enough stock for ${product.name} size ${item.size}`
                    );
                }

                subtotal +=
                    unitPrice *
                    quantity;

                verifiedItems.push({
                    productId:
                        product.id,

                    productName:
                        product.name,

                    category:
                        product.category,

                    size:
                        item.size,

                    quantity,

                    unitPrice,

                    currentStock,

                    stock:
                        product.stock
                });
            }

            subtotal = roundMoney(subtotal);

            const storeSettings = readStoreSettings();
            const standardShippingPrice =
                Number(storeSettings.standard_shipping) || 0;
            const expressShippingPrice =
                Number(storeSettings.express_shipping) || 0;
            const internationalShippingPrice =
                Number(storeSettings.international_shipping) || 0;
            const freeShippingThreshold =
                Number(storeSettings.free_shipping_threshold) || 0;

            const shippingCost =
                shippingMethod ===
                "international"
                    ? internationalShippingPrice
                    : shippingMethod ===
                        "express"
                        ? expressShippingPrice
                        : subtotal > freeShippingThreshold
                            ? 0
                            : standardShippingPrice;

            const couponDiscount = calculateCouponDiscount(
                coupon,
                verifiedItems,
                subtotal,
                shippingCost
            );

            const discountAmount = roundMoney(
                couponDiscount.itemDiscount +
                couponDiscount.shippingDiscount
            );

            const totalAmount = roundMoney(
                subtotal +
                shippingCost -
                discountAmount
            );

            const orderNumber =
                `STILUS-${Date.now()}-${crypto.randomInt(
                    100,
                    1000
                )}`;

            const orderResult =
                await client.query(
                    `
                    INSERT INTO orders (
                        order_number,
                        customer_first_name,
                        customer_last_name,
                        customer_email,
                        customer_phone,
                        shipping_address,
                        shipping_method,
                        subtotal,
                        shipping_cost,
                        discount_code,
                        discount_amount,
                        total_amount,
                        status
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8,
                        $9,
                        $10,
                        $11,
                        $12,
                        $13
                    )
                    RETURNING
                        id,
                        order_number,
                        status
                    `,
                    [
                        orderNumber,
                        customerFirstName.trim(),
                        customerLastName.trim(),
                        customerEmail.trim(),
                        customerPhone.trim(),
                        shippingAddress.trim(),
                        shippingMethod,
                        subtotal,
                        shippingCost,
                        coupon ? coupon.code : null,
                        discountAmount,
                        totalAmount,
                        "pending"
                    ]
                );

            const orderId =
                orderResult.rows[0]
                    .id;

            if (coupon) {
                await client.query(
                    `
                    UPDATE discount_codes
                    SET usage_count = usage_count + 1,
                        updated_at = NOW()
                    WHERE id = $1
                    `,
                    [coupon.id]
                );

                await client.query(
                    `
                    INSERT INTO coupon_redemptions (
                        coupon_id,
                        customer_email,
                        order_id
                    )
                    VALUES ($1, $2, $3)
                    `,
                    [
                        coupon.id,
                        String(customerEmail).trim(),
                        orderId
                    ]
                );
            }

            for (
                const item
                of verifiedItems
            ) {
                const latestProductResult =
                    await client.query(
                        `
                        SELECT stock
                        FROM products
                        WHERE id = $1
                        FOR UPDATE
                        `,
                        [item.productId]
                    );

                if (!latestProductResult.rows.length) {
                    throw new Error(
                        `Product not found: ${item.productId}`
                    );
                }

                const latestStock =
                    latestProductResult.rows[0].stock || {};

                const latestSizeQuantity =
                    Number(latestStock[item.size]);

                if (
                    !Number.isFinite(latestSizeQuantity) ||
                    latestSizeQuantity < item.quantity
                ) {
                    throw new Error(
                        `Not enough stock for ${item.productName} size ${item.size}`
                    );
                }

                const updatedStock = {
                    ...latestStock,

                    [item.size]:
                        latestSizeQuantity -
                        item.quantity
                };

                await client.query(
                    `
                    UPDATE products
                    SET stock = $1::jsonb
                    WHERE id = $2
                    `,
                    [
                        JSON.stringify(
                            updatedStock
                        ),
                        item.productId
                    ]
                );

                await client.query(
                    `
                    INSERT INTO order_items (
                        order_id,
                        product_id,
                        product_name,
                        size,
                        quantity,
                        unit_price
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6
                    )
                    `,
                    [
                        orderId,
                        item.productId,
                        item.productName,
                        item.size,
                        item.quantity,
                        item.unitPrice
                    ]
                );
            }

            await client.query(
                "COMMIT"
            );

            await sendOrderEmail({
                orderNumber: orderResult.rows[0].order_number,
                customerFirstName: customerFirstName.trim(),
                customerLastName: customerLastName.trim(),
                customerEmail: customerEmail.trim(),
                customerPhone: customerPhone.trim(),
                shippingAddress: shippingAddress.trim(),
                shippingMethod,
                subtotal,
                shippingCost,
                totalAmount,
                status: orderResult.rows[0].status,
                items: verifiedItems,
                isStatusUpdate: false
            });

            res.status(201).json({
                success: true,
                message:
                    "Order created successfully",
                orderId,
                orderNumber:
                    orderResult.rows[0]
                        .order_number,
                status:
                    orderResult.rows[0]
                        .status,
                subtotal,
                shippingCost,
                discountCode: coupon ? coupon.code : null,
                discountAmount,
                totalAmount
            });
        } catch (error) {
            if (client) {
                try {
                    await client.query(
                        "ROLLBACK"
                    );
                } catch (
                    rollbackError
                ) {
                    console.error(
                        "Rollback error:",
                        rollbackError
                    );
                }
            }

            console.error(
                "Order creation error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    error.message ||
                    "Failed to create order"
            });
        } finally {
            if (client) {
                client.release();
            }
        }
    }
);




/* =========================
   MONTHLY REPORT
========================= */

app.get(
    "/api/admin/monthly-report",
    requireAdmin,
    async (req, res) => {
        try {
            const month = String(req.query.month || "").trim();

            if (!/^\d{4}-\d{2}$/.test(month)) {
                return res.status(400).json({
                    success: false,
                    message: "Choose a valid month"
                });
            }

            const startDate = `${month}-01`;

            const summaryResult = await pool.query(
                `
                SELECT
                    COUNT(*)::int AS total_orders,
                    COUNT(*) FILTER (
                        WHERE status <> 'cancelled'
                    )::int AS completed_or_active_orders,
                    COALESCE(
                        SUM(subtotal) FILTER (
                            WHERE status <> 'cancelled'
                        ),
                        0
                    ) AS total_subtotal,
                    COALESCE(
                        SUM(COALESCE(discount_amount, 0)) FILTER (
                            WHERE status <> 'cancelled'
                        ),
                        0
                    ) AS total_discounts,
                    COALESCE(
                        SUM(shipping_cost) FILTER (
                            WHERE status <> 'cancelled'
                        ),
                        0
                    ) AS total_shipping,
                    COALESCE(
                        SUM(total_amount) FILTER (
                            WHERE status <> 'cancelled'
                        ),
                        0
                    ) AS total_sales
                FROM orders
                WHERE created_at >= $1::date
                  AND created_at < ($1::date + INTERVAL '1 month')
                `,
                [startDate]
            );

            const ordersResult = await pool.query(
                `
                SELECT
                    order_number,
                    customer_first_name,
                    customer_last_name,
                    subtotal,
                    COALESCE(discount_amount, 0) AS discount_amount,
                    shipping_cost,
                    total_amount,
                    status,
                    created_at
                FROM orders
                WHERE created_at >= $1::date
                  AND created_at < ($1::date + INTERVAL '1 month')
                ORDER BY created_at DESC
                `,
                [startDate]
            );

            const topProductsResult = await pool.query(
                `
                SELECT
                    oi.product_name,
                    COALESCE(SUM(oi.quantity), 0)::int AS quantity_sold,
                    COALESCE(SUM(oi.unit_price * oi.quantity), 0) AS revenue
                FROM order_items oi
                JOIN orders o ON o.id = oi.order_id
                WHERE o.created_at >= $1::date
                  AND o.created_at < ($1::date + INTERVAL '1 month')
                  AND o.status <> 'cancelled'
                GROUP BY oi.product_name
                ORDER BY quantity_sold DESC, revenue DESC
                LIMIT 20
                `,
                [startDate]
            );

            const orderStatusesResult = await pool.query(
                `
                SELECT
                    status,
                    COUNT(*)::int AS count
                FROM orders
                WHERE created_at >= $1::date
                  AND created_at < ($1::date + INTERVAL '1 month')
                GROUP BY status
                ORDER BY count DESC, status ASC
                `,
                [startDate]
            );

            return res.json({
                success: true,
                summary: summaryResult.rows[0] || {},
                orders: ordersResult.rows,
                topProducts: topProductsResult.rows,
                orderStatuses: orderStatusesResult.rows
            });
        } catch (error) {
            console.error("Monthly report error:", error);

            return res.status(500).json({
                success: false,
                message: "Failed to generate monthly report"
            });
        }
    }
);


/* =========================
   STORE SETTINGS
========================= */

app.get(
    "/api/store-settings",
    (req, res) => {
        const settings = readStoreSettings();

        return res.json({
            success: true,
            settings
        });
    }
);

app.get(
    "/api/admin/store-settings",
    requireAdmin,
    (req, res) => {
        const settings = readStoreSettings();

        return res.json({
            success: true,
            settings
        });
    }
);


app.put(
    "/api/admin/store-banner",
    requireAdmin,
    (req, res) => {
        try {
            const bannerUrl = String(
                req.body.bannerUrl || ""
            ).trim();

            if (!bannerUrl) {
                return res.status(400).json({
                    success: false,
                    message: "Banner URL is required"
                });
            }

            const settings = {
                ...readStoreSettings(),
                banner_url: bannerUrl
            };

            writeStoreSettings(settings);

            return res.json({
                success: true,
                bannerUrl
            });
        } catch (error) {
            console.error(
                "Homepage banner save error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to save homepage banner"
            });
        }
    }
);


app.put(
    "/api/admin/store-settings",
    requireAdmin,
    (req, res) => {
        try {
            const current = readStoreSettings();

            const standardShipping = Number(
                req.body.standardShipping
            );
            const expressShipping = Number(
                req.body.expressShipping
            );
            const freeShippingThreshold = Number(
                req.body.freeShippingThreshold
            );
            const internationalShipping = Number(
                req.body.internationalShipping
            );

            const settings = {
                ...current,
                store_name: "STIŁUS",
                currency:
                    String(req.body.currency || "TL").trim() ||
                    "TL",
                standard_shipping:
                    Number.isFinite(standardShipping) &&
                    standardShipping >= 0
                        ? standardShipping
                        : current.standard_shipping,
                express_shipping:
                    Number.isFinite(expressShipping) &&
                    expressShipping >= 0
                        ? expressShipping
                        : current.express_shipping,
                free_shipping_threshold:
                    Number.isFinite(freeShippingThreshold) &&
                    freeShippingThreshold >= 0
                        ? freeShippingThreshold
                        : current.free_shipping_threshold,
                contact_email:
                    String(req.body.contactEmail || "").trim(),
                contact_phone:
                    String(req.body.contactPhone || "").trim(),
                maintenance_mode:
                    !!req.body.maintenanceMode,
                international_shipping:
                    Number.isFinite(internationalShipping) &&
                    internationalShipping >= 0
                        ? internationalShipping
                        : current.international_shipping
            };

            writeStoreSettings(settings);

            return res.json({
                success: true,
                settings
            });
        } catch (error) {
            console.error(
                "Store settings save error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to save store settings"
            });
        }
    }
);


/* =========================
   API 404
========================= */

app.use("/api", (req, res) => {
    return res.status(404).json({
        success: false,
        message: "API endpoint not found"
    });
});


/* =========================
   ERROR HANDLER
========================= */

app.use(
    (error, req, res, next) => {
        console.error(
            "Server error:",
            error
        );

        if (
            error instanceof
            multer.MulterError
        ) {
            if (
                error.code ===
                "LIMIT_FILE_SIZE"
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Image must be 10 MB or smaller"
                });
            }

            return res.status(400).json({
                success: false,
                message:
                    error.message
            });
        }

        if (error) {
            return res.status(400).json({
                success: false,
                message:
                    error.message ||
                    "Request failed"
            });
        }

        next();
    }
);


/* =========================
   START SERVER
========================= */

ensureCoreStoreTables()
    .then(() => Promise.all([
        ensureProductImagesColumn(),
        ensureOrderMoneyColumns(),
        ensureCustomersTable(),
        ensureDiscountTables()
    ]))
    .then(() => {
        app.listen(PORT, () => {
            console.log(`STILUS Backend is running on port ${PORT}`);
        });
    })
    .catch(error => {
        console.error("Failed to initialize product image storage:", error);
        process.exit(1);
    });