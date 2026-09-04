// Local prototype interactions only; every figure is illustrative.
const switchers = [...document.querySelectorAll(".switcher")]
const themeButton = document.querySelector("[data-theme-toggle]")

themeButton.addEventListener("click", () => {
  const dark = document.documentElement.classList.toggle("dark")
  themeButton.textContent = dark ? "Light mode" : "Dark mode"
})

for (const switcher of switchers) {
  const search = switcher.querySelector("input")
  const rows = [...switcher.querySelectorAll(".repo-option")]
  const filter = () => {
    const query = search.value.trim().toLowerCase()
    for (const row of rows) {
      row.hidden = !`${row.dataset.owner}/${row.dataset.name}`.toLowerCase().includes(query)
    }
    for (const group of switcher.querySelectorAll(".owner-group")) {
      group.hidden = [...group.querySelectorAll(".repo-option")].every((row) => row.hidden)
    }
    switcher.querySelector(".empty-results").hidden = rows.some((row) => !row.hidden)
  }
  search.addEventListener("input", filter)
  switcher.addEventListener("toggle", () => {
    if (!switcher.open) {
      search.value = ""
      filter()
    }
  })
  switcher.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      switcher.open = false
      switcher.querySelector("summary").focus()
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const visible = rows.filter((row) => !row.hidden)
      const index = visible.indexOf(document.activeElement)
      const next =
        index === -1
          ? event.key === "ArrowDown"
            ? 0
            : visible.length - 1
          : event.key === "ArrowDown"
            ? index + 1
            : index - 1
      visible[(next + visible.length) % visible.length]?.focus()
    }
  })
  for (const row of rows) {
    row.addEventListener("click", () => {
      for (const sample of switchers) {
        const trigger = sample.querySelector("summary")
        trigger.setAttribute(
          "aria-label",
          `Switch repository: ${row.dataset.owner}/${row.dataset.name}, ${row.dataset.active === "true" ? "Active" : "Inactive"}`,
        )
        trigger.querySelector(".repo-name").textContent = row.dataset.name
        trigger.querySelector(".repo-owner").textContent = row.dataset.owner
        trigger.querySelector(".repo-owner").title = row.dataset.owner
        trigger.querySelector(".repo-name").title = row.dataset.name
        trigger.querySelector(".repo-avatar").textContent = row.dataset.initials
        trigger.querySelector(".repo-avatar").className = `repo-avatar ${row.dataset.tone}`
        const state = trigger.querySelector(".repo-state")
        state.textContent = row.dataset.active === "true" ? "Active" : "Inactive"
        state.classList.toggle("is-active", row.dataset.active === "true")
        for (const option of sample.querySelectorAll(".repo-option")) {
          if (option.dataset.id === row.dataset.id) option.setAttribute("aria-current", "true")
          else option.removeAttribute("aria-current")
        }
      }
      switcher.open = false
      switcher.querySelector("summary").focus()
    })
  }
}
