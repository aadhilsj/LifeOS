# LifeOS — Personal Operating System

A personal dashboard for tasks, projects, habits, job tracking, and weekly reviews.
Syncs across devices via Supabase. AI weekly review via Anthropic API.

## Stack
- Pure HTML/CSS/JS — no framework
- Vercel — hosting + serverless function for AI review
- Supabase — cross-device data sync
- Anthropic API — weekly review generation

## Deploy to Vercel

### 1. Upload this folder to GitHub
- Create a new repo on github.com
- Upload all files in this folder

### 2. Connect to Vercel
- Go to vercel.com → Add New Project → import your GitHub repo
- No framework settings needed — Vercel auto-detects static HTML
- Click Deploy

### 3. Add environment variable in Vercel
- Project → Settings → Environment Variables
- Add: ANTHROPIC_API_KEY = your key from console.anthropic.com
- Go to Deployments → Redeploy

The Supabase credentials are already embedded in the HTML.
The ANTHROPIC_API_KEY must stay server-side (in Vercel env vars) for security.

## Updating the app
Replace index.html with the new version, commit to GitHub — Vercel auto-deploys.
