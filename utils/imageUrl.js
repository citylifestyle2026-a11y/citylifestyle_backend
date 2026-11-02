// Image URLs saved in the database can point to the wrong place: an old host
// (localhost, onrender.com, vercel.app ...), http:// on an https page, or a
// relative "/uploads/..." path. These helpers turn a saved value into the
// addresses worth trying, best first.
//
// On the live server /uploads/<file> is answered by IIS (404) and never
// reaches Node, so our own uploads are tried through the API first:
//   https://api.citylifestyleindia.com/api/uploads/<folder>/<file>

const stripSlash = (v) => String(v || "").replace(/\/+$/, "");

const getApiBase = () => {
  // VITE_API_BASE_URL is like https://api.citylifestyleindia.com/api
  const base = stripSlash(import.meta.env.VITE_API_BASE_URL);
  try {
    const url = new URL(base);
    return {
      origin: url.origin,
      // keep the /api part; add it when the env value has none
      apiBase: /\/api$/i.test(url.pathname) ? base : `${url.origin}/api`,
    };
  } catch {
    return { origin: "", apiBase: "" };
  }
};

// -> list of URLs to try in order (the saved one is always the last resort).
export const imageUrlCandidates = (src) => {
  const raw = String(src || "").trim();
  if (!raw) return [];
  if (/^(data:|blob:)/i.test(raw)) return [raw];

  const { origin, apiBase } = getApiBase();
  const list = [];

  // "/uploads/x.webp", "uploads/x.webp" or "https://any-host/uploads/x.webp"
  let uploadsPath = "";
  if (/^\/?uploads\//i.test(raw)) {
    uploadsPath = raw.replace(/^\/?uploads\//i, "");
  } else {
    try {
      const url = new URL(raw);
      if (/^\/uploads\//i.test(url.pathname)) {
        uploadsPath = url.pathname.replace(/^\/uploads\//i, "") + url.search;
      }
    } catch {
      // not an absolute URL
    }
  }

  if (uploadsPath) {
    if (apiBase) list.push(`${apiBase}/uploads/${uploadsPath}`);
    if (origin) list.push(`${origin}/uploads/${uploadsPath}`);
  }

  // http:// image on an https:// page is blocked by the browser.
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" && window.location.protocol === "https:") {
      url.protocol = "https:";
      list.push(url.toString());
    }
  } catch {
    // relative value
  }

  list.push(raw);
  return [...new Set(list)];
};