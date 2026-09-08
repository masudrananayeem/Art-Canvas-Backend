import { Hono } from "hono";
import { cors } from "hono/cors";
import { requireAuth, requireAdmin } from "./auth.js";
import { fsGet, fsList, fsCreate, fsPatch, fsDelete } from "./firestore.js";
import { buildCloudinarySignature } from "./cloudinary.js";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = (c.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (allowed.length === 0) return origin; // dev fallback: reflect origin
      return allowed.includes(origin) ? origin : allowed[0];
    },
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

app.get("/", (c) => {
  const configured = {
    FIREBASE_PROJECT_ID: !!c.env.FIREBASE_PROJECT_ID && c.env.FIREBASE_PROJECT_ID !== "your-firebase-project-id",
    FIREBASE_CLIENT_EMAIL: !!c.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: !!c.env.FIREBASE_PRIVATE_KEY,
    CLOUDINARY_CLOUD_NAME: !!c.env.CLOUDINARY_CLOUD_NAME && c.env.CLOUDINARY_CLOUD_NAME !== "your-cloudinary-cloud-name",
    CLOUDINARY_API_KEY: !!c.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: !!c.env.CLOUDINARY_API_SECRET,
  };
  const allSet = Object.values(configured).every(Boolean);
  return c.json({
    ok: true,
    service: "art-canvas-backend",
    configured,
    note: allSet ? "All required config detected." : "Some config is missing — see README.md (.dev.vars for local dev, `wrangler secret put` for production).",
  });
});

// ---------- helpers ----------

function publicProduct(p) {
  const { stock, ...rest } = p;
  return { ...rest, inStock: (stock ?? 0) > 0 };
}

function isValidProductInput(body) {
  return body && typeof body.name === "string" && body.name.trim().length > 0 && typeof body.price === "number" && body.price >= 0;
}

const PRODUCT_FIELDS = ["name", "description", "price", "category", "gender", "subcategory", "stock", "image", "imagePublicId", "rating", "reviews", "seed", "isFeatured"];

// The five categories the store ships with. They always appear in
// GET /api/categories and can't be deleted — admins can only add to this
// list or remove the custom ones they created.
const BUILTIN_CATEGORIES = [
  { id: "clothing", name: "Clothing" },
  { id: "art", name: "Art" },
  { id: "objects", name: "Objects" },
  { id: "accessories", name: "Accessories" },
  { id: "gifts", name: "Gifts" },
];
const BUILTIN_CATEGORY_IDS = new Set(BUILTIN_CATEGORIES.map((c) => c.id));

// Clothing's built-in Women/Men/Kids sub-categories. Same deal as
// categories: these always show up and can't be deleted, admins can add
// more or remove the ones they added.
const BUILTIN_SUBCATEGORIES = {
  women: ["Dresses", "Outerwear", "Tops"],
  men: ["Shirts", "Outerwear", "Trousers"],
  kids: ["Tees", "Outerwear", "Sets"],
};
const SUBCATEGORY_GENDERS = new Set(Object.keys(BUILTIN_SUBCATEGORIES));

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function cleanAddress(a) {
  if (!a || typeof a !== "object") return null;
  const pick = (k) => (typeof a[k] === "string" ? a[k].trim().slice(0, 200) : "");
  const out = {
    fullName: pick("fullName"),
    phone: pick("phone"),
    line1: pick("line1"),
    line2: pick("line2"),
    city: pick("city"),
    state: pick("state"),
    zip: pick("zip"),
    country: pick("country"),
  };
  return Object.values(out).some(Boolean) ? out : null;
}

// ---------- products: public ----------

app.get("/api/products", async (c) => {
  const products = await fsList(c.env, "products");
  return c.json(products.map(publicProduct));
});

app.get("/api/products/:id", async (c) => {
  const p = await fsGet(c.env, `products/${c.req.param("id")}`);
  if (!p) return c.json({ error: "Not found" }, 404);
  return c.json(publicProduct(p));
});

// ---------- products: admin ----------

app.get("/api/admin/products", requireAdmin, async (c) => {
  const products = await fsList(c.env, "products");
  return c.json(products);
});

