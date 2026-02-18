"""
Cocktail Multi-Objective Bayesian Optimization using BoTorch.

Optimization flow:
  - Phase 1: 15 Sobol quasi-random samples
  - Phase 2: 10 qNEHVI (Noisy Expected Hypervolume Improvement) iterations

Each objective can be individually set to "max" (higher = better) or "min"
(lower = better). Internally BoTorch always maximizes; minimize objectives are
negated before any BoTorch call and restored before returning to the frontend.
Ingredients are represented as values in [0, 1] (displayed as 0-100 ml).
"""

import torch
import numpy as np
from botorch.models import ModelListGP, SingleTaskGP
from botorch.models.transforms.outcome import Standardize
from botorch.fit import fit_gpytorch_mll
from botorch.utils.multi_objective.pareto import is_non_dominated
from botorch.utils.sampling import draw_sobol_samples
from botorch.acquisition.multi_objective.monte_carlo import (
    qNoisyExpectedHypervolumeImprovement,
)
from botorch.sampling.normal import SobolQMCNormalSampler
from botorch.optim import optimize_acqf
from gpytorch.mlls import SumMarginalLogLikelihood


def _build_model(train_X: torch.Tensor, train_Y: torch.Tensor) -> ModelListGP:
    """Build a ModelListGP — one SingleTaskGP per objective."""
    models = []
    for i in range(train_Y.shape[-1]):
        y = train_Y[..., i : i + 1]
        models.append(
            SingleTaskGP(train_X, y, outcome_transform=Standardize(m=1))
        )
    return ModelListGP(*models)


