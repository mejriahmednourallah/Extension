#!/bin/bash
set -e

echo "Starting E-Reputation backend..."
cd backend

pip install -r requirements.txt -q
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
