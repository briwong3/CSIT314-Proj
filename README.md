# CPU Interior Designer CSIT314 Project

A browser-based interior designer matching app using Supabase for authentication, database storage, row-level security, and an Edge Function for privileged account management.

## Requirements

- A Supabase project
- A modern browser
- Python 3 (for the simple local web server below)
- Supabase CLI (only needed to deploy the Edge Function)

## 1. Connect the app to Supabase

1. In the Supabase Dashboard, open your project and go to **Project Settings → API**.
2. Copy the **Project URL** and the **Publishable key** (or the legacy `anon` key).
3. Open [`config.js`](./config.js) and set:

   ```js
   export const SUPABASE_URL = 'https://YOUR_PROJECT_REF.supabase.co';
   export const SUPABASE_ANON_KEY = 'YOUR_PUBLISHABLE_OR_ANON_KEY';
   ```

   The publishable/anon key is intended for browser use. Never put the `service_role` key in `config.js`, browser code, or any file served to users. Database access must remain protected by the row-level security policies in `schema.sql`.

## 2. Create the database schema

1. In the Supabase Dashboard, open **SQL Editor** and create a new query.
2. Copy the contents of [`schema.sql`](./schema.sql) into the editor and run it.
3. Confirm the query completes successfully. DDL statements commonly report **Success. No rows returned**; that is expected.

The schema creates the app's profiles, companies, projects, categories, comments, notifications, feedback, messaging tables, policies, and triggers. It also sets up account email synchronization. The script seeds example categories; avoid running it repeatedly on a populated database because some initial table and seed statements are not intended as repeatable migrations.
The schema also creates the public `project-images` Storage bucket used when designers upload project photos.

The designer dashboard adds a repeatable migration block at the bottom of `schema.sql`, starting with **Designer dashboard profile, project workflow and view-history migration**. If the rest of the schema is already installed, run only that block in the Supabase SQL Editor to enable company profiles, project stages, project editing and draft records, workflow sharing, view history, 100-view project milestones, and structured appointment requests. The project editor stores draft edits in `project_drafts`, applies saved edits to `projects`, and supports replacing the existing single project image. New view history and milestone notices start when the migration is applied; they cannot reconstruct events from existing aggregate view counts.

The platform manager's category delete dialog uses the **Platform category reassignment and safe-delete migration** at the bottom of `schema.sql`. Run that section after the designer dashboard migration to enable usage checks and move projects and drafts to another category before deletion.

Customer favourites live in `public.favorites`, created by the **Customer favourites and shortlist-count migration** at the end of `schema.sql`. If the rest of the schema is already installed, run that repeatable section in the Supabase SQL Editor. Its row-level security policies restrict favourites to each active customer, and a trigger keeps project shortlist totals in sync. Customers can save published projects from Browse projects, project details, and designer portfolios, then view or remove them from Favourites.

Run the final **Realtime view analytics migration** section after the designer dashboard migration. It allows platform managers to read project view events and adds the `projects`, `project_activity`, `profiles`, `categories`, `companies`, and `feedback` tables to Supabase Realtime. Platform dashboards, reports, categories, designer verification, and feedback refresh from their database records. Designer portfolio and interest insights update as views are recorded. Historical daily view activity starts when the view-history migration is applied and cannot be inferred from older aggregate view counts. Verification documents are not collected by this app, so the platform queue does not show a placeholder documents action.

If the app reports **Bucket not found** while creating a project or uploading a company logo/cover, open the Supabase SQL Editor for the project configured in `config.js` and run the **Storage bucket used for project photos** section in `schema.sql`. This section is safe to run again. Then retry the upload.

### Create the first User Admin

1. Start the app and register a normal account.
2. In the Supabase SQL Editor, promote that account using its exact email:

   ```sql
   update public.profiles
   set role = 'admin'
   where email = 'your-admin-email@example.com';
   ```

3. Sign out and sign in again so the app loads the updated role.

Keep at least one active User Admin account. User Admins can manage accounts and profile definitions; Platform Management has separate platform-only pages and permissions.

## 3. Deploy the account-management Edge Function

The User Admin account tools and customer/designer self-service account deletion call the `admin-users` Edge Function. Deploy it after connecting the app to the project.

1. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) and sign in:

   ```powershell
   supabase login
   ```

2. From the repository root, link the local project. The project reference is the part before `.supabase.co` in the Project URL:

   ```powershell
   supabase link --project-ref YOUR_PROJECT_REF
   ```

3. In **Project Settings → API**, copy the `service_role` secret. Set it as an Edge Function secret; do not commit or share its value:

   ```powershell
   supabase secrets set SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_SECRET
   ```

   You can also set these secrets in the Supabase Dashboard under **Edge Functions → Secrets**. Supabase may already provide `SUPABASE_URL`; explicitly setting it here keeps the function configuration clear.

4. Deploy the function:

   ```powershell
   supabase functions deploy admin-users
   ```

The function source is [`supabase/functions/admin-users/index.ts`](./supabase/functions/admin-users/index.ts). Redeploy it whenever that file changes. It checks the caller's authenticated role before allowing privileged actions; the self-delete action is limited to the caller's own active customer or interior designer account.

## 4. Run the app locally

The app uses JavaScript modules, so open it through a local HTTP server rather than directly as a `file://` URL.

