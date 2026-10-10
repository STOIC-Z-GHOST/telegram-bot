#!/usr/bin/env node
// Checks that every required setting and every AI provider key/model is really connected.
//
//   npm run check          quick: verifies keys and model ids for free (no generation quota)
//   npm run check:live     also sends ONE tiny "reply with OK" to each model
//
// Reads settings from .env.local (copy .env.example, or `vercel env pull .env.local`).
// The same check is available inside the bot as the owner-only /health command, which
// tests the keys actually set on Vercel.

const live = process.argv.includes("--live");

// Keep a copy of what was really set, then give the database client a placeholder so that
// importing the app's modules can't crash when DATABASE_URL is missing — the check reports
// the missing value itself, from the real copy.
const env = { ...process.env };
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = "postgres://placeholder:placeholder@localhost.invalid/placeholder";

const { runHealthCheck, formatReport, summarize } = await import("../lib/health.js");
const results = await runHealthCheck({ live, env });
console.log(formatReport(results, { live, liveHint: "Run `npm run check:live`" }));
process.exit(summarize(results).fail ? 1 : 0);
