/* ═══════════════════════════════════════════════════════════════
   Cocktail MOBO — Frontend Application
   Communicates with FastAPI backend (relative URLs for production)
═══════════════════════════════════════════════════════════════ */

"use strict";

const API_BASE = "";  // relative URLs — works on any host

// ─────────────────────────────────────────────────────────────
// Application state
// ─────────────────────────────────────────────────────────────
const state = {
  ingredients: [],          // string[]
  objectives: ["Sweetness", "Sourness", "Bitterness"],  // string[3]
  objectiveDirections: ["max", "max", "min"],         // "max"|"min" per objective
  nSobol: 15,
  nBo: 10,
  currentSuggestion: null,  // { iteration, phase, amounts }
  ratings: [null, null, null],
  history: [],
  paretoFront: null,
  step: "setup",            // "setup" | "optimize" | "complete"
};

// ─────────────────────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const url = API_BASE + path;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

const API = {
  createSession: (cfg) =>
    apiFetch("/api/session/create", { method: "POST", body: JSON.stringify(cfg) }),
  suggest: () => apiFetch("/api/suggest"),
  evaluate: (ratings) =>
    apiFetch("/api/evaluate", { method: "POST", body: JSON.stringify({ ratings }) }),
  reset: () => apiFetch("/api/reset", { method: "POST" }),
};

// ─────────────────────────────────────────────────────────────
// Step navigation
// ─────────────────────────────────────────────────────────────
function showStep(stepName) {
  document.querySelectorAll(".step").forEach((s) => s.classList.remove("active"));
  document.getElementById(`step-${stepName}`).classList.add("active");
  state.step = stepName;

  const resetBtn = document.getElementById("reset-btn");
  resetBtn.classList.toggle("hidden", stepName === "setup");

}

// ─────────────────────────────────────────────────────────────
// Toast / loading helpers
// ─────────────────────────────────────────────────────────────
let toastTimer = null;

function showToast(msg, type = "info") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${type} visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("visible");
  }, 3200);
}

function showLoading(show, msg = "Calculating next recipe…") {
  const el = document.getElementById("loading-overlay");
  document.getElementById("loading-msg").textContent = msg;
  el.classList.toggle("hidden", !show);
}

// ─────────────────────────────────────────────────────────────
// SETUP STEP
// ─────────────────────────────────────────────────────────────
function renderIngredientTags() {
  const container = document.getElementById("ingredient-tags");
  container.innerHTML = "";
  state.ingredients.forEach((ing, i) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.innerHTML = `${ing} <button class="btn-remove" onclick="removeIngredient(${i})" title="Remove">✕</button>`;
    container.appendChild(tag);
  });
}

function addIngredient() {
  const input = document.getElementById("ingredient-input");
  const name = input.value.trim();
  if (!name) return;
  if (state.ingredients.includes(name)) {
    showToast(`"${name}" already added`, "error");
    return;
  }
  state.ingredients.push(name);
  input.value = "";
  renderIngredientTags();
}

function removeIngredient(idx) {
  state.ingredients.splice(idx, 1);
  renderIngredientTags();
}

function setDir(n, dir, btn) {
  state.objectiveDirections[n - 1] = dir;
  btn.closest(".dir-toggle").querySelectorAll(".dir-btn")
     .forEach(b => b.classList.toggle("active", b === btn));
}

function updateStartBtn() {
  const nSobol = Math.max(1, parseInt(document.getElementById("n-sobol").value) || 15);
  const nBo    = Math.max(1, parseInt(document.getElementById("n-bo").value)    || 10);
  const total  = nSobol + nBo;
  document.getElementById("rounds-total").textContent = `Total: ${total} rounds`;
  document.getElementById("start-btn").textContent    = `Start Optimization (${total} rounds)`;
}

