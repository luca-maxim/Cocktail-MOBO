"""
FastAPI backend for the Cocktail MOBO Optimizer.

Endpoints
---------
POST /api/session/create   – initialise a new optimisation session
GET  /api/suggest          – get the next suggested ingredient amounts
POST /api/evaluate         – submit Likert ratings for the current suggestion
GET  /api/state            – get full current state (history + Pareto front)
POST /api/reset            – destroy the current session

Static files (the frontend PWA) are served from ../frontend/ at the root path.
"""

import os
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

from optimizer import CocktailOptimizer

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="Cocktail MOBO API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global session (single-user local app)
_optimizer: Optional[CocktailOptimizer] = None


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------


class SessionConfig(BaseModel):
    ingredients: List[str]
    objective_names: List[str]
    objective_directions: List[str] = ["max", "max", "max"]
    n_sobol: int = 15
    n_bo: int = 10

    @field_validator("ingredients")
    @classmethod
    def at_least_one_ingredient(cls, v):
        if len(v) < 1:
            raise ValueError("At least one ingredient is required.")
        # Strip whitespace and remove empty strings
        cleaned = [i.strip() for i in v if i.strip()]
        if not cleaned:
            raise ValueError("Ingredient names cannot be empty.")
        return cleaned

    @field_validator("objective_names")
    @classmethod
    def exactly_three_objectives(cls, v):
        if len(v) != 3:
            raise ValueError("Exactly 3 objective names are required.")
        cleaned = [o.strip() for o in v if o.strip()]
        if len(cleaned) != 3:
            raise ValueError("Objective names cannot be empty.")
        return cleaned

    @field_validator("objective_directions")
    @classmethod
    def valid_directions(cls, v):
        if len(v) != 3:
            raise ValueError("Exactly 3 objective_directions are required.")
        for d in v:
            if d not in ("min", "max"):
                raise ValueError(f"Direction must be 'min' or 'max', got {d!r}.")
        return v


class EvaluationRequest(BaseModel):
    ratings: List[float]

    @field_validator("ratings")
    @classmethod
    def valid_ratings(cls, v):
        if len(v) != 3:
            raise ValueError("Exactly 3 ratings are required.")
        for r in v:
            if not (1 <= r <= 10):
                raise ValueError(f"Rating {r} must be between 1 and 10.")
        return v


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _require_session() -> CocktailOptimizer:
    if _optimizer is None:
        raise HTTPException(
            status_code=400,
            detail="No active session. POST /api/session/create first.",
        )
    return _optimizer


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.post("/api/session/create")
async def create_session(config: SessionConfig):
    global _optimizer
    _optimizer = CocktailOptimizer(
        ingredients=config.ingredients,
        objective_names=config.objective_names,
        objective_directions=config.objective_directions,
        n_sobol=config.n_sobol,
        n_bo=config.n_bo,
    )
    return {
        "message": "Session created.",
        "ingredients": config.ingredients,
        "objective_names": config.objective_names,
        "objective_directions": config.objective_directions,
        "n_sobol": config.n_sobol,
        "n_bo": config.n_bo,
        "total_iterations": config.n_sobol + config.n_bo,
    }


@app.get("/api/suggest")
async def get_suggestion():
    opt = _require_session()
    if opt.iteration >= opt.total_iterations:
        raise HTTPException(
            status_code=400,
            detail="Optimization is complete. No more suggestions.",
        )
    try:
        suggestion = opt.get_next_suggestion()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return suggestion


@app.post("/api/evaluate")
async def evaluate(request: EvaluationRequest):
    opt = _require_session()
    if opt.pending_X is None:
        raise HTTPException(
            status_code=400,
            detail="No pending suggestion. Call GET /api/suggest first.",
        )
    try:
        state = opt.add_evaluation(request.ratings)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return state


@app.get("/api/state")
async def get_state():
    opt = _require_session()
    return opt.get_state()


@app.post("/api/reset")
async def reset():
    global _optimizer
    _optimizer = None
    return {"message": "Session reset."}


# ---------------------------------------------------------------------------
# Serve the frontend PWA (must be last – catches all remaining routes)
# ---------------------------------------------------------------------------

_frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(_frontend_dir):
    app.mount("/", StaticFiles(directory=_frontend_dir, html=True), name="frontend")

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
