# GridPane V1 API Integrator Findings & Undocumented Constraints

This document catalogs technical findings, undocumented constraints, and required payload architectures gathered during integration of the Fleet dashboard with the GridPane V1 REST API (`/oauth/api/v1`). It is working documentation for anyone building against that API.

---

## 1. WAF Payload Parsing Discrepancy (The Numeric Integer Bug)

**Endpoint:** `PUT /oauth/api/v1/site/{id}`
**Objective:** Updating standard PHP INI or FPM configurations.

### The Issue
When dispatching standardized JSON payloads containing numeric configurations as `Integers` (e.g., `{ "pm_max_children": 8, "memory_limit": 128 }`), the GridPane Edge WAF Gateway immediately intercepts and drops the request. 

Critically, the WAF does **not** return a `422 Unprocessable Entity` or generic schema validation error. Instead, it triggers an instant **`429 Too Many Requests ("Beep, Beep, you're going too fast...")`** fallback error, falsely indicating an API velocity violation regardless of the request history.

### The Resolution
What works is sending every core configuration value as a string. Providing `{ "pm_max_children": "8", "memory_limit": "128" }` completely bypasses the 429 WAF rejection and successfully triggers the internal server tasks natively. 

> **Note:** The API gateway's payload JSON parser appears to treat `numbers` as invalid schemas and throws a misleading `429` rather than a standard `422 Schema Error`.

---

## 2. Process Manager (`pm`) Pairing Constraint

**Endpoint:** `PUT /oauth/api/v1/site/{id}`
**Objective:** Adjusting specific PHP-FPM metrics.

### The Issue
Attempts to partially sync solitary FPM metrics (like modifying only `pm_max_children` or `pm_max_requests` directly) will fail immediately with the identical `429` fallback response mentioned above. 

### The Resolution
GridPane’s backend validator stringently requires the core `pm` configuration variable to be included dynamically alongside any isolated FPM value modification to prevent the edge parser from crashing. Dispatching `{ "pm_max_children": "8", "pm": "dynamic" }` correctly validates.

---

## 3. Top-Level Partial Updating vs. Deep Hierarchy Merging

**Objective:** Safely synchronizing edge metrics without causing destructive configuration erasures.

### The Issue
Standard API practice dictates that `PUT` endpoints natively overwrite entire resource architectures implicitly. Attempting to follow this structure by fully `GET`ting the site, extracting the state, modifying a target variable, and using `PUT` to synchronize back, results in catastrophic payload failures. 

This is largely because the `GET` API provides highly complex nested structures (like `schedule_backups` arrays or internal backend identifiers). Pushing those read-only arrays back through the `.json` `PUT` stream forces the same WAF validation engine to drop the connection violently. 

### The Resolution
GridPane's V1 API has been confirmed to operate safely via top-level partial updates (essentially acting structurally like a `PATCH` request). There is no need to deep-merge data: passing small, stringified, partial root-level payloads modifies Nginx/PHP architectures without wiping secondary resources natively on the physical server.

---

## 4. The Recompilation Rate Limit Trap (Extension Cooldowns)

**Endpoint:** `PUT /oauth/api/v1/site/{id}`

### The Issue
Because updating site configurations requires reloading Nginx/PHP instances physically on the server, GridPane actively restricts concurrent configuration adjustments to a strict cooldown period (roughly ~60 seconds to prevent recursive web server reloads). 

While a completely logical infrastructural cap, testing revealed that standard `"Exponential Backoff"` request polling techniques (often used in web development to self-heal transient 429 delays) actually trigger unintentional deadlocks. Hitting the 429 wall and pausing momentarily before sequentially querying the API again actively **refreshes** the cooldown window block on GridPane's end extending the downtime penalty drastically.

### The Resolution
Instead of relying on automated retries for API updates, applications should immediately catch the genuine `429` validation hit on the first or second attempt, abandon the queue, and directly instruct the user that physical server regeneration is occurring, requiring a hard cooldown period before applying further changes.

---

## 5. Live File System Log Streams (Auth Scoping Limitations)

**Endpoint:** `GET /oauth/api/v1/site/{id}/logs`

### The Issue
When attempting to dynamically query system-level data logs (e.g. `nginx-access.log` or `php-slowlog.log`) natively through the V1 API, there is an undocumented route parameter issue within the existing OAuth middleware authentication chain. 

Testing exact parameter structures strictly returned the following internal scope restriction: 
> `"That site does not belong to the bearer of this access token. Unable to comply."` 

### The Resolution
Despite verifying flawless read-write `GET` and `PUT` validation targeting the identical `siteId` natively through the identical Bearer Token, the logs endpoint uniquely restricts scope dynamically. 

This strongly implies the `site/logs` endpoint operates exclusively bound to the internal UI web dashboard Guard (relying strictly on session cookies for owner validation) and is currently incompatible with standard external API OAuth tokens. Consequently, streaming real Unix logs natively over REST is officially impossible for integrations using V1 schema logic.
