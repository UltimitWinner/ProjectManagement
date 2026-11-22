# MyPlan

MyPlan is a local-first project and coursework manager built with Hono, Cloudflare Workers, and Cloudflare D1. It includes nested folders, weighted grade tracking, task dependencies, and folder, board, list, and Gantt views.

## Highlights

- Authentication and project-specific view/edit permissions.
- Nested folders with optional grade weights and custom colors.
- Current, maximum possible, and minimum possible grade calculations.
- Folder, board, list, and Gantt views, including task reordering.
- Task import/export using MyPlan JSON backups and CSV profiles for Microsoft Planner, monday.com, and ClickUp.
- BYU Learning Suite and Canvas saved-page imports using HTML files.
- Gantt SVG export, project calendars, adjustable dates and scale, and task start/due times.
- Custom fields, multiple sort keys, and a saved light/dark appearance preference.

## Local setup

Requirements: Node.js 18 or newer and npm.

1. Clone the repository and install dependencies:

   ```bash
   git clone https://github.com/UltimitWinner/ProjectManagement.git
   cd ProjectManagement
   npm install
   ```

2. Copy `.dev.vars.example` to `.dev.vars` and set a unique `APP_PEPPER` of at least 32 characters, a bootstrap username, and a password of at least 12 characters. `.dev.vars` is ignored by Git. Keep `APP_PEPPER` unchanged after account creation because password verification and encrypted Canvas tokens depend on it. `CANVAS_ALLOWED_HOSTS` is optional and only needed for a custom Canvas hostname that is not a standard Instructure or education domain.

3. Start the local development server:

   ```bash
   npm run dev
   ```

4. Open [http://127.0.0.1:8787](http://127.0.0.1:8787).

## Tests

Run the unit tests with `npm test`. The suite uses Node's built-in test runner.

## Data storage

Project and task data are stored in Cloudflare D1. Schema changes are in `migrations/` and should be applied in order. MyPlan JSON exports preserve the app's folder structure, task data, custom field definitions, and dependencies. CSV profiles support spreadsheet transfer; they do not directly connect to external services.

## Cloudflare deployment

1. Log in with Wrangler: `npx wrangler login`.
2. Create a D1 database: `npx wrangler d1 create pm_db`.
3. Put the returned database ID in `wrangler.toml` and configure `APP_PEPPER`, `BOOTSTRAP_USERNAME`, `BOOTSTRAP_PASSWORD`, and `BOOTSTRAP_NAME` as Worker secrets or variables.
4. Apply migrations and deploy:

   ```bash
   npx wrangler d1 migrations apply pm_db --remote
   npx wrangler deploy
   ```

Do not use `.dev.vars` for production secrets.

## Canvas LMS import

Canvas API token imports are temporarily disabled because the current Canvas instance denied access to the current-user API with HTTP 403. No Canvas developer key or token configuration is needed for HTML imports.

To import a saved Canvas page, open **Import tasks**, choose **Auto-detect** or **Canvas saved Assignments page (HTML)**, save a course's Assignments page using your browser's Save Page command, and select the saved `.html` or `.htm` file. In Auto-detect mode, MyPlan checks the page structure and selects the Canvas or Learning Suite parser. It parses the static table locally without executing page scripts or uploading the file. It imports assignment names, any visible groups/categories, due dates, points, and scores if the page includes a score column. Static pages do not provide hidden scores, category weights, or drop rules. For more course detail, API access will need to be enabled by the Canvas administrator before token imports can be re-enabled.

MyPlan also supports downloaded BYU Learning Suite Assignments pages as HTML.

## License

ISC
