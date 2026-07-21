@echo off
REM ============================================
REM  Nova AI - Custom Chatbot launcher (Windows)
REM ============================================

cd /d "%~dp0backend"

IF NOT EXIST ".venv" (
    echo Creating virtual environment...
    python -m venv .venv
)

call .venv\Scripts\activate.bat

echo Installing dependencies...
pip install -q -r requirements.txt

IF NOT EXIST ".env" (
    echo.
    echo No .env found. Copying .env.example to .env ...
    copy .env.example .env
    echo.
    echo  IMPORTANT: Edit backend\.env and set your LITELLM_PROXY_URL and LITELLM_API_KEY
    echo.
)

echo Starting Nova AI on http://localhost:8000 ...
python main.py