# PHP-FPM Slowlog Integration: API Limitations & Future Implementation

**Subject:** Syncing PHP-FPM Slowlog Settings via GridPane V1 API

## Executive Summary
The dashboard currently features a fully styled, operational UI modal for viewing FPM diagnostic slowlogs and a toggle component meant to enable/disable the slowlog. 

**Current Limitation:** As of writing, the GridPane public V1 REST API (`PUT /oauth/api/v1/site/{id}`) **strictly rejects** any attempts to remotely toggle or configure the PHP-FPM slowlog.

## Technical Findings
Extensive physical probe tests against the live GridPane API were conducted with the following payload structures sent to `PUT /oauth/api/v1/site/{id}`:
- `{"is_php_slowlog": true}`
- `{"php_slow_log": true}`
- `{"site_customizer": {"is_php_slowlog": true, "php_slowlog_timeout": 10, "php_slowlog_trace_depth": 20}}`

**Result:** Every variation successfully returned a hard rejection from the Edge Gateway:
`HTTP 422: {"error":{"message":"No command was committed to the server. Insufficient payload."}}`

Although the *GET* request to the V1 API successfully returns the current state natively inside the `site_customizer` object (`is_php_slowlog: false`, `php_slowlog_timeout: 10`, `php_slowlog_trace_depth: 20`), the Edge Gateway does not map these schemas as actionable commands for external JWT Bearer tokens. Toggling this feature is physically only possible via GridPane's hidden internal worker API `/api/site/site-setting` using authenticated session cookies.

## Status

The toggle and the two number fields were taken off the site page. They changed
only this app's copy of the setting and reported a success that had not happened.
The page now shows the values GridPane reports, read-only, and the API route
refuses the three slow log keys with a 400.

To bring the controls back, follow `docs/parked-features.md`, "PHP slow log
controls". Test the three payloads above against the live API first.
