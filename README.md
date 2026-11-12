# Introduction
CPU is an interior designer platform, a web application built to connect clients with interior designers. Whether you are looking to transform a single room or manage a full-scale renovation, this platform provides a centralized space for browsing design portfolios, scheduling consultations, and managing projects from concept to completion.   


## Key Features

Portfolio Exploration: Customers can easily search and browse interior designer portfolios by project title or keywords to find the right style for their space.

Appointment Scheduling: Booking and management system allowing designers to view, accept, decline, or reschedule customer consultations.

Direct Messaging: Customers can message the interior designers that they wish to work on our website  without the hassle of calls and emails.

Project Management: Interior designers can showcase their work by adding new projects complete with photo uploads, budgets, and timelines.   



## Project structure

```text
.
├── index.html                      # App shell: header, nav, <main>, messages button, script tags
├── style.css                       # Global styles for the whole app
├── config.js                       # Supabase URL and publishable (anon) key
├── app.js                          # Entry point (ES module): auth, routing, page rendering, UI event handling
│
├── category.js                     # Category management (see below)
├── company.js                      # CompanyController: designer company profile and logo/cover uploads
├── project.js                      # ProjectController: project create, edit, drafts, image upload
├── designer.js                     # DesignerPortfolioController: designer profile, company and projects
├── favorite.js                     # FavoritesController: customer favourites
│
├── schema.sql                      # Tables, RLS policies, triggers, storage bucket, migrations
│
├── supabase/
│   └── functions/
│       └── admin-users/
│           └── index.ts            # Edge Function for privileged account management
│
├── package.json                    # Dev dependencies and the `npm test` script (Jest)
├── package-lock.json               # Locked dependency versions
└── README.md
```

### Key files

| File | Purpose |
| --- | --- |
| `index.html` | Static page shell. It loads the controller scripts as classic scripts, then loads `app.js` as an ES module. |
| `app.js` | Main application logic. It creates the Supabase client, handles login and registration, renders each role's pages, and connects the UI to the controllers. |
| `config.js` | Holds `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Only the publishable/anon key belongs here, never the `service_role` key. |
| `schema.sql` | Single source of truth for the database. It also contains repeatable migration blocks at the bottom (see [Create the database schema](#2-create-the-database-schema)). |
| `supabase/functions/admin-users/` | Server-side function for User Admin account tools and self-service account deletion. Redeploy it after any change. |

### Controllers

The controller files (`category.js`, `company.js`, `project.js`, `designer.js`, `favorite.js`) are environments separated from the main app.js, they are there for our TDD testing.

- Each is wrapped in a UMD-style closure, so it works as a browser global (loaded with `<script>` in `index.html`) and as a CommonJS module (`require(...)` in Jest tests).
- Each takes a Supabase client (`db`) in its constructor, so tests can pass in a mock client.
- Each throws on Supabase errors, so callers handle failures with `try/catch`.

| File | Exports | Responsibility |
| --- | --- | --- |
| `category.js` | `CategoryController` (default export), plus `ProjectCategory`, `CreateCategoryController`, `DeleteCategoryController`, `CreateCategoryUI`, `DeleteCategoryUI` | Listing categories with project and view stats, creating and updating categories, usage checks, and safe delete or reassignment through the `platform_category_usage` and `platform_move_and_delete_category` database functions. |
| `company.js` | `CompanyController` | Loading and saving a designer's company information, uploading and replacing logo and cover images, and cleaning up orphaned uploads. |
| `project.js` | `ProjectController` | Creating projects, loading a project together with its saved draft, saving drafts to `project_drafts`, applying changes, and replacing project images. |
| `designer.js` | `DesignerPortfolioController` | Loading a designer's profile, company and projects for the portfolio page. |
| `favorite.js` | `FavoritesController` | Listing, adding and removing a customer's favourite projects. |

### Running tests

Tests use [Jest](https://jestjs.io/) (with `supertest` available for HTTP-style tests):

```powershell
npm install
npm test
```

