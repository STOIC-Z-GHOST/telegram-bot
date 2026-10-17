#!/usr/bin/env node
// What can each of my keys actually use? Models each key can see + the limits each provider will tell us.
//
//   npm run limits                 models + limits; asks only the models the bot uses (a few tiny requests)
//   npm run limits -- --all        also asks every Groq chat model (one tiny request each)
//   npm run limits -- --probe-gemini   also sends ONE tiny request to the Gemini lite model (shows which quota a 429 hit)
//
// Reads keys from .env.local (copy .env.example, or `vercel env pull .env.local`). Keys are never printed.
// Not every provider reports limits — the output says which ones don't and where to read them instead.

const flags = new Set(process.argv.slice(2));
const env = { ...process.env };
// importing the app's modules must not crash when DATABASE_URL is missing; this script never touches the database
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = "postgres://placeholder:placeholder@localhost.invalid/placeholder";

const { providerCatalog } = await import("../lib/ai.js");
const { runProviderLimits, formatProviderLimits } = await import("../lib/providerLimits.js");

const sections = await runProviderLimits({ env, catalog: providerCatalog(), all: flags.has("--all"), probeGemini: flags.has("--probe-gemini") });
if (!sections.length) console.log("No provider keys found. Put them in .env.local (copy .env.example, or run `vercel env pull .env.local`) and run again.");
else console.log(formatProviderLimits(sections));
