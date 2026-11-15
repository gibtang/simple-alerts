# Relay browser reports through the monitored application

Browser error reports go to a same-origin route in the monitored Next.js application. That route forwards validated reports to Simple Alerts using the project's server-side reporting key; browser bundles never receive this key.

The relay is still a public, untrusted input surface. Origin checks and bounded per-process rate limiting reduce abuse but do not authenticate browser reports or prevent forged reports by non-browser clients. Server and browser reports therefore remain separate error groups. This avoids public ingestion credentials at the cost of one route and an extra network hop in each monitored application.