class CocktailOptimizer:
    """
    Stateful optimizer for one cocktail-tuning session.

    Parameters
    ----------
    ingredients : list[str]
        Names of the cocktail ingredients.
    objective_names : list[str]
        Names of the three objectives (must be exactly 3).
    objective_directions : list[str]
        Direction for each objective: "max" (higher = better) or "min"
        (lower = better). Defaults to all "max".
    n_sobol : int
        Number of initial Sobol samples (default 15).
    n_bo : int
        Number of Bayesian optimisation iterations (default 10).
    """

    N_OBJECTIVES = 3

    def __init__(
        self,
        ingredients: list,
        objective_names: list,
        objective_directions: list | None = None,
        n_sobol: int = 15,
        n_bo: int = 10,
    ):
        assert len(objective_names) == self.N_OBJECTIVES, (
            f"Exactly {self.N_OBJECTIVES} objectives are required."
        )
        assert len(ingredients) >= 1, "At least one ingredient is required."

        if objective_directions is None:
            objective_directions = ["max"] * self.N_OBJECTIVES
        assert len(objective_directions) == self.N_OBJECTIVES, (
            f"Exactly {self.N_OBJECTIVES} objective_directions are required."
        )
        for d in objective_directions:
            assert d in ("min", "max"), f"Direction must be 'min' or 'max', got {d!r}."

        self.ingredients = ingredients
        self.objective_names = objective_names
        self.objective_directions = objective_directions
        self.n_sobol = n_sobol
        self.n_bo = n_bo
        self.total_iterations = n_sobol + n_bo

        self.n_dim = len(ingredients)

        # Bounds: each ingredient in [0, 1]
        self.bounds = torch.stack(
            [torch.zeros(self.n_dim), torch.ones(self.n_dim)]
        ).double()

        # Accumulated training data
        self.train_X: torch.Tensor | None = None  # [n, d]
        self.train_Y: torch.Tensor | None = None  # [n, 3]

        # Currently pending (suggested but not yet evaluated) candidate
        self.pending_X: torch.Tensor | None = None

        # How many evaluations have been completed
        self.iteration: int = 0

        # Pre-generate all Sobol candidates upfront for reproducibility
        sobol = draw_sobol_samples(
            bounds=self.bounds, n=self.n_sobol, q=1, seed=42
        )  # [n_sobol, 1, d]
        self.sobol_samples = sobol.squeeze(1).double()  # [n_sobol, d]

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_next_suggestion(self) -> dict:
        """Return the next candidate ingredient amounts to try."""
        if self.iteration >= self.total_iterations:
            raise RuntimeError("Optimization is already complete.")

        if self.iteration < self.n_sobol:
            x = self.sobol_samples[self.iteration]
            phase = "sobol"
        else:
            x = self._mobo_suggest()
            phase = "bo"

        # ── SIMPLEX CONSTRAINT (total = 100 ml) ──────────────────────────
        # Comment out the two lines below to let every ingredient vary
        # independently in [0, 100] ml with no fixed total.
        s = x.sum()
        x = x / s if s > 0 else torch.full_like(x, 1.0 / self.n_dim)
        # ─────────────────────────────────────────────────────────────────

        self.pending_X = x.detach().clone()

        amounts = {
            ing: round(float(x[i]) * 100, 1)
            for i, ing in enumerate(self.ingredients)
        }

        return {
            "iteration": self.iteration + 1,
            "total_iterations": self.total_iterations,
            "phase": phase,
            "amounts": amounts,
        }

    def add_evaluation(self, ratings: list) -> dict:
        """
        Record user ratings for the pending suggestion.

        Parameters
        ----------
        ratings : list[float]
            Three Likert-scale scores (1–10), one per objective.

        Returns
        -------
        dict
            Full application state after adding the evaluation.
        """
        if self.pending_X is None:
            raise RuntimeError("No pending suggestion to evaluate.")
        if len(ratings) != self.N_OBJECTIVES:
            raise ValueError(
                f"Expected {self.N_OBJECTIVES} ratings, got {len(ratings)}."
            )
        for r in ratings:
            if not (1 <= r <= 10):
                raise ValueError(f"Rating {r} is out of range [1, 10].")

        x = self.pending_X.unsqueeze(0).double()  # [1, d]
        y = torch.tensor(ratings, dtype=torch.float64).unsqueeze(0)  # [1, 3]

        if self.train_X is None:
            self.train_X = x
            self.train_Y = y
        else:
            self.train_X = torch.cat([self.train_X, x], dim=0)
            self.train_Y = torch.cat([self.train_Y, y], dim=0)

        self.pending_X = None
        self.iteration += 1

        return self.get_state()

    def get_pareto_front(self) -> dict:
        """Compute and return current Pareto-front information."""
        if self.train_Y is None or len(self.train_Y) == 0:
            return {
                "pareto_mask": [],
                "avg_ingredients": {},
                "count": 0,
                "pareto_recipes": [],
            }

        Y = self.train_Y.double()
        mask = is_non_dominated(self._to_opt_space(Y))  # [n] bool tensor

        pareto_X = self.train_X[mask]
        pareto_Y = self.train_Y[mask]

        avg_X = pareto_X.mean(dim=0)
        avg_amounts = {
            ing: round(float(avg_X[i]) * 100, 1)
            for i, ing in enumerate(self.ingredients)
        }

        pareto_recipes = []
        for k in range(len(pareto_X)):
            pareto_recipes.append(
                {
                    "ingredients": {
                        ing: round(float(pareto_X[k][j]) * 100, 1)
                        for j, ing in enumerate(self.ingredients)
                    },
                    "ratings": {
                        obj: round(float(pareto_Y[k][m]), 1)
                        for m, obj in enumerate(self.objective_names)
                    },
                }
            )

        return {
            "pareto_mask": mask.tolist(),
            "avg_ingredients": avg_amounts,
            "count": int(mask.sum()),
            "pareto_recipes": pareto_recipes,
        }

    def get_history(self) -> list:
        """Return the full iteration history."""
        if self.train_X is None:
            return []

        pareto_info = self.get_pareto_front()
        pareto_mask = pareto_info["pareto_mask"]

        history = []
        for i in range(len(self.train_X)):
            history.append(
                {
                    "iteration": i + 1,
                    "phase": "sobol" if i < self.n_sobol else "bo",
                    "is_pareto": pareto_mask[i] if i < len(pareto_mask) else False,
                    "ingredients": {
                        ing: round(float(self.train_X[i][j]) * 100, 1)
                        for j, ing in enumerate(self.ingredients)
                    },
                    "ratings": {
                        obj: round(float(self.train_Y[i][k]), 1)
                        for k, obj in enumerate(self.objective_names)
                    },
                }
            )
        return history

    def get_state(self) -> dict:
        """Return full current state."""
        return {
            "iteration": self.iteration,
            "total_iterations": self.total_iterations,
            "phase": "sobol" if self.iteration < self.n_sobol else "bo",
            "is_complete": self.iteration >= self.total_iterations,
            "pareto_front": self.get_pareto_front(),
            "history": self.get_history(),
            "ingredients": self.ingredients,
            "objective_names": self.objective_names,
            "objective_directions": self.objective_directions,
        }

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _to_opt_space(self, Y: torch.Tensor) -> torch.Tensor:
        """Negate minimize-objective columns so BoTorch always maximizes."""
        Y_opt = Y.clone()
        for i, d in enumerate(self.objective_directions):
            if d == "min":
                Y_opt[:, i] = -Y_opt[:, i]
        return Y_opt

    def _mobo_suggest(self) -> torch.Tensor:
        """Use qNEHVI to suggest the next candidate."""
        X = self.train_X.double()
        Y = self._to_opt_space(self.train_Y.double())

        model = _build_model(X, Y)
        mll = SumMarginalLogLikelihood(model.likelihood, model)

        try:
            fit_gpytorch_mll(mll)
        except Exception:
            # If fitting fails (rare numerical issues), fall back to random
            return torch.rand(self.n_dim, dtype=torch.float64)

        # Reference point: slightly below the worst observed value per objective
        # (computed in opt-space so minimized objectives are already negated)
        ref_point = (Y.min(dim=0).values - 0.5).tolist()

        sampler = SobolQMCNormalSampler(sample_shape=torch.Size([128]))

        acqf = qNoisyExpectedHypervolumeImprovement(
            model=model,
            ref_point=ref_point,
            X_baseline=X,
            sampler=sampler,
            prune_baseline=True,
            cache_root=False,  # avoid memory issues with small n
        )

        # ── SIMPLEX CONSTRAINT (total = 100 ml) ──────────────────────────
        # Comment out the four lines below (simplex_constraint definition)
        # and remove equality_constraints=simplex_constraint from optimize_acqf
        # to let the BO explore each ingredient independently in [0, 1].
        simplex_constraint = [(
            torch.arange(self.n_dim, dtype=torch.long),
            torch.ones(self.n_dim, dtype=torch.double),
            1.0,
        )]
        # ─────────────────────────────────────────────────────────────────

        try:
            candidates, _ = optimize_acqf(
                acq_function=acqf,
                bounds=self.bounds,
                q=1,
                num_restarts=5,
                raw_samples=128,
                equality_constraints=simplex_constraint,  # remove this line too
            )
            return candidates.squeeze(0).detach()
        except Exception:
            # Fallback: uniform split across all ingredients
            return torch.full((self.n_dim,), 1.0 / self.n_dim, dtype=torch.float64)
