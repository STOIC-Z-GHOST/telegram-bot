// Ids Cloudflare's 2026-05-08 "Planned model deprecations" notice says REMAIN ACTIVE (the "-fast" variants), even though
// the catalog search endpoint doesn't return them. Shared by /health and /limits so "missing from the catalog search"
// isn't reported as "probably deprecated" for models Cloudflare itself says stay.
export const CF_STAYS_ACTIVE = new Set(["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fast"]);
