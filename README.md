# Teamflow

## Run locally

1. Install Node.js 22.13 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set `SESSION_SECRET` to a random secret at least 32 characters long.
4. Run `npm start`.
5. Open <http://localhost:3000>. Register an account to access the workspace.

The backend uses Express and Node's built-in SQLite support. It creates `data/teamflow.sqlite` and initializes it from `backend/schema.sql` on first start. Account passwords are hashed, sessions and workspace data are stored in SQLite, and the `.env` and database directory are excluded by `.gitignore`.

The initial workspace is seeded with sample project and task data for each new account. This is a local learning project; configure HTTPS, backups, and production-grade operational controls before deploying it publicly.
