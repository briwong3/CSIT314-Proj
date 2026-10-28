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

If the app reports **Bucket not found** while creating a project, open the Supabase SQL Editor for the project configured in `config.js` and run the **Storage bucket used for project photos** section at the bottom of `schema.sql`. This section is safe to run again. Then retry creating the project.

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

The daily, weekly, and monthly report pages currently display sample figures rather than database-derived analytics.

## Troubleshooting

- **Could not find a table or column / schema cache error:** confirm `schema.sql` ran against the same Supabase project configured in `config.js`. After schema changes, refresh the Supabase API schema cache if needed.
- **Bucket not found when creating a project:** run the **Storage bucket used for project photos** section at the bottom of `schema.sql` in the SQL Editor for the Supabase project configured in `config.js`. A selected project image cannot upload until the `project-images` bucket exists.
- **Permission denied / row-level security error:** verify that the relevant policies in `schema.sql` were applied and that the signed-in account has the intended role.
- **Admin account actions fail:** confirm the `admin-users` function is deployed to the configured project and its `SUPABASE_SERVICE_ROLE_KEY` secret is set.
- **Email change remains pending:** the user may need to confirm the new address. Profile email is synchronized when Supabase Auth applies the email update.
- **JavaScript module/CORS error:** serve the app from `http://localhost` or a deployed HTTPS static host; don't open the HTML file directly.

## Important security notes

- The frontend publishable/anon key is not a secret. It must be paired with the database's RLS policies.
- Never expose the Supabase `service_role` secret in frontend code, `config.js`, or a public repository.
- Do not commit Supabase local state such as `supabase/.temp/`.
- Review RLS policies and function authorization before changing account or platform-management behavior.