app.post("/api/admin/products", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!isValidProductInput(body)) return c.json({ error: "name and price are required" }, 400);

  const product = {
    name: body.name.trim(),
    description: body.description || "",
    price: Number(body.price),
    category: body.category || "objects",
    gender: body.gender || "all",
    subcategory: body.subcategory || "",
    stock: Number.isFinite(body.stock) ? Math.max(0, Math.floor(body.stock)) : 0,
    image: body.image || "",
    imagePublicId: body.imagePublicId || "",
    rating: Number.isFinite(body.rating) ? body.rating : 4.8,
    reviews: Number.isFinite(body.reviews) ? body.reviews : 0,
    isFeatured: body.isFeatured === true,
    seed: body.seed || `ac-clothing-${Math.floor(Math.random() * 6)}`,
    createdAt: new Date().toISOString(),
  };
  const created = await fsCreate(c.env, "products", product);
  return c.json(created, 201);
});

app.patch("/api/admin/products/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid body" }, 400);

  const update = {};
  for (const key of PRODUCT_FIELDS) {
    if (key in body) update[key] = body[key];
  }
  if (update.stock !== undefined) update.stock = Math.max(0, Math.floor(Number(update.stock) || 0));
  if (update.price !== undefined) update.price = Number(update.price);
  if (update.isFeatured !== undefined) update.isFeatured = update.isFeatured === true;
  if (Object.keys(update).length === 0) return c.json({ error: "No valid fields to update" }, 400);

  try {
    const updated = await fsPatch(c.env, `products/${id}`, update);
    return c.json(updated);
  } catch (e) {
    return c.json({ error: "Update failed", detail: String(e.message || e) }, 400);
  }
});

app.delete("/api/admin/products/:id", requireAdmin, async (c) => {
  await fsDelete(c.env, `products/${c.req.param("id")}`);
  return c.json({ ok: true });
});

// ---------- categories ----------

app.get("/api/categories", async (c) => {
  const custom = await fsList(c.env, "categories");
  const all = [...BUILTIN_CATEGORIES.map((cat) => ({ ...cat, builtin: true })), ...custom.map((cat) => ({ id: cat.id, name: cat.name, builtin: false }))];
  return c.json(all);
});

app.post("/api/admin/categories", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "Category name is required" }, 400);

  const id = slugify(name);
  if (!id) return c.json({ error: "Please use a name with at least one letter or number" }, 400);
  if (BUILTIN_CATEGORY_IDS.has(id)) return c.json({ error: `"${name}" is already a default category` }, 409);

  const existing = await fsGet(c.env, `categories/${id}`);
  if (existing) return c.json({ error: `A category named "${existing.name}" already exists` }, 409);

  const created = await fsCreate(c.env, "categories", { name, createdAt: new Date().toISOString() }, id);
  return c.json({ id: created.id, name: created.name, builtin: false }, 201);
});

app.delete("/api/admin/categories/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  if (BUILTIN_CATEGORY_IDS.has(id)) return c.json({ error: "Default categories can't be deleted" }, 400);

  const existing = await fsGet(c.env, `categories/${id}`);
  if (!existing) return c.json({ error: "Category not found" }, 404);

  const products = await fsList(c.env, "products");
  const inUse = products.filter((p) => p.category === id).length;
  if (inUse > 0) {
    return c.json({ error: `${inUse} product${inUse === 1 ? "" : "s"} still use this category. Move or delete ${inUse === 1 ? "it" : "them"} first.` }, 409);
  }

  await fsDelete(c.env, `categories/${id}`);
  return c.json({ ok: true });
});

// ---------- clothing sub-categories (Women / Men / Kids) ----------

app.get("/api/subcategories", async (c) => {
  const custom = await fsList(c.env, "subcategories"); // docs: {id: gender, items: [names]}
  const byGender = Object.fromEntries(custom.map((d) => [d.id, d.items || []]));
  const result = {};
  for (const gender of Object.keys(BUILTIN_SUBCATEGORIES)) {
    result[gender] = [
      ...BUILTIN_SUBCATEGORIES[gender].map((name) => ({ name, builtin: true })),
      ...(byGender[gender] || []).map((name) => ({ name, builtin: false })),
    ];
  }
  return c.json(result);
});

