import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No ISR/data-cache in this app (every dashboard route is auth-gated and
// dynamic; static pages ship as assets), so the default no-op incremental
// cache is correct — no R2 bucket needed.
export default defineCloudflareConfig();
