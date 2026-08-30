# Security rules for AI-assisted development

Copy this into your project as CLAUDE.md (or merge it into your existing
one). It's written to map to what vendor security questionnaires and
DPAs commonly ask about — so `rulereceipt check` gives you real,
evidence-backed answers to those questions instead of "we think so."

Rules naming something concrete — a command, a file, a branch — are
checked locally with no API call. Rules needing real judgment are graded
against the actual session with `--llm`, using your own Anthropic key.
Either way you get the evidence, not a verdict to take on faith.

## 1. No secrets in source code
Never commit an API key, password, private key, or token directly in
code. Secrets come from environment variables or a secrets manager,
never hardcoded, never in `.env` files that get committed.

## 2. No PII in logs
Never log full names, email addresses, phone numbers, physical
addresses, or government ID numbers in plaintext. Log an opaque user ID
instead if you need to trace an issue back to a person.

## 3. Validate all external input
Every value coming from a user, an API request, or a third-party
integration gets validated before use — type, range, and format. Never
trust client-supplied data to be well-formed.

## 4. Parameterized queries only
Never build a SQL query by concatenating or interpolating a variable
directly into the query string. Always use parameterized queries or an
ORM's built-in escaping.

## 5. Auth checks before data access
Every code path that reads or writes another user's data checks
authorization first. Never assume a request is authorized because it
reached this far in the code.

## 6. Fail closed on auth/permission errors
If an authorization check errors out or can't be completed, deny the
request. Never default to allowing access when the check itself failed.

## 7. No `eval` or dynamic code execution on external input
Never pass user-supplied or externally-sourced data to `eval`, `exec`,
or an equivalent dynamic-execution function.

## 8. Least privilege on new dependencies and integrations
When adding a new package, API scope, or service account permission,
request only what's actually needed for the task — not the broadest
available scope "in case it's useful later."

## 9. No silent third-party data sharing
Never send customer or user data to a third-party API, analytics tool,
or logging service that wasn't already an explicitly approved
integration, without flagging it first.

## 10. Errors don't leak internals to end users
User-facing error messages never include stack traces, internal file
paths, database schema details, or raw exception text. Log the detail
internally; show the user something generic and safe.

## 11. Encrypt data in transit
Any new network call to an external service uses HTTPS/TLS. Never use
`http://` for anything carrying customer or credential data.

## 12. No hardcoded credentials in tests or fixtures either
Test files and fixtures never contain a real API key, real customer
data, or a real password — use clearly fake placeholder values.

## 13. Respect data deletion requests
Code implementing account or data deletion actually removes the data
(or a documented anonymization happens) — it doesn't just hide the
record from the UI while leaving it in the database.

## 14. Dependency changes get a stated reason
When adding or upgrading a dependency, the reason is stated (what it's
for), not just added silently as a side effect of another task.
