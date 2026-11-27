# Coding standards

The review workflow checks every pull request against these rules and cites them by heading. Each rule is written so a reviewer can answer yes or no.

## Tests

- Every behavior change adds or updates a test next to the code (`*.test.js`).
- Each new API endpoint has tests for the success case and at least one error case.
- Tests must not depend on each other's data or on execution order.
- `npm test` passes.

## Dependencies

- The project is dependency-free. Do not add packages unless the ticket asks for it.

## Backend API

- Routes live under `/api/` and return JSON.
- Errors return `{ "error": "<message>" }` with the correct status: 400 invalid input, 404 missing resource, 405 wrong method.
- Validate and trim request input before using it. Reject empty or wrong-typed values with 400.
- Do not echo raw internal error messages or stack traces to clients.
- New routes follow the existing REST shape (`/api/todos`, `/api/todos/:id`).

## Frontend

- Build DOM with `createElement` and `textContent`. Never put user data in `innerHTML`.
- Keep pure logic in `frontend/logic.js` and unit test it. `app.js` only wires the DOM and calls the API.
- Interactive controls are accessible: buttons and inputs have visible text or an accessible label, and text and background colors keep a readable contrast (WCAG AA, 4.5:1).
- Styling goes in `frontend/styles.css`, not inline `style` attributes.

## Code style

- Plain CommonJS for backend and shared code. No build step.
- Use `const` by default, strict equality, and early returns over deep nesting.
- Functions do one thing and are short enough to read without scrolling.
- Comment only where the code is not self-explanatory. Do not leave dead code or commented-out code.
- No `console.log` debugging left in committed code, except the startup message in `backend/server.js`.

## Security

- No secrets, tokens or credentials in the repository.
- Do not weaken input validation or add `eval`, `Function` or shell execution on user input.

## Scope and workflow

- Make only the change the ticket asks for; no unrelated refactors.
- Do not modify `.github/` in a feature or review change; workflow, agent and instruction changes need a separate human-reviewed PR (enforced by `CODEOWNERS`).
- Update `README.md` or `AGENTS.md` when commands or behavior they describe change.
