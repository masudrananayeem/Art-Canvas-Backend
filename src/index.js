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

app.get("/", (c) => c.json({ ok: true, service: "art-canvas-backend" }));

// ---------- helpers ----------

function publicProduct(p) {
  const { stock, ...rest } = p;
  return { ...rest, inStock: (stock ?? 0) > 0 };
}

function isValidProductInput(body) {
  return body && typeof body.name === "string" && body.name.trim().length > 0 && typeof body.price === "number" && body.price >= 0;
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

  const allowed = ["name", "description", "price", "category", "gender", "subcategory", "stock", "image", "imagePublicId", "rating", "reviews", "seed"];
  const update = {};
  for (const key of allowed) {
    if (key in body) update[key] = body[key];
  }
  if (update.stock !== undefined) update.stock = Math.max(0, Math.floor(Number(update.stock) || 0));
  if (update.price !== undefined) update.price = Number(update.price);
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

// ---------- cloudinary signed upload ----------

app.post("/api/admin/cloudinary-signature", requireAdmin, async (c) => {
  const sig = await buildCloudinarySignature(c.env);
  return c.json(sig);
});

// ---------- orders / purchase history ----------

app.post("/api/orders", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0) return c.json({ error: "items[] required" }, 400);

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
    shipping: body.shipping || null,
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

// ---------- current user ----------

app.get("/api/me", requireAuth, async (c) => {
  const user = c.get("user");
  return c.json({ uid: user.uid, email: user.email, name: user.name || null, admin: !!user.admin });
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal error", detail: String(err.message || err) }, 500);
});

export default app;
