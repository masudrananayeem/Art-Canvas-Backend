import { Hono } from "hono";
import { cors } from "hono/cors";
import { requireAuth, requireAdmin } from "./auth.js";
import { fsGet, fsList, fsCreate, fsPatch, fsDelete, fsQueryEquals } from "./firestore.js";
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
  return { ...rest, inStock: (stock ?? 0) > 0, sold: Number.isFinite(p.sold) ? p.sold : 0 };
}

function isValidProductInput(body) {
  return body && typeof body.name === "string" && body.name.trim().length > 0 && typeof body.price === "number" && body.price >= 0;
}

const PRODUCT_FIELDS = ["name", "description", "price", "category", "gender", "subcategory", "stock", "image", "imagePublicId", "rating", "reviews", "seed", "isFeatured", "sold"];

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

async function getCategorySettings(env) {
  const doc = await fsGet(env, "categories/_settings");
  return { renamed: doc?.renamed || {}, hidden: Array.isArray(doc?.hidden) ? doc.hidden : [] };
}

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
    sold: 0,
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
  const settings = await getCategorySettings(c.env);
  const hidden = new Set(settings.hidden);
  const builtins = BUILTIN_CATEGORIES
    .filter((cat) => !hidden.has(cat.id))
    .map((cat) => ({ ...cat, name: settings.renamed?.[cat.id] || cat.name, builtin: true }));
  const all = [...builtins, ...custom.filter((cat) => cat.id !== "_settings").map((cat) => ({ id: cat.id, name: cat.name, builtin: false }))];
  return c.json(all);
});

app.get("/api/admin/categories", requireAdmin, async (c) => {
  const custom = await fsList(c.env, "categories");
  const settings = await getCategorySettings(c.env);
  const hidden = new Set(settings.hidden);
  const builtins = BUILTIN_CATEGORIES.map((cat) => ({
    ...cat,
    name: settings.renamed?.[cat.id] || cat.name,
    originalName: cat.name,
    builtin: true,
    hidden: hidden.has(cat.id),
  }));
  const customs = custom
    .filter((cat) => cat.id !== "_settings")
    .map((cat) => ({ id: cat.id, name: cat.name, builtin: false, hidden: false }));
  return c.json([...builtins, ...customs]);
});

app.patch("/api/admin/categories/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "Category name is required" }, 400);
  if (BUILTIN_CATEGORY_IDS.has(id)) {
    const settings = await getCategorySettings(c.env);
    const renamed = { ...settings.renamed, [id]: name };
    const saved = await fsGet(c.env, "categories/_settings");
    const payload = { renamed, hidden: settings.hidden };
    if (saved) await fsPatch(c.env, "categories/_settings", payload);
    else await fsCreate(c.env, "categories", payload, "_settings");
    return c.json({ id, name, builtin: true });
  }
  const existing = await fsGet(c.env, `categories/${id}`);
  if (!existing) return c.json({ error: "Category not found" }, 404);
  const duplicate = (await fsList(c.env, "categories")).some((x) => x.id !== id && x.id !== "_settings" && String(x.name).toLowerCase() === name.toLowerCase());
  if (duplicate) return c.json({ error: `A category named "${name}" already exists` }, 409);
  return c.json(await fsPatch(c.env, `categories/${id}`, { name }));
});

app.post("/api/admin/categories", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "Category name is required" }, 400);

  const id = slugify(name);
  if (!id) return c.json({ error: "Please use a name with at least one letter or number" }, 400);
  if (BUILTIN_CATEGORY_IDS.has(id)) {
    const settings = await getCategorySettings(c.env);
    const hidden = settings.hidden.filter((x) => x !== id);
    const renamed = { ...settings.renamed };
    delete renamed[id];
    const saved = await fsGet(c.env, "categories/_settings");
    const payload = { renamed, hidden };
    if (saved) await fsPatch(c.env, "categories/_settings", payload);
    else await fsCreate(c.env, "categories", payload, "_settings");
    return c.json({ id, name: BUILTIN_CATEGORIES.find((x) => x.id === id)?.name || name, builtin: true, restored: true });
  }

  const existing = await fsGet(c.env, `categories/${id}`);
  if (existing) return c.json({ error: `A category named "${existing.name}" already exists` }, 409);

  const created = await fsCreate(c.env, "categories", { name, createdAt: new Date().toISOString() }, id);
  return c.json({ id: created.id, name: created.name, builtin: false }, 201);
});

