const listEl = document.getElementById("todo-list");
const summaryEl = document.getElementById("summary");
const form = document.getElementById("add-form");
const input = document.getElementById("new-title");

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return res.status === 204 ? null : res.json();
}

async function refresh() {
  const todos = await api("/api/todos");
  listEl.replaceChildren(
    ...todos.map((todo) => {
      const li = document.createElement("li");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = todo.done;
      checkbox.addEventListener("change", async () => {
        await api(`/api/todos/${todo.id}`, {
          method: "PATCH",
          body: JSON.stringify({ done: checkbox.checked }),
        });
        refresh();
      });
      const label = document.createElement("span");
      label.textContent = todo.title;
      if (todo.done) label.className = "done";
      const remove = document.createElement("button");
      remove.textContent = "Delete";
      remove.addEventListener("click", async () => {
        await api(`/api/todos/${todo.id}`, { method: "DELETE" });
        refresh();
      });
      li.append(checkbox, label, remove);
      return li;
    }),
  );
  summaryEl.textContent = summaryText(todos);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = input.value.trim();
  if (!title) return;
  await api("/api/todos", { method: "POST", body: JSON.stringify({ title }) });
  input.value = "";
  refresh();
});

refresh();
