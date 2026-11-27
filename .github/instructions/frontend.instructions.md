---
applyTo: "frontend/**"
---

- Build DOM with `createElement` and `textContent`; never put user data in `innerHTML`.
- Keep pure logic in `frontend/logic.js` with unit tests; `app.js` only wires the DOM and calls the API.
- Controls need visible text or an accessible label; text/background contrast must meet WCAG AA (4.5:1).
- Styling goes in `frontend/styles.css`, not inline `style` attributes.