app.delete("/api/admin/categories/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const products = await fsList(c.env, "products");
  const inUse = products.filter((p) => p.category === id).length;
  if (inUse > 0) return c.json({ error: `${inUse} product${inUse === 1 ? "" : "s"} still use this category. Move or delete ${inUse === 1 ? "it" : "them"} first.` }, 409);

  if (BUILTIN_CATEGORY_IDS.has(id)) {
    const settings = await getCategorySettings(c.env);
    const hidden = Array.from(new Set([...settings.hidden, id]));
    const payload = { renamed: settings.renamed, hidden };
    const saved = await fsGet(c.env, "categories/_settings");
    if (saved) await fsPatch(c.env, "categories/_settings", payload);
    else await fsCreate(c.env, "categories", payload, "_settings");
    return c.json({ ok: true });
  }
  const existing = await fsGet(c.env, `categories/${id}`);
  if (!existing) return c.json({ error: "Category not found" }, 404);
  await fsDelete(c.env, `categories/${id}`);
  return c.json({ ok: true });
});

// ---------- clothing sub-categories (Women / Men / Kids) ----------

app.get("/api/subcategories", async (c) => {
  const custom = await fsList(c.env, "subcategories");
  const byGender = Object.fromEntries(custom.map((d) => [d.id, d]));
  const result = {};
  for (const gender of Object.keys(BUILTIN_SUBCATEGORIES)) {
    const doc = byGender[gender] || {};
    const hidden = new Set(Array.isArray(doc.hidden) ? doc.hidden : []);
    const renamed = doc.renamed || {};
    result[gender] = [
      ...BUILTIN_SUBCATEGORIES[gender]
        .filter((name) => !hidden.has(name))
        .map((name) => ({ name: renamed[name] || name, originalName: name, builtin: true })),
      ...(doc.items || []).map((name) => ({ name, originalName: name, builtin: false })),
    ];
  }
  return c.json(result);
});