From the repository root in PowerShell:

```powershell
py -m http.server 8000
```

Then open <http://localhost:8000> in your browser. Stop the server with `Ctrl+C`.

Alternatively, open the repository in VS Code and use an HTTP-based static preview/Live Server extension.

## 5. Configure authentication

In Supabase Dashboard, open **Authentication → URL Configuration**:

- Add your local app URL to **Redirect URLs** (for example, `http://localhost:8000/**`).
- Set the **Site URL** to your deployed app URL when deploying the app.
- Configure email confirmation and SMTP/email templates according to your project needs.

Registration supports customer and interior designer accounts. Designer registration can create a company record. Create User Admin accounts through the initial SQL promotion or an existing User Admin's account-management tools; do not enable public admin registration.

## 6. Deploying the web app

This is a static site. Deploy `index.html`, `app.js`, and `config.js` together to any static web host that serves ES modules over HTTPS. Configure the deployed site URL and redirect URLs in Supabase Authentication settings.

Platform dashboards and reports use database-derived analytics rather than sample figures. View counts update through Supabase Realtime after the **Realtime view analytics migration** has been applied. Date-based charts show recorded events only; they do not fabricate dates for older project view totals.

## Troubleshooting

- **Could not find a table or column / schema cache error:** confirm `schema.sql` ran against the same Supabase project configured in `config.js`. After schema changes, refresh the Supabase API schema cache if needed.
- **Bucket not found when uploading a project image or company logo/cover:** run the **Storage bucket used for project photos** section in `schema.sql` in the SQL Editor for the Supabase project configured in `config.js`. Uploads require the `project-images` bucket.
- **Designer dashboard reports a missing column or table:** run the **Designer dashboard profile, project workflow and view-history migration** block at the bottom of `schema.sql` in the SQL Editor.
- **View analytics do not update live / platform reports cannot load view history:** run the final **Realtime view analytics migration** section in `schema.sql` after the designer dashboard migration, then reload the app.
- **Could not find `public.project_milestones` in the schema cache:** run the latest designer dashboard migration block at the bottom of `schema.sql` against the Supabase project configured in `config.js`. The block creates this table and requests a PostgREST schema-cache reload. If the error remains, verify the SQL completed successfully and run `notify pgrst, 'reload schema';` in the SQL Editor, then reload the app.
- **Favourites fail to load or save / the `public.favorites` table is missing:** run the **Customer favourites and shortlist-count migration** at the end of `schema.sql` in the SQL Editor for the project configured in `config.js`, then reload the app. If it still fails, verify the migration completed and refresh the PostgREST schema cache.
- **Project details show `permission denied for table comments`:** run the **Comments access permission migration** at the end of `schema.sql` in the SQL Editor for the project configured in `config.js`, then reload the app. Project details will still open if comment access is unavailable.
- **Appointments reports a missing table or permission error:** run the same designer dashboard migration block in the Supabase project configured in `config.js`. Appointment requests are stored in `public.appointment_requests` and protected by row-level security.
- **Login shows `permission denied for table profiles`:** run the latest designer-dashboard migration block at the bottom of `schema.sql` in the Supabase SQL Editor, then reload and sign in again. It grants the needed table access while keeping row-level security enabled.
- **Login says the app profile is missing:** run the latest designer-dashboard migration block at the bottom of `schema.sql`. It restores missing profiles from signup metadata; restored accounts receive the customer or designer role, while admin/platform roles must be reassigned by an administrator.
- **The signed-in header appears but the login form stays visible or the first page fails to load:** run the latest schema in the Supabase SQL Editor. Authenticated users need `SELECT` on `public.categories` as well as the `cat_read` row-level security policy. The app now displays the page-load error instead of silently leaving the login form visible.
- **Permission denied / row-level security error:** verify that the relevant policies in `schema.sql` were applied and that the signed-in account has the intended role.
- **Platform Manager sees `permission denied for table categories` when managing categories:** run the category grants in `schema.sql` in the SQL Editor for the project configured in `config.js`. Row-level security remains enabled, so the category policies still limit changes to Platform Managers. If category deletion reports that its usage checks are unavailable, also run the **Platform category reassignment and safe-delete migration** at the bottom of `schema.sql`, after the designer dashboard migration.
- **Category deletion says `Could not find the function public.platform_category_usage` in the schema cache:** run the complete **Platform category reassignment and safe-delete migration** section at the bottom of `schema.sql` in the SQL Editor for the same Supabase project configured in `config.js`. Confirm it succeeds, then run `notify pgrst, 'reload schema';` in the SQL Editor and reload the app.
- **Admin account actions fail:** confirm the `admin-users` function is deployed to the configured project and its `SUPABASE_SERVICE_ROLE_KEY` secret is set.
- **Email change remains pending:** the user may need to confirm the new address. Profile email is synchronized when Supabase Auth applies the email update.
- **JavaScript module/CORS error:** serve the app from `http://localhost` or a deployed HTTPS static host; don't open the HTML file directly.

## Important security notes

- The frontend publishable/anon key is not a secret. It must be paired with the database's RLS policies.
- Never expose the Supabase `service_role` secret in frontend code, `config.js`, or a public repository.
- Do not commit Supabase local state such as `supabase/.temp/`.
- Review RLS policies and function authorization before changing account or platform-management behavior.
