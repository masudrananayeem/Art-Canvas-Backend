// Minimal Firestore REST client for Cloudflare Workers.
// Authenticates as a Google service account using the JWT bearer flow
// (signed with Web Crypto, no Node-only libraries needed).

let cachedToken = null; // { token, exp }

function base64url(input) {
  let str = typeof input === "string" ? btoa(input) : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

async function getAccessToken(env) {
  if (cachedToken && cachedToken.exp - 60 > Date.now() / 1000) return cachedToken.token;

  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKeyPem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error("Failed to mint Google access token: " + (await res.text()));
  const data = await res.json();
  cachedToken = { token: data.access_token, exp: now + data.expires_in };
  return cachedToken.token;
}

function baseUrl(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

// ---- JS <-> Firestore REST "fields" value encoding ----

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFirestoreFields(v) } };
  return { stringValue: String(v) };
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    fields[k] = toFirestoreValue(v);
  }
  return fields;
}

function fromFirestoreValue(v) {
  if (!v) return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ("mapValue" in v) return fromFirestoreDoc({ fields: v.mapValue.fields || {} });
  return null;
}

function fromFirestoreDoc(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc.fields || {})) out[k] = fromFirestoreValue(v);
  return out;
}

function idFromName(name) {
  return name.split("/").pop();
}

// ---- Public helpers ----

export async function fsGet(env, path) {
  const token = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore GET ${path} failed: ${await res.text()}`);
  const doc = await res.json();
  return { id: idFromName(doc.name), updateTime: doc.updateTime, ...fromFirestoreDoc(doc) };
}

export async function fsList(env, collection) {
  const token = await getAccessToken(env);
  let docs = [];
  let pageToken;
  do {
    const url = new URL(`${baseUrl(env)}/${collection}`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Firestore LIST ${collection} failed: ${await res.text()}`);
    const data = await res.json();
    docs = docs.concat(data.documents || []);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return docs.map((doc) => ({ id: idFromName(doc.name), updateTime: doc.updateTime, ...fromFirestoreDoc(doc) }));
}

export async function fsCreate(env, collection, data, id) {
  const token = await getAccessToken(env);
  const url = new URL(`${baseUrl(env)}/${collection}`);
  if (id) url.searchParams.set("documentId", id);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFirestoreFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore CREATE ${collection} failed: ${await res.text()}`);
  const doc = await res.json();
  return { id: idFromName(doc.name), updateTime: doc.updateTime, ...fromFirestoreDoc(doc) };
}

// Patch (partial update) specific fields. Optionally pass expectedUpdateTime for
// optimistic-concurrency (used for safe stock decrements).
export async function fsPatch(env, path, data, expectedUpdateTime) {
  const token = await getAccessToken(env);
  const url = new URL(`${baseUrl(env)}/${path}`);
  for (const key of Object.keys(data)) url.searchParams.append("updateMask.fieldPaths", key);
  const body = { fields: toFirestoreFields(data) };
  if (expectedUpdateTime) body.currentDocument = { updateTime: expectedUpdateTime };
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Firestore PATCH ${path} failed: ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const doc = await res.json();
  return { id: idFromName(doc.name), updateTime: doc.updateTime, ...fromFirestoreDoc(doc) };
}

export async function fsDelete(env, path) {
  const token = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}/${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Firestore DELETE ${path} failed: ${await res.text()}`);
}

// Query documents in `collection` where `field` == `value`.
export async function fsQueryEquals(env, collection, field, value) {
  const token = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: collection }],
        where: {
          fieldFilter: {
            field: { fieldPath: field },
            op: "EQUAL",
            value: toFirestoreValue(value),
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Firestore QUERY ${collection} failed: ${await res.text()}`);
  const rows = await res.json();
  return rows.filter((r) => r.document).map((r) => ({ id: idFromName(r.document.name), updateTime: r.document.updateTime, ...fromFirestoreDoc(r.document) }));
}
