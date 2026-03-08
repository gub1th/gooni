#!/bin/bash

echo "Starting backend and frontend..."

# Cleanup on exit
trap 'kill 0' SIGINT

# Start backend
source venv/bin/activate
echo "Starting FastAPI on port 8000..."
uvicorn app.main:app --reload &

# Start frontend
cd frontend
echo "Starting frontend..."
npm run dev &

# Wait for all background processes
wait
