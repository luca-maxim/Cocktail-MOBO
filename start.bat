@echo off
echo ============================================
echo  Cocktail MOBO Optimizer - Starting server
echo ============================================
echo.

cd /d "%~dp0backend"

:: Check for Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python not found. Please install Python 3.10+
    pause
    exit /b 1
)

:: Install dependencies
echo Installing dependencies...
pip install -r requirements.txt --quiet

echo.
echo Starting FastAPI server on http://localhost:8000
echo Open your browser to http://localhost:8000
echo Press Ctrl+C to stop.
echo.

python main.py
pause
