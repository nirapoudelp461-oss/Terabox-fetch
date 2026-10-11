"use strict";

require("dotenv").config();

const express = require("express");
const dns = require("node:dns").promises;
const net = require("node:net");
const ipaddr = require("ipaddr.js");
const path = require("node:path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_URL = "https://xapiverse.com/api/terabox";
const MAX_REDIRECTS = 8;
const REQUEST_TIMEOUT = 12000;
const MAX_HTML_SIZE = 1024 * 1024;

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.static(__dirname, { index: false }));

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function validateHttpUrl(input) {
  let url;
  try { url = new URL(input); } catch { fail("Invalid URL."); }

  if (!["http:", "https:"].includes(url.protocol)) {
    fail("Only HTTP and HTTPS links are supported.");
  }
  if (url.username || url.password) fail("URLs containing credentials are not allowed.");
  if (!url.hostname || url.hostname.length > 253) fail("Invalid hostname.");
  if (url.port && !["80", "443"].includes(url.port)) fail("Custom ports are not allowed.");

  url.hash = "";
  return url;
}

function isPublicIp(address) {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  return parsed.range() === "unicast";
}

async function validatePublicHost(url) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) fail("Private or reserved IP destinations are blocked.", 403);
    return;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    fail("Could not resolve hostname: " + hostname, 502);
  }

  if (!addresses.length || addresses.some(item => !isPublicIp(item.address))) {
    fail("Hostname resolves to a private or reserved IP.", 403);
  }
}

async function safeFetch(url, options = {}) {
  let current = validateHttpUrl(String(url));
  const method = options.method || "GET";
  const headers = options.headers || {};
  const maxBytes = options.maxBytes || MAX_HTML_SIZE;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await validatePublicHost(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    let response;

    try {
      response = await fetch(current, {
        method, headers, redirect: "manual", signal: controller.signal
      });
    } catch (error) {
      if (error.name === "AbortError") fail("The remote server timed out.", 504);
      fail("Could not connect to " + current.hostname, 502);
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) fail("Redirect response has no Location header.", 502);
      if (hop === MAX_REDIRECTS) fail("Too many redirects.", 502);

      try {
        current = validateHttpUrl(new URL(location, current).href);
      } catch (error) {
        if (error.status) throw error;
        fail("Invalid redirect destination.", 502);
      }
      if (method !== "GET" && method !== "HEAD") {
        fail("Unexpected redirect from a non-GET request.", 502);
      }
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      fail("Remote page returned HTTP " + response.status, 502);
    }

    if (method === "HEAD") {
      await response.body?.cancel();
      return { url: current.href, response };
    }

    const reader = response.body?.getReader();
    if (!reader) return { url: current.href, response, text: "" };

    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          fail("Remote page exceeds the allowed size.", 413);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }

    return { url: current.href, response, text: Buffer.concat(chunks).toString("utf8") };
  }
  fail("Could not resolve URL.", 502);
}

const SUPPORTED_HOSTS = [
  /(^|\.)terabox\.com$/i,
  /(^|\.)1024terabox\.com$/i,
  /(^|\.)teraboxapp\.com$/i,
  /(^|\.)4funbox\.com$/i,
  /(^|\.)1024tera\.com$/i,
  /(^|\.)1024tera\.co$/i,
  /(^|\.)freeterabox\.com$/i,
  /(^|\.)terabox\.link$/i,
  /(^|\.)teraboxlinke\.com$/i
];

function isSupportedHost(hostname) {
  return SUPPORTED_HOSTS.some(pattern => pattern.test(hostname));
}