app.post("/api/admin/subcategories", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const gender = body?.gender;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!SUBCATEGORY_GENDERS.has(gender)) return c.json({ error: "gender must be one of women, men, kids" }, 400);
  if (!name) return c.json({ error: "Sub-category name is required" }, 400);

  const existingNames = [...BUILTIN_SUBCATEGORIES[gender]];
  const doc = await fsGet(c.env, `subcategories/${gender}`);
  const items = doc?.items || [];
  existingNames.push(...items);
  if (existingNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
    return c.json({ error: `"${name}" already exists under ${gender}` }, 409);
  }

  const nextItems = [...items, name];
  const saved = doc ? await fsPatch(c.env, `subcategories/${gender}`, { items: nextItems }) : await fsCreate(c.env, "subcategories", { items: nextItems }, gender);
  return c.json({ gender, items: saved.items }, 201);
});

app.delete("/api/admin/subcategories", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const gender = body?.gender;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!SUBCATEGORY_GENDERS.has(gender)) return c.json({ error: "gender must be one of women, men, kids" }, 400);
  if (BUILTIN_SUBCATEGORIES[gender]?.some((n) => n.toLowerCase() === name.toLowerCase())) {
    return c.json({ error: "Default sub-categories can't be deleted" }, 400);
  }

  const doc = await fsGet(c.env, `subcategories/${gender}`);
  const items = doc?.items || [];
  if (!items.some((n) => n.toLowerCase() === name.toLowerCase())) return c.json({ error: "Sub-category not found" }, 404);

  const products = await fsList(c.env, "products");
  const inUse = products.filter((p) => p.category === "clothing" && p.gender === gender && p.subcategory === name).length;
  if (inUse > 0) {
    return c.json({ error: `${inUse} product${inUse === 1 ? "" : "s"} still use this sub-category. Move or delete ${inUse === 1 ? "it" : "them"} first.` }, 409);
  }

  const nextItems = items.filter((n) => n.toLowerCase() !== name.toLowerCase());
  await fsPatch(c.env, `subcategories/${gender}`, { items: nextItems });
  return c.json({ ok: true });
});

// ---------- cloudinary signed uploads ----------
// Product photos & the homepage hero image are admin-only. Profile photos can
// be uploaded by any signed-in user, but only into their own folder.

app.post("/api/admin/cloudinary-signature", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const context = body?.context === "site" ? "site" : "product";
  const baseFolder = c.env.CLOUDINARY_FOLDER || "artcanvas/products";
  const folder = context === "site" ? baseFolder.replace(/\/products$/, "") + "/site" : baseFolder;
  const sig = await buildCloudinarySignature(c.env, folder);
  return c.json(sig);
});

app.post("/api/cloudinary-signature", requireAuth, async (c) => {
  const user = c.get("user");
  const baseFolder = (c.env.CLOUDINARY_FOLDER || "artcanvas/products").replace(/\/products$/, "");
  const folder = `${baseFolder}/profiles/${user.uid}`;
  const sig = await buildCloudinarySignature(c.env, folder);
  return c.json(sig);
});

// ---------- site content (admin-controlled homepage) ----------

app.get("/api/site-content", async (c) => {
  const doc = await fsGet(c.env, "siteContent/home");
  return c.json({
    heroImage: doc?.heroImage || "",
    heroHeadline: doc?.heroHeadline || "",
    heroTagline: doc?.heroTagline || "",
  });
});

app.patch("/api/admin/site-content", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid body" }, 400);
  const update = {};
  for (const key of ["heroImage", "heroHeadline", "heroTagline"]) {
    if (key in body) update[key] = String(body[key] || "").slice(0, 2000);
  }
  const existing = await fsGet(c.env, "siteContent/home");
  const saved = existing ? await fsPatch(c.env, "siteContent/home", update) : await fsCreate(c.env, "siteContent", update, "home");
  return c.json(saved);
});

