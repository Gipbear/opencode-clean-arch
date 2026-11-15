const list = document.getElementById("list")

export function render(items) {
  console.log("render", items)
  list.replaceChildren(...items.map(toItem))
}

function toItem(item) {
  const li = document.createElement("li")
  li.textContent = `${item.name}: ${item.amount.toFixed(2)}`
  return li
}
