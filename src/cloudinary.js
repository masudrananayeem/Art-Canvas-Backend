// Generates a signature for a *signed* Cloudinary upload so the API secret
// never has to live in the frontend. The browser then uploads the file
// directly to Cloudinary using this signature (backend never touches the
// image bytes, keeping the Worker fast and cheap).

async function sha1Hex(message) {
  const data = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildCloudinarySignature(env, extraParams = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = env.CLOUDINARY_FOLDER || "artcanvas/products";
  const params = { timestamp, folder, ...extraParams };

  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");

  const signature = await sha1Hex(toSign + env.CLOUDINARY_API_SECRET);

  return {
    signature,
    timestamp,
    folder,
    apiKey: env.CLOUDINARY_API_KEY,
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
  };
}