// ---------- user profile ----------

function publicUser(claims, profile) {
  return {
    uid: claims.uid,
    email: claims.email,
    admin: !!claims.admin,
    name: profile?.name || claims.name || "",
    phone: profile?.phone || "",
    photoURL: profile?.photoURL || "",
    address: profile?.address || null,
  };
}

app.get("/api/me", requireAuth, async (c) => {
  const user = c.get("user");
  const profile = await fsGet(c.env, `users/${user.uid}`);
  return c.json(publicUser(user, profile));
});

app.patch("/api/me", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid body" }, 400);

  const update = {};
  if (typeof body.name === "string") update.name = body.name.trim().slice(0, 120);
  if (typeof body.phone === "string") update.phone = body.phone.trim().slice(0, 40);
  if (typeof body.photoURL === "string") update.photoURL = body.photoURL.slice(0, 1000);
  if (body.address !== undefined) update.address = cleanAddress(body.address);

  const existing = await fsGet(c.env, `users/${user.uid}`);
  const saved = existing ? await fsPatch(c.env, `users/${user.uid}`, update) : await fsCreate(c.env, "users", { email: user.email || "", ...update }, user.uid);
  return c.json(publicUser(user, saved));
});

// ---------- orders / checkout / purchase history ----------

app.post("/api/orders", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0) return c.json({ error: "items[] required" }, 400);

  const shipping = cleanAddress(body.shipping);
  if (!shipping || !shipping.fullName || !shipping.phone || !shipping.line1 || !shipping.city) {
    return c.json({ error: "Shipping details (name, phone, address, city) are required" }, 400);
  }
  const paymentMethod = ["cod", "bkash", "nagad"].includes(body.paymentMethod) ? body.paymentMethod : "cod";
  const paymentRef = paymentMethod !== "cod" && typeof body.paymentRef === "string" ? body.paymentRef.trim().slice(0, 60) : "";
  if (paymentMethod !== "cod" && !paymentRef) {
    return c.json({ error: `Please provide the ${paymentMethod === "bkash" ? "bKash" : "Nagad"} transaction ID` }, 400);
  }

  // Validate stock and build an order snapshot. Retry a couple of times if a
  // concurrent purchase raced us on the same product (optimistic concurrency
  // via Firestore's updateTime precondition).
  const orderItems = [];
  let total = 0;

  for (const line of items) {
    const qty = Math.max(1, Math.floor(Number(line.qty) || 1));
    let attempt = 0;
    let done = false;
    while (attempt < 3 && !done) {
      attempt++;
      const product = await fsGet(c.env, `products/${line.id}`);
      if (!product) return c.json({ error: `Product ${line.id} not found` }, 404);
      const currentStock = product.stock ?? 0;
      if (currentStock < qty) return c.json({ error: `"${product.name}" is out of stock` }, 409);
      try {
        await fsPatch(c.env, `products/${line.id}`, { stock: currentStock - qty }, product.updateTime);
        orderItems.push({ id: product.id, name: product.name, price: product.price, image: product.image || "", qty });
        total += product.price * qty;
        done = true;
      } catch (e) {
        if (e.status === 400 || e.status === 409) continue; // precondition failed, retry
        throw e;
      }
    }
    if (!done) return c.json({ error: "Could not reserve stock, please try again" }, 409);
  }

  const order = await fsCreate(c.env, "orders", {
    uid: user.uid,
    email: user.email || "",
    items: orderItems,
    total,
    status: "placed",
    createdAt: new Date().toISOString(),
    shipping,
    paymentMethod,
    paymentRef,
  });

  return c.json(order, 201);
});

app.get("/api/orders/me", requireAuth, async (c) => {
  const user = c.get("user");
  const all = await fsList(c.env, "orders");
  const mine = all.filter((o) => o.uid === user.uid).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return c.json(mine);
});

app.get("/api/admin/orders", requireAdmin, async (c) => {
  const all = await fsList(c.env, "orders");
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return c.json(all);
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal error", detail: String(err.message || err) }, 500);
});

export default app;