function findDestination(html, baseUrl) {
  const candidates = [];
  const metaPattern = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/ig;

  for (const match of html.matchAll(metaPattern)) {
    const content = match[0].match(/\bcontent\s*=\s*["']([^"']+)["']/i);
    if (content) {
      const dest = content[1].match(/(?:^|;)\s*url\s*=\s*['"]?([^'"]+)/i);
      if (dest) candidates.push(dest[1].trim());
    }
  }

  const scriptPatterns = [
    /(?:window|document)\.location(?:\.href)?\s*=\s*["']([^"']+)["']/ig,
    /(?:window\.)?location\.replace\(\s*["']([^"']+)["']\s*\)/ig,
    /(?:window\.)?location\.assign\(\s*["']([^"']+)["']\s*\)/ig
  ];
  for (const pattern of scriptPatterns) {
    for (const match of html.matchAll(pattern)) candidates.push(match[1]);
  }

  const canonical = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  if (canonical) candidates.push(canonical[1]);

  const ogUrl = html.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
  if (ogUrl) candidates.push(ogUrl[1]);

  const teraPattern = /https?:\\?\/\\?\/(?:www\.)?(?:1024terabox\.com|terabox\.com|teraboxapp\.com|4funbox\.com|1024tera\.com|1024tera\.co|freeterabox\.com|terabox\.link|teraboxlinke\.com)\/[^\s"'<>\\]+/ig;
  for (const match of html.matchAll(teraPattern)) candidates.push(match[0].replace(/\\/g, ""));

  for (const candidate of candidates) {
    try {
      const url = validateHttpUrl(new URL(candidate, baseUrl).href);
      if (isSupportedHost(url.hostname)) return url.href;
    } catch {}
  }
  return null;
}

async function resolveShortLink(input) {
  let current = validateHttpUrl(input);
  const visited = new Set();

  for (let attempt = 0; attempt < 4; attempt++) {
    if (visited.has(current.href)) fail("Redirect loop detected.", 502);
    visited.add(current.href);

    const page = await safeFetch(current.href);
    current = validateHttpUrl(page.url);

    if (isSupportedHost(current.hostname) &&
        !/(^|\.)teraboxlinke\.com$/i.test(current.hostname)) {
      return current.href;
    }

    const contentType = page.response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return current.href;
    }

    const destination = findDestination(page.text, current.href);
    if (!destination || visited.has(destination)) return current.href;
    current = validateHttpUrl(destination);
  }
  return current.href;
}

function normalizeApiResult(data) {
  if (!data || typeof data !== "object") fail("xAPIverse returned an invalid response.", 502);
  if (String(data.status || "").toLowerCase() === "error" || data.success === false) {
    fail(data.message || data.error || "xAPIverse could not process the link.", 502);
  }

  const list = Array.isArray(data.list) ? data.list :
    Array.isArray(data.data?.list) ? data.data.list :
    data.name ? [data] : [];
  return { ...data, list };
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/api/fetch", async (req, res) => {
  try {
    const input = String(req.body?.url || "").trim();
    if (!input || input.length > 4096) fail("Provide one URL no longer than 4096 characters.");
    if (!process.env.XAPIVERSE_API_KEY) fail("Server API key is not configured in .env.", 500);

    const original = validateHttpUrl(input);
    if (!isSupportedHost(original.hostname)) {
      fail("This domain is not on the supported TeraBox domain list.", 400);
    }

    const resolvedUrl = await resolveShortLink(original.href);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let apiResponse;

    try {
      apiResponse = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xAPIverse-Key": process.env.XAPIVERSE_API_KEY
        },
        body: JSON.stringify({ url: resolvedUrl }),
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === "AbortError") fail("xAPIverse request timed out.", 504);
      fail("Could not connect to xAPIverse.", 502);
    } finally {
      clearTimeout(timer);
    }

    let apiData;
    try {
      apiData = JSON.parse(await apiResponse.text());
    } catch {
      fail("xAPIverse returned a non-JSON response.", 502);
    }

    if (!apiResponse.ok) {
      fail(apiData.message || apiData.error || "xAPIverse HTTP error: " + apiResponse.status, 502);
    }

    const result = normalizeApiResult(apiData);
    res.json({
      status: "success",
      original_url: original.href,
      resolved_url: resolvedUrl,
      total_files: result.total_files ?? result.list.length,
      total_folders: result.total_folders ?? 0,
      list: result.list
    });
  } catch (error) {
    res.status(Number.isInteger(error.status) ? error.status : 500).json({
      status: "error",
      message: error.message || "Unexpected server error."
    });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(400).json({ status: "error", message: "Invalid request." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TeraBox Fetcher running at http://127.0.0.1:${PORT}`);
});