async function startOptimization() {
  // Validate ingredients
  if (state.ingredients.length < 2) {
    showToast("Add at least 2 ingredients first.", "error");
    return;
  }

  // Read objective names
  const objectives = [
    document.getElementById("obj1").value.trim(),
    document.getElementById("obj2").value.trim(),
    document.getElementById("obj3").value.trim(),
  ];
  if (objectives.some((o) => !o)) {
    showToast("Please name all 3 objectives.", "error");
    return;
  }

  state.objectives = objectives;

  // Read and validate round counts
  const nSobol = parseInt(document.getElementById("n-sobol").value);
  const nBo    = parseInt(document.getElementById("n-bo").value);
  if (!nSobol || nSobol < 1) {
    showToast("Exploration rounds must be at least 1.", "error");
    return;
  }
  if (!nBo || nBo < 1) {
    showToast("Optimization rounds must be at least 1.", "error");
    return;
  }
  state.nSobol = nSobol;
  state.nBo    = nBo;

  const startBtn = document.getElementById("start-btn");
  startBtn.disabled = true;

  showLoading(true, "Initialising optimiser…");

  try {
    await API.createSession({
      ingredients: state.ingredients,
      objective_names: state.objectives,
      objective_directions: state.objectiveDirections,
      n_sobol: state.nSobol,
      n_bo: state.nBo,
    });

    showStep("optimize");
    buildRatingInputs();
    updateProgress(0, state.nSobol + state.nBo);
    await loadNextSuggestion();
  } catch (err) {
    showToast(`Error: ${err.message}`, "error");
  } finally {
    showLoading(false);
    startBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
// OPTIMIZE STEP — suggestion display
// ─────────────────────────────────────────────────────────────
async function loadNextSuggestion() {
  showLoading(true, "Preparing next cocktail…");
  try {
    const suggestion = await API.suggest();
    state.currentSuggestion = suggestion;
    state.ratings = [null, null, null];
    displaySuggestion(suggestion);
    window.scrollTo({ top: 0, behavior: "smooth" });
    resetRatingButtons();
    updateProgress(suggestion.iteration - 1, suggestion.total_iterations);
    document.getElementById("submit-btn").disabled = false;
  } catch (err) {
    showToast(`Error: ${err.message}`, "error");
  } finally {
    showLoading(false);
  }
}

function displaySuggestion(suggestion) {
  const { iteration, total_iterations, phase, amounts } = suggestion;

  // Phase badge
  const badge = document.getElementById("phase-badge");
  badge.textContent = phase === "sobol" ? "Sobol Phase" : "MOBO Phase";
  badge.className = `phase-badge ${phase}`;

  // Iteration tag
  document.getElementById("iter-tag").textContent = `Round ${iteration}`;
  document.getElementById("progress-label").textContent =
    `Iteration ${iteration} / ${total_iterations}`;

  // Ingredient amounts
  renderAmounts("ingredient-amounts", amounts);
}

function renderAmounts(containerId, amounts) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  // [SIMPLEX ON]  Bar width = val directly (vals sum to 100 ml).
  // [SIMPLEX OFF] Replace `width:${val}%` with `width:${(val/maxVal)*100}%`
  //               and add: const maxVal = Math.max(...Object.values(amounts), 1);
  Object.entries(amounts).forEach(([ing, val]) => {
    const row = document.createElement("div");
    row.className = "amount-row";
    row.innerHTML = `
      <span class="amount-label" title="${ing}">${ing}</span>
      <div class="amount-bar-wrap">
        <div class="amount-bar" style="width:${val}%"></div>
      </div>
      <span class="amount-value">${val} ml</span>
    `;
    container.appendChild(row);
  });

  // [SIMPLEX ON]  Comment out the three lines below to hide the total.
  const totalRow = document.createElement("div");
  totalRow.className = "amount-total";
  totalRow.textContent = "Total: 100 ml";
  container.appendChild(totalRow);
}

// ─────────────────────────────────────────────────────────────
// OPTIMIZE STEP — rating inputs
// ─────────────────────────────────────────────────────────────
function buildRatingInputs() {
  const container = document.getElementById("rating-inputs");
  container.innerHTML = "";

  state.objectives.forEach((objName, objIdx) => {
    const block = document.createElement("div");
    block.className = "rating-block";

    const label = document.createElement("div");
    label.className = "obj-label";
    label.innerHTML = `<span>${objName}</span><span class="selected-val" id="val-${objIdx}">—</span>`;
    block.appendChild(label);

    const row = document.createElement("div");
    row.className = "likert";

    for (let v = 1; v <= 10; v++) {
      const btn = document.createElement("button");
      btn.className = "likert-btn";
      btn.textContent = v;
      btn.dataset.obj = objIdx;
      btn.dataset.val = v;
      btn.onclick = () => selectRating(objIdx, v);
      row.appendChild(btn);
    }
    block.appendChild(row);
    container.appendChild(block);
  });
}

function selectRating(objIdx, value) {
  state.ratings[objIdx] = value;

  // Update selected button
  document.querySelectorAll(`.likert-btn[data-obj="${objIdx}"]`).forEach((btn) => {
    btn.classList.toggle("selected", parseInt(btn.dataset.val) === value);
  });

  // Update label
  document.getElementById(`val-${objIdx}`).textContent = value;
}

function resetRatingButtons() {
  state.ratings = [null, null, null];
  document.querySelectorAll(".likert-btn").forEach((btn) => btn.classList.remove("selected"));
  state.objectives.forEach((_, i) => {
    const el = document.getElementById(`val-${i}`);
    if (el) el.textContent = "—";
  });
}

async function submitRating() {
  // Validate all rated
  if (state.ratings.some((r) => r === null)) {
    showToast("Please rate all 3 objectives before submitting.", "error");
    return;
  }

  const btn = document.getElementById("submit-btn");
  btn.disabled = true;

  showLoading(true, "Updating model…");

  try {
    const appState = await API.evaluate(state.ratings);

    state.history = appState.history;
    state.paretoFront = appState.pareto_front;

    updateProgress(appState.iteration, appState.total_iterations);
    renderHistoryTable("history-table", appState.history);
    renderParetoFront(appState.pareto_front);
    renderParetoChart(
      "pareto-chart-3d", "chart-pareto-badge",
      appState.history, state.objectives
    );

    document.getElementById("history-card").style.display = "block";

    if (appState.is_complete) {
      showComplete(appState);
    } else {
      await loadNextSuggestion();
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, "error");
    btn.disabled = false;
  } finally {
    showLoading(false);
  }
}

// ─────────────────────────────────────────────────────────────
// Progress bar
// ─────────────────────────────────────────────────────────────
function updateProgress(current, total) {
  const pct = total > 0 ? (current / total) * 100 : 0;
  document.getElementById("progress-bar").style.width = `${pct}%`;
  document.getElementById("progress-label").textContent =
    `Iteration ${current} / ${total}`;

  // Sobol/BO boundary marker
  const markerPct = total > 0 ? (state.nSobol / total) * 100 : 60;
  document.getElementById("progress-sobol-end").style.left = `${markerPct}%`;

  // Phase badge
  const isBO = current >= state.nSobol;
  const badge = document.getElementById("phase-badge");
  if (badge) {
    badge.textContent = isBO ? "MOBO Phase" : "Sobol Phase";
    badge.className = `phase-badge ${isBO ? "bo" : "sobol"}`;
  }
}

// ─────────────────────────────────────────────────────────────
// Pareto front display
// ─────────────────────────────────────────────────────────────
function renderParetoFront(pareto) {
  const card = document.getElementById("pareto-card");
  if (!pareto || pareto.count === 0) {
    card.style.display = "none";
    return;
  }

  card.style.display = "block";
  document.getElementById("pareto-count-badge").textContent =
    `${pareto.count} Pareto-optimal`;

  renderAmounts("pareto-amounts", pareto.avg_ingredients);
}

// ─────────────────────────────────────────────────────────────
// Pareto front 3-D scatter chart (Plotly.js)
// ─────────────────────────────────────────────────────────────
function renderParetoChart(containerId, badgeId, history, objectives) {
  if (typeof Plotly === "undefined") {
    console.warn("Plotly not available – chart skipped.");
    return;
  }
  if (!history || history.length < 1) return;

  const el = document.getElementById(containerId);
  if (!el) return;

  // ── Make the card visible BEFORE Plotly measures the element ──
  // Must use the specific card ID (el.closest() won't work while display:none).
  if (containerId === "pareto-chart-3d") {
    const chartCard = document.getElementById("pareto-chart-card");
    if (chartCard) chartCard.style.display = "block";
  }

  // ── Build traces and layout (done synchronously) ────────────
  const sobolPts  = history.filter(h => h.phase === "sobol" && !h.is_pareto);
  const moboPts   = history.filter(h => h.phase === "bo"    && !h.is_pareto);
  const paretoPts = history.filter(h => h.is_pareto);

  function hover(h) {
    const ratings = objectives.map(o => `${o}: <b>${h.ratings[o]}</b>`).join("<br>");
    const ings = Object.entries(h.ingredients).map(([k, v]) => `${k}: ${v} ml`).join("<br>");
    return `<b>Round ${h.iteration}</b> (${h.phase})<br>${ratings}<br>─<br>${ings}`;
  }

  const axStyle = (title, idx) => {
    const arrow = state.objectiveDirections[idx] === "min" ? " ↓" : " ↑";
    return {
      title: { text: title + arrow, font: { size: 12, color: "#8892a4" } },
      range: [0.5, 10.5],
      gridcolor: "#2a2a4a",
      zerolinecolor: "#2a2a4a",
      tickcolor: "#2a2a4a",
      tickfont: { color: "#8892a4", size: 10 },
      backgroundcolor: "rgba(15,15,26,0)",
    };
  };

  function makeTrace(pts, name, color, size, symbol, opacity, lineWidth) {
    return {
      type: "scatter3d",
      mode: "markers",
      name,
      x: pts.map(h => h.ratings[objectives[0]]),
      y: pts.map(h => h.ratings[objectives[1]]),
      z: pts.map(h => h.ratings[objectives[2]]),
      text: pts.map(hover),
      hovertemplate: "%{text}<extra></extra>",
      marker: {
        size,
        color,
        symbol,
        opacity,
        line: lineWidth > 0 ? { color: "#f59e0b", width: lineWidth } : undefined,
      },
    };
  }

  const traces = [
    makeTrace(sobolPts,  "Sobol",            "#38bdf8", 5,  "circle",  0.55, 0),
    makeTrace(moboPts,   "MOBO",             "#a78bfa", 5,  "circle",  0.55, 0),
    makeTrace(paretoPts, "★ Pareto-optimal", "#fbbf24", 11, "diamond", 1.0,  2),
  ].filter(t => t.x.length > 0);

  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#e2e8f0", family: "Inter, system-ui, sans-serif", size: 11 },
    scene: {
      bgcolor: "rgba(15,15,26,0)",
      xaxis: axStyle(objectives[0], 0),
      yaxis: axStyle(objectives[1], 1),
      zaxis: axStyle(objectives[2], 2),
      camera: { eye: { x: 1.5, y: 1.5, z: 1.0 } },
    },
    margin: { l: 20, r: 20, t: 20, b: 20 },
    legend: {
      x: 0.01, y: 0.98,
      font: { size: 11, color: "#e2e8f0" },
      bgcolor: "rgba(28,28,50,0.85)",
      bordercolor: "#2a2a4a",
      borderwidth: 1,
    },
    uirevision: containerId,   // preserves camera angle across updates
  };

  const config = {
    displaylogo: false,
    responsive: true,
    modeBarButtonsToRemove: ["resetCameraLastSave3d", "orbitRotation"],
  };

  // ── Defer the actual Plotly render by one animation frame ───
  // This ensures the browser has reflowed after display:none → display:block
  // before Plotly tries to measure the container dimensions.
  requestAnimationFrame(() => {
    Plotly.react(el, traces, layout, config).then(() => {
      // Scroll the chart into view the first time it appears
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    if (badgeId) {
      const badge = document.getElementById(badgeId);
      if (badge) badge.textContent = `${paretoPts.length} Pareto-optimal`;
    }
  });
}

// ─────────────────────────────────────────────────────────────
// History table
// ─────────────────────────────────────────────────────────────
function renderHistoryTable(tableId, history) {
  if (!history || history.length === 0) return;

  const sample = history[0];
  const ingredients = Object.keys(sample.ingredients);
  const objectives = Object.keys(sample.ratings);

  const thead = document.getElementById(
    tableId === "history-table" ? "history-thead" : "final-thead"
  );
  const tbody = document.getElementById(
    tableId === "history-table" ? "history-tbody" : "final-tbody"
  );

  // Header
  thead.innerHTML = "";
  const hr = document.createElement("tr");
  const objHeaders = objectives.map((o, i) => {
    const arrow = state.objectiveDirections[i] === "min" ? " ↓" : " ↑";
    return o + arrow;
  });
  ["#", "Phase", "Pareto", ...ingredients, ...objHeaders].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  });
  thead.appendChild(hr);

  // Body
  tbody.innerHTML = "";
  // Render in reverse order (newest first)
  [...history].reverse().forEach((row) => {
    const tr = document.createElement("tr");
    if (row.is_pareto) tr.classList.add("is-pareto");

    const cells = [
      row.iteration,
      `<span class="phase-chip ${row.phase}">${row.phase === "sobol" ? "Sobol" : "MOBO"}</span>`,
      row.is_pareto ? `<span class="pareto-star">★</span>Yes` : "No",
      ...ingredients.map((ing) => `${row.ingredients[ing]} ml`),
      ...objectives.map((obj) => row.ratings[obj]),
    ];

    cells.forEach((c) => {
      const td = document.createElement("td");
      td.innerHTML = String(c);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// ─────────────────────────────────────────────────────────────
// COMPLETE STEP
// ─────────────────────────────────────────────────────────────
function showComplete(appState) {
  const pareto = appState.pareto_front;
  const total  = state.nSobol + state.nBo;

  // Update dynamic text in completion screen
  const completeSub = document.getElementById("complete-sub");
  if (completeSub) completeSub.textContent = `All ${total} rounds finished. Here are your optimal recipes.`;
  const finalHint = document.getElementById("final-chart-hint");
  if (finalHint) finalHint.textContent = `Complete view of all ${total} tastings. Drag to rotate · Scroll to zoom.`;

  // Final Pareto average recipe
  renderAmounts("final-recipe", pareto.avg_ingredients);
  document.getElementById("final-pareto-count").textContent =
    `${pareto.count} Pareto-optimal`;

  // All individual Pareto recipes
  const listContainer = document.getElementById("final-pareto-list");
  listContainer.innerHTML = "";
  pareto.pareto_recipes.forEach((recipe, i) => {
    const item = document.createElement("div");
    item.className = "pareto-item";

    const amountsHtml = Object.entries(recipe.ingredients)
      .map(([ing, val]) => {
        const maxVal = Math.max(...Object.values(recipe.ingredients), 1);
        const pct = (val / maxVal) * 100;
        return `
          <div class="amount-row">
            <span class="amount-label" title="${ing}">${ing}</span>
            <div class="amount-bar-wrap"><div class="amount-bar" style="width:${pct}%"></div></div>
            <span class="amount-value">${val} ml</span>
          </div>`;
      })
      .join("");

    const ratingsHtml = Object.entries(recipe.ratings)
      .map(
        ([obj, val]) =>
          `<span class="rating-chip">${obj}: <strong>${val}</strong></span>`
      )
      .join("");

    item.innerHTML = `
      <h4>★ Pareto Recipe ${i + 1}</h4>
      <div class="amounts-grid">${amountsHtml}</div>
      <div class="ratings-row">${ratingsHtml}</div>
    `;
    listContainer.appendChild(item);
  });

  // Full table
  renderHistoryTable("final-table", appState.history);

  showStep("complete");

  // Render final chart after the DOM is shown (Plotly needs visible container)
  requestAnimationFrame(() => {
    renderParetoChart(
      "final-chart-3d", "final-chart-badge",
      appState.history, state.objectives
    );
  });

  showToast("Optimization complete! 🏆", "success");
}

// ─────────────────────────────────────────────────────────────
// Reset
// ─────────────────────────────────────────────────────────────
async function confirmReset() {
  if (!confirm("Reset the current session? All progress will be lost.")) return;

  try {
    await API.reset();
  } catch {}

  // Reset local state
  state.ingredients = [];
  state.objectives = ["Sweetness", "Sourness", "Bitterness"];
  state.objectiveDirections = ["max", "max", "min"];
  state.nSobol = 15;
  state.nBo    = 10;
  state.ratings = [null, null, null];
  state.currentSuggestion = null;
  state.history = [];
  state.paretoFront = null;

  // Reset UI
  renderIngredientTags();
  document.getElementById("obj1").value = "Sweetness";
  document.getElementById("obj2").value = "Strength";
  document.getElementById("obj3").value = "Balance";
  document.getElementById("n-sobol").value = 15;
  document.getElementById("n-bo").value    = 10;
  updateStartBtn();

  // Reset direction toggles to Max
  document.querySelectorAll(".dir-toggle").forEach(toggle => {
    toggle.querySelectorAll(".dir-btn").forEach((btn, i) => {
      btn.classList.toggle("active", i === 0);  // first button = Max
    });
  });

  document.getElementById("pareto-card").style.display = "none";
  document.getElementById("pareto-chart-card").style.display = "none";
  document.getElementById("history-card").style.display = "none";

  // Purge Plotly charts so they don't persist stale data
  if (typeof Plotly !== "undefined") {
    ["pareto-chart-3d", "final-chart-3d"].forEach(id => {
      const el = document.getElementById(id);
      if (el) Plotly.purge(el);
    });
  }

  showStep("setup");
  showToast("Session reset.", "info");
}

// ─────────────────────────────────────────────────────────────
// PWA service worker registration
// ─────────────────────────────────────────────────────────────
function registerSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("/service-worker.js")
      .catch(() => {/* ignore SW errors in development */});
  }
}

// ─────────────────────────────────────────────────────────────
// Initialise
// ─────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  registerSW();
  renderIngredientTags();
  updateStartBtn();

  // Allow pressing Enter in ingredient input
  document.getElementById("ingredient-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addIngredient();
  });
});