app.get("/api/admin/subcategories", requireAdmin, async (c) => {
  const custom = await fsList(c.env, "subcategories");
  const byGender = Object.fromEntries(custom.map((d) => [d.id, d]));
  const result = {};
  for (const gender of Object.keys(BUILTIN_SUBCATEGORIES)) {
    const doc = byGender[gender] || {};
    const hidden = new Set(Array.isArray(doc.hidden) ? doc.hidden : []);
    const renamed = doc.renamed || {};
    result[gender] = [
      ...BUILTIN_SUBCATEGORIES[gender].map((originalName) => ({
        name: renamed[originalName] || originalName,
        originalName,
        builtin: true,
        hidden: hidden.has(originalName),
      })),
      ...(doc.items || []).map((name) => ({ name, originalName: name, builtin: false, hidden: false })),
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

  const doc = await fsGet(c.env, `subcategories/${gender}`) || { items: [], renamed: {}, hidden: [] };
  const builtinOriginal = BUILTIN_SUBCATEGORIES[gender].find((n) => n.toLowerCase() === name.toLowerCase());
  if (builtinOriginal) {
    const hidden = (doc.hidden || []).filter((x) => x !== builtinOriginal);
    const renamed = { ...(doc.renamed || {}) };
    delete renamed[builtinOriginal];
    await fsPatch(c.env, `subcategories/${gender}`, { items: doc.items || [], renamed, hidden });
    return c.json({ gender, name: builtinOriginal, builtin: true, restored: true }, 200);
  }
  const existingNames = [...BUILTIN_SUBCATEGORIES[gender]];
  const items = doc.items || [];
  existingNames.push(...items);
  if (existingNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
    return c.json({ error: `"${name}" already exists under ${gender}` }, 409);
  }

  const nextItems = [...items, name];
  const saved = doc ? await fsPatch(c.env, `subcategories/${gender}`, { items: nextItems }) : await fsCreate(c.env, "subcategories", { items: nextItems }, gender);
  return c.json({ gender, items: saved.items }, 201);
});

app.patch("/api/admin/subcategories", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const gender = body?.gender;
  const oldName = typeof body?.oldName === "string" ? body.oldName.trim() : "";
  const newName = typeof body?.name === "string" ? body.name.trim() : "";
  if (!SUBCATEGORY_GENDERS.has(gender)) return c.json({ error: "gender must be one of women, men, kids" }, 400);
  if (!oldName || !newName) return c.json({ error: "Both oldName and name are required" }, 400);
  const doc = await fsGet(c.env, `subcategories/${gender}`) || { items: [], renamed: {}, hidden: [] };
  const builtIn = BUILTIN_SUBCATEGORIES[gender].find((n) => n.toLowerCase() === oldName.toLowerCase());
  const customName = (doc.items || []).find((n) => n.toLowerCase() === oldName.toLowerCase());
  if (!builtIn && !customName) return c.json({ error: "Sub-category not found" }, 404);
  const currentNames = [
    ...BUILTIN_SUBCATEGORIES[gender].filter((n) => n.toLowerCase() !== oldName.toLowerCase()).map((n) => doc.renamed?.[n] || n),
    ...(doc.items || []).filter((n) => n.toLowerCase() !== oldName.toLowerCase()),
  ];
  if (currentNames.some((n) => n.toLowerCase() === newName.toLowerCase())) return c.json({ error: `"${newName}" already exists under ${gender}` }, 409);
  const products = await fsList(c.env, "products");
  const sourceName = builtIn || customName;
  const affected = products.filter((p) => p.category === "clothing" && p.gender === gender && p.subcategory === sourceName);
  if (builtIn) {
    const renamed = { ...(doc.renamed || {}), [builtIn]: newName };
    for (const product of affected) {
      await fsPatch(c.env, `products/${product.id}`, { subcategory: newName });
    }
    const payload = { items: doc.items || [], renamed, hidden: doc.hidden || [] };
    const saved = await fsGet(c.env, `subcategories/${gender}`)
      ? await fsPatch(c.env, `subcategories/${gender}`, payload)
      : await fsCreate(c.env, "subcategories", payload, gender);
    return c.json({ gender, name: newName, builtin: true, saved });
  }
  const items = (doc.items || []).map((n) => n.toLowerCase() === oldName.toLowerCase() ? newName : n);
  for (const product of affected) {
    await fsPatch(c.env, `products/${product.id}`, { subcategory: newName });
  }
  const saved = await fsPatch(c.env, `subcategories/${gender}`, { items, renamed: doc.renamed || {}, hidden: doc.hidden || [] });
  return c.json({ gender, name: newName, builtin: false, saved });
});

app.delete("/api/admin/subcategories", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const gender = body?.gender;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!SUBCATEGORY_GENDERS.has(gender)) return c.json({ error: "gender must be one of women, men, kids" }, 400);
  if (!name) return c.json({ error: "Sub-category name is required" }, 400);

  const doc = await fsGet(c.env, `subcategories/${gender}`) || { items: [], renamed: {}, hidden: [] };
  const builtInOriginal = BUILTIN_SUBCATEGORIES[gender].find((n) => (doc.renamed?.[n] || n).toLowerCase() === name.toLowerCase());
  const customOriginal = (doc.items || []).find((n) => n.toLowerCase() === name.toLowerCase());
  if (!builtInOriginal && !customOriginal) return c.json({ error: "Sub-category not found" }, 404);

  const products = await fsList(c.env, "products");
  const inUse = products.filter((p) => p.category === "clothing" && p.gender === gender && (p.subcategory === name || p.subcategory === builtInOriginal)).length;
  if (inUse > 0) return c.json({ error: `${inUse} product${inUse === 1 ? "" : "s"} still use this sub-category. Move or update ${inUse === 1 ? "it" : "them"} first.` }, 409);

  if (builtInOriginal) {
    const hidden = Array.from(new Set([...(doc.hidden || []), builtInOriginal]));
    const payload = { items: doc.items || [], renamed: doc.renamed || {}, hidden };
    const existingDoc = await fsGet(c.env, `subcategories/${gender}`);
    if (existingDoc) await fsPatch(c.env, `subcategories/${gender}`, payload);
    else await fsCreate(c.env, "subcategories", payload, gender);
  } else {
    const items = (doc.items || []).filter((n) => n.toLowerCase() !== customOriginal.toLowerCase());
    await fsPatch(c.env, `subcategories/${gender}`, { items, renamed: doc.renamed || {}, hidden: doc.hidden || [] });
  }
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

const SITE_CONTENT_DEFAULTS = {
  heroImage: "", heroHeadline: "", heroTagline: "", heroTopLeft: "ARTCANVAS / NEW SEASON", heroTopRight: "DROP 04 — 2026",
  heroCtaLabel: "Explore the collection", heroCtaLink: "/shop?category=clothing", heroCtaNote: "Designed in small runs.\nMade to be kept.",
  heroBottomLeft: "01", heroBottomRight: "EST. 2026", filmTitle: "Clothing in motion.", filmDescription: "A moving study of fabric, proportion and everyday gesture.", filmVideoUrl: "",
  showWhatsNew: true, showFilm: true, showManifesto: true, whatsNewTitle: "What’s new.", whatsNewDescription: "Fresh pieces, new proportions and objects worth noticing."
};

app.get("/api/site-content", async (c) => {
  const doc = await fsGet(c.env, "siteContent/home");
  return c.json({ ...SITE_CONTENT_DEFAULTS, ...(doc || {}) });
});

app.patch("/api/admin/site-content", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid body" }, 400);
  const update = {};
  const strings = ["heroImage","heroHeadline","heroTagline","heroTopLeft","heroTopRight","heroCtaLabel","heroCtaLink","heroCtaNote","heroBottomLeft","heroBottomRight","filmTitle","filmDescription","filmVideoUrl","whatsNewTitle","whatsNewDescription"];
  for (const key of strings) if (key in body) update[key] = String(body[key] || "").slice(0, 2000);
  for (const key of ["showWhatsNew","showFilm","showManifesto"]) if (key in body) update[key] = body[key] === true;
  const existing = await fsGet(c.env, "siteContent/home");
  const saved = existing ? await fsPatch(c.env, "siteContent/home", update) : await fsCreate(c.env, "siteContent", update, "home");
  return c.json({ ...SITE_CONTENT_DEFAULTS, ...saved });
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
  let profile = await fsGet(c.env, `users/${user.uid}`);
  // Make sure a profile doc always exists once someone has signed in, so the
  // admin can find this person by email in the Messages tab even before they
  // ever touch the Account page.
  if (!profile) {
    profile = await fsCreate(c.env, "users", { email: user.email || "", name: user.name || "" }, user.uid);
  } else if (user.email && profile.email !== user.email) {
    profile = await fsPatch(c.env, `users/${user.uid}`, { email: user.email });
  }
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
      const currentSold = Number.isFinite(product.sold) ? product.sold : 0;
      if (currentStock < qty) return c.json({ error: `"${product.name}" is out of stock` }, 409);
      try {
        await fsPatch(c.env, `products/${line.id}`, { stock: currentStock - qty, sold: currentSold + qty }, product.updateTime);
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

// Admin order workflow. Cancelling an order restores the purchased quantities
// exactly once; changing away from cancelled does not reserve them again.
app.patch("/api/admin/orders/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const allowed = new Set(["placed", "confirmed", "processing", "shipped", "delivered", "cancelled"]);
  const status = body?.status;
  if (!allowed.has(status)) return c.json({ error: "Invalid order status" }, 400);

  const order = await fsGet(c.env, `orders/${id}`);
  if (!order) return c.json({ error: "Order not found" }, 404);
  if (order.status === status) return c.json(order);

  // Only the transition INTO cancelled restores stock. This makes repeated
  // clicks/retries safe and prevents double-restocking.
  if (status === "cancelled" && order.status !== "cancelled") {
    const items = Array.isArray(order.items) ? order.items : [];
    for (const item of items) {
      const qty = Math.max(0, Math.floor(Number(item?.qty) || 0));
      if (!item?.id || qty === 0) continue;
      for (let attempt = 0; attempt < 5; attempt++) {
        const product = await fsGet(c.env, `products/${item.id}`);
        if (!product) break; // Product may have been permanently removed.
        try {
          const restoredSold = Math.max(0, (Number.isFinite(product.sold) ? product.sold : 0) - qty);
          await fsPatch(c.env, `products/${item.id}`, { stock: Math.max(0, Math.floor(Number(product.stock) || 0)) + qty, sold: restoredSold }, product.updateTime);
          break;
        } catch (e) {
          if (e.status === 400 || e.status === 409) {
            if (attempt === 4) return c.json({ error: "Could not restore stock for the cancelled order. Please retry." }, 409);
            continue;
          }
          throw e;
        }
      }
    }
  }

  const saved = await fsPatch(c.env, `orders/${id}`, {
    status,
    updatedAt: new Date().toISOString(),
  });
  return c.json(saved);
});

app.delete("/api/admin/orders/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const order = await fsGet(c.env, `orders/${id}`);
  if (!order) return c.json({ error: "Order not found" }, 404);
  if (!["delivered", "cancelled"].includes(order.status)) return c.json({ error: "Only completed or cancelled orders can be deleted." }, 409);
  await fsDelete(c.env, `orders/${id}`);
  return c.json({ ok: true });
});

// ---------- messages (client <-> studio) ----------
// Every message document: { uid, email, from: "user" | "admin", text, createdAt }
// A "thread" is simply all messages sharing the same uid (the client's Firebase uid).

function cleanMessageText(body) {
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  return text.slice(0, 2000);
}

function sortByCreatedAt(list) {
  return [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

// Client sends a message to the studio.
app.post("/api/messages", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  const text = cleanMessageText(body);
  if (!text) return c.json({ error: "Message text is required" }, 400);

  const message = await fsCreate(c.env, "messages", {
    uid: user.uid,
    email: user.email || "",
    from: "user",
    text,
    createdAt: new Date().toISOString(),
  });
  return c.json(message, 201);
});

// Client reads their own conversation with the studio.
app.get("/api/messages/me", requireAuth, async (c) => {
  const user = c.get("user");
  try {
    const mine = await fsQueryEquals(c.env, "messages", "uid", user.uid);
    return c.json(sortByCreatedAt(mine));
  } catch (err) {
    // Preserve Firestore's quota status so the frontend can handle it as a
    // temporary rate-limit instead of turning every retry into a generic 500.
    const detail = String(err?.message || "");
    if (/429|Quota exceeded|RESOURCE_EXHAUSTED/i.test(detail)) {
      return c.json({ error: "Messages are temporarily rate-limited. Please try again shortly." }, 429);
    }
    throw err;
  }
});

// Admin: list every conversation, most recently active first.
app.get("/api/admin/messages/threads", requireAdmin, async (c) => {
  const all = await fsList(c.env, "messages");
  const byUid = new Map();
  for (const m of all) {
    if (!m.uid) continue;
    const existing = byUid.get(m.uid);
    if (!existing || m.createdAt > existing.lastAt) {
      byUid.set(m.uid, {
        uid: m.uid,
        email: m.email || existing?.email || "",
        lastText: m.text || "",
        lastFrom: m.from || "user",
        lastAt: m.createdAt || "",
      });
    } else if (!existing.email && m.email) {
      existing.email = m.email;
    }
  }
  const threads = [...byUid.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  return c.json(threads);
});

// Admin: find (or confirm) a client by email so a conversation can be opened
// even before that client has sent a first message.
app.post("/api/admin/messages/lookup", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) return c.json({ error: "Email is required" }, 400);

  const users = await fsList(c.env, "users");
  const match = users.find((u) => (u.email || "").toLowerCase() === email);
  if (!match) {
    return c.json({ error: "No ArtCanvas account found with that email. The customer needs to sign in at least once first." }, 404);
  }
  return c.json({ uid: match.id, email: match.email || email, name: match.name || "" });
});

// Admin: read one client's full conversation.
app.get("/api/admin/messages/:uid", requireAdmin, async (c) => {
  const uid = c.req.param("uid");
  const thread = await fsQueryEquals(c.env, "messages", "uid", uid);
  return c.json(sortByCreatedAt(thread));
});

// Admin: reply into a specific client's conversation.
app.post("/api/admin/messages/:uid", requireAdmin, async (c) => {
  const uid = c.req.param("uid");
  const body = await c.req.json().catch(() => null);
  const text = cleanMessageText(body);
  if (!text) return c.json({ error: "Message text is required" }, 400);

  const profile = await fsGet(c.env, `users/${uid}`);
  const email = profile?.email || (typeof body?.email === "string" ? body.email : "") || "";

  const message = await fsCreate(c.env, "messages", {
    uid,
    email,
    from: "admin",
    text,
    createdAt: new Date().toISOString(),
  });
  return c.json(message, 201);
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal error", detail: String(err.message || err) }, 500);
});

export default app;
