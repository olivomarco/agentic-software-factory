# Add a dark mode toggle

## What
Add a button in the page header that switches the app between a light and a dark colour scheme.

## Acceptance criteria
- A visible toggle button sits next to the page heading.
- Clicking it switches the page between light and dark colours, and the button label reflects the current mode.
- The choice is remembered after a page reload (use `localStorage`).
- Text stays readable in both modes.
- Pure logic (reading and saving the choice) lives in `frontend/logic.js` with unit tests.

## Out of scope
Following the operating system's colour preference.

# Add a todo filter: all, active, completed

## What
Let users filter the list by status.

## Acceptance criteria
- `frontend/logic.js` exports a pure `filterTodos(todos, filter)` supporting `all`, `active` and `completed`; unknown filters behave like `all`.
- The UI has three filter buttons above the list; the selected one is visually highlighted and the list updates on click.
- Unit tests cover each filter, an empty list and an unknown filter.

# Add a due date to todos

## What
Let users optionally set a due date on a todo.

## Acceptance criteria
- `POST /api/todos` and `PATCH /api/todos/:id` accept an optional `dueDate` (ISO `YYYY-MM-DD`); invalid values return 400.
- The UI has a date input when adding a todo and shows the due date next to the title.
- `frontend/logic.js` exports a pure `isOverdue(todo, today)`; overdue incomplete todos get an `overdue` CSS class.
- Backend and logic tests cover valid, missing and invalid dates and overdue behaviour.

# Rename the demo page heading to "My todos"

The demo landing page currently says `Todo`. Change the visible page heading and browser tab title to `My todos`.

## Acceptance criteria
- With `npm start` and a fresh in-memory store, opening `/` shows a single top-level heading reading `My todos`, and the browser tab title reads `My todos`.
- Adding and completing a todo still works as before. Keep the change frontend-only and dependency-free; run `npm test`.

## Visual evidence
Use the same landing page, viewport and empty synthetic state for the before and after screenshots. The before image should show `Todo`, and the after image should show `My todos`. Both PNGs must be embedded in the draft PR description, not just linked.

# Make the app better

The app feels basic. Please improve it.

# Support a dark theme

Some of us use the app at night. Could the page have a dark theme? It would be nice if it stuck after refresh.

# Todos can be created with only spaces as the title

Typing a few spaces and pressing Add creates an empty-looking todo. It should be rejected or trimmed. Not sure whether the API or the UI should enforce it.

# Persist todos between server restarts

Right now todos disappear when the server restarts because storage is in memory. Add persistence. Keep the project dependency-free.

# Add drag and drop reordering of todos

Let users drag todos to change their order. The order should survive a page reload.

# Show a count of remaining todos in the page title

Show how many todos are still active, for example in the browser tab title, so it's visible when the tab is in the background.

# Add keyboard shortcut to focus the new todo input

Pressing / anywhere on the page should focus the new todo input.

# Keep long todo titles readable on narrow screens

Add a todo with a long sentence, then narrow the browser to a mobile-sized viewport. Check whether the title wraps without clipping the row controls or forcing horizontal scrolling. Recommend the smallest change if needed.

# Check whether a long URL pushes todo controls off-screen

Add a todo whose title is a long unbroken sample URL, then inspect the row at a mobile-sized viewport. Check whether the controls stay reachable, and whether this needs its own fix or shares a cause with other title-overflow reports.

# Keep keyboard focus predictable when deleting a todo

With two sample todos, navigate to a row's delete control using the keyboard. Check where focus ends up after deleting the first row and after deleting the last remaining row. Recommend an appropriate focus target if needed.

# Make accidental todo deletion recoverable

Add and delete a sample todo. Check what feedback or recovery exists today, then outline a small undo option and what it would mean for the current in-memory API. Investigate only; do not implement.

# Give the empty todo list a clear first action

Open the app with an empty list. Check what guidance is visible today and recommend whether a short empty-state message would help someone add their first todo.

# Organise todos into lists

## What
I have work and personal todos mixed together. I'd like to group them into lists (like "Work", "Groceries") and switch between them.

Not sure yet how this should interact with the filters, the remaining count or the dark mode, or what happens to existing todos.

# Undo for everything

## What
Every action in the app (add, complete, edit, delete, reorder) should be undoable with Ctrl+Z, and redoable with Ctrl+Shift+Z.
