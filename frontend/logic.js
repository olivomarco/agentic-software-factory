function remainingCount(todos) {
  return todos.filter((t) => !t.done).length;
}

function summaryText(todos) {
  const n = remainingCount(todos);
  return n === 1 ? "1 item left" : `${n} items left`;
}

if (typeof module !== "undefined") module.exports = { remainingCount, summaryText };
