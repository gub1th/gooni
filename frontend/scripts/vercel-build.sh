#!/usr/bin/env bash
# Vercel build wrapper — re-exports the platform's auto-injected VERCEL_*
# env vars under VITE_-prefixed names so Vite bundles them into the client.
# Without this prefix, import.meta.env can't see them. Keeps vercel.json's
# buildCommand under the 256-char schema limit (the inline form blew it).
set -e

export VITE_VERCEL_URL="${VERCEL_URL:-}"
export VITE_VERCEL_PROJECT_PRODUCTION_URL="${VERCEL_PROJECT_PRODUCTION_URL:-}"
export VITE_VERCEL_GIT_COMMIT_SHA="${VERCEL_GIT_COMMIT_SHA:-}"
export VITE_VERCEL_GIT_COMMIT_REF="${VERCEL_GIT_COMMIT_REF:-}"
export VITE_VERCEL_DEPLOYMENT_ID="${VERCEL_DEPLOYMENT_ID:-}"
export VITE_VERCEL_ENV="${VERCEL_ENV:-}"

npm run build
