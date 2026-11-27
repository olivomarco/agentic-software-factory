---
applyTo: "backend/**"
---

- Routes live under `/api/` and return JSON, following the `/api/todos` and `/api/todos/:id` shape.
- Errors return `{ "error": "<message>" }` with 400 invalid input, 404 missing resource, 405 wrong method.
- Validate and trim input; reject empty or wrong-typed values with 400.
- Never echo internal error messages or stack traces to clients.
- Each new endpoint has tests for the success case and at least one error case.
